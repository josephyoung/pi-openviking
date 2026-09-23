import { MemoryGovernanceBarrier, sourceRevoked } from './governance.js';
import { sameOwner, checkedOwner, type GovernanceJob, type Owner, type Operation } from './types.js';
import type { GovernanceStateStore, GovernanceProgress } from './governance-coordinator.js';
import { checkedScope, checkedMemoryDocumentUri } from './memory-reference.js';

export interface SelectiveTransport {
  readonly owner: Owner;
  readonly scope: string | null;
  writerSettled(operation: Readonly<Operation>): Promise<boolean>;
  removeSource(operation: Readonly<Operation>): Promise<void>;
  listMemoryDocuments(): Promise<string[]>;
  readMemory(uri: string): Promise<string>;
  replaceMemory(uri: string, content: string): Promise<void>;
  removeMemory(uri: string): Promise<void>;
}

function occurrences(text: string, selected: string): number {
  return text.split(selected).length - 1;
}

/** Exact-text governance for an unambiguously selected document. */
export class MemorySelectiveService {
  constructor(private readonly store: GovernanceStateStore, private readonly transport: SelectiveTransport,
    private readonly drainWriter?: (operationId: string, jobId: string) => Promise<void>) {
    checkedOwner(store.owner);
    if (!sameOwner(store.owner, transport.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    checkedScope(transport.scope);
  }

  #document(uri: unknown): string {
    return checkedMemoryDocumentUri(this.store.owner, this.transport.scope, uri);
  }

  async #documents(): Promise<string[]> {
    const uris = await this.transport.listMemoryDocuments();
    if (!Array.isArray(uris) || uris.some((uri, index) => this.#document(uri) !== uri || index > 0 && uri <= uris[index - 1])) {
      throw new Error('INVALID_MEMORY_RESPONSE');
    }
    return uris;
  }

  /** Resolve ambiguity before the durable barrier; the coordinator rechecks after draining. */
  async begin(input: { kind: 'forget' | 'correct'; memoryUri: string;
    selectedText: string; replacementText?: string }): Promise<GovernanceJob> {
    const uri = this.#document(input?.memoryUri);
    const selectedText = input?.selectedText;
    const replacementText = input?.kind === 'forget' ? '' : input?.replacementText;
    if (!['forget', 'correct'].includes(input?.kind)
      || typeof selectedText !== 'string' || !selectedText.trim() || selectedText.length > 16384
      || typeof replacementText !== 'string' || replacementText.length > 16384
      || (input.kind === 'correct' && (!replacementText.trim() || replacementText.includes(selectedText)))
      || (input.kind === 'forget' && input.replacementText !== undefined)) throw new Error('INVALID_MEMORY_GOVERNANCE');
    const uris = await this.#documents();
    if (!uris.includes(uri)) throw new Error('MEMORY_TARGET_NOT_FOUND');
    let matches = 0;
    for (const current of uris) matches += occurrences(await this.transport.readMemory(current), selectedText);
    if (matches !== 1 || !String(await this.transport.readMemory(uri)).includes(selectedText)) {
      throw new Error(matches ? 'MEMORY_TARGET_AMBIGUOUS' : 'MEMORY_TARGET_NOT_FOUND');
    }
    return new MemoryGovernanceBarrier(this.store).begin({ kind: input.kind, scope: this.transport.scope,
      memoryUri: uri, selectivePlan: { memoryUri: uri, selectedText, replacementText } });
  }

  async advance(id: string, signal?: AbortSignal): Promise<GovernanceProgress> {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_MEMORY_GOVERNANCE');
    return this.store.withGovernanceLock(async () => {
      let state = await this.store.read(signal);
      let job = state.governance?.jobs[id];
      if (!job || job.kind === 'clear' || job.scope !== this.transport.scope || !job.selectivePlan && job.phase !== 'complete') {
        throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
      }
      if (job.phase === 'complete') return { status: 'complete' };
      try {
        if (job.phase === 'draining') {
          const scope = job.scope;
          for (const requestId of job.collectionRequestIds ?? []) {
            signal?.throwIfAborted();
            state = await this.store.read(signal);
            const request = state.collectionRequests?.[requestId];
            if (!request || request.scope !== scope) throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
            if (request.phase === 'settled' && request.sourceEntries.some(entryId => sourceRevoked(state, scope, entryId))) {
              await this.store.transact(current => {
                const related = current.collectionRequests?.[requestId];
                if (related?.phase === 'settled') {
                  related.phase = 'discarded'; delete related.selectionLease;
                  related.updatedAt = new Date().toISOString();
                }
              }, signal);
              continue;
            }
            if (request.phase === 'running' || request.phase === 'settled') return { status: 'pending' };
          }
          state = await this.store.read(signal);
          job = state.governance!.jobs[id];
          for (const operationId of job.writerOperationIds) {
            signal?.throwIfAborted();
            state = await this.store.read(signal);
            const operation = state.operations[operationId];
            if (!operation || !sameOwner(operation.owner, this.transport.owner) || operation.scope !== job.scope) {
              throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
            }
            if (!['ready', 'failed', 'blocked', 'blocked_by_pause'].includes(operation.phase)) {
              if (!this.drainWriter) return { status: 'pending' };
              await this.drainWriter(operationId, id);
              state = await this.store.read(signal);
              if (!['ready', 'failed', 'blocked', 'blocked_by_pause'].includes(state.operations[operationId].phase)) {
                return { status: 'pending' };
              }
            }
            if (!await this.transport.writerSettled(state.operations[operationId])) return { status: 'pending' };
          }
          await this.store.transact(current => {
            const live = current.governance!.jobs[id];
            if (live.phase !== 'draining') throw new Error('MEMORY_GOVERNANCE_CONFLICT');
            live.phase = 'applying'; delete live.errorCode;
          }, signal);
        }
        state = await this.store.read(signal);
        job = state.governance!.jobs[id];
        const plan = job.selectivePlan!;
        for (const operationId of job.operationIds) {
          signal?.throwIfAborted();
          await this.transport.removeSource(state.operations[operationId]);
        }
        let targetConfirmed = job.kind === 'forget';
        for (const uri of await this.#documents()) {
          signal?.throwIfAborted();
          const content = await this.transport.readMemory(uri);
          if (typeof content !== 'string') throw new Error('INVALID_MEMORY_RESPONSE');
          const count = occurrences(content, plan.selectedText);
          if (count) {
            const revised = content.replaceAll(plan.selectedText, plan.replacementText);
            if (revised.trim()) await this.transport.replaceMemory(uri, revised);
            else await this.transport.removeMemory(uri);
          }
          if (uri === plan.memoryUri && job.kind === 'correct') {
            targetConfirmed = count > 0 || content.includes(plan.replacementText);
          }
        }
        if (!targetConfirmed) throw new Error('MEMORY_TARGET_CHANGED');
        for (const uri of await this.#documents()) {
          if ((await this.transport.readMemory(uri)).includes(plan.selectedText)) throw new Error('MEMORY_DELETION_UNCONFIRMED');
        }
        await this.store.transact(current => {
          const live = current.governance!.jobs[id];
          if (live.phase !== 'applying') throw new Error('MEMORY_GOVERNANCE_CONFLICT');
          for (const operationId of live.operationIds) {
            const operation = current.operations[operationId];
            operation.phase = 'blocked'; operation.errorCode = 'MEMORY_SOURCE_REVOKED';
            // Keep the URI lineage for surviving shared documents and export.
            // The old source is marked revoked and its plaintext is erased.
            delete operation.payload;
            operation.updatedAt = new Date().toISOString();
          }
          live.phase = 'complete'; live.completedAt = new Date().toISOString();
          delete live.selectivePlan; delete live.errorCode;
        }, signal);
        return { status: 'complete' };
      } catch {
        await this.store.transact(current => {
          const live = current.governance?.jobs[id];
          if (live && live.phase !== 'complete') live.errorCode = 'MEMORY_GOVERNANCE_RETRY_REQUIRED';
        });
        return { status: 'pending', errorCode: 'MEMORY_GOVERNANCE_RETRY_REQUIRED' };
      }
    }, signal);
  }
}
