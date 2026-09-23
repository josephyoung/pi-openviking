import { createHash } from 'node:crypto';
import { MemoryGovernanceBarrier, governanceCandidateText, sourceRevoked } from './governance.js';
import { sameOwner, checkedOwner, type GovernanceJob, type Owner, type Operation } from './types.js';
import type { GovernanceStateStore, GovernanceProgress } from './governance-coordinator.js';
import { checkedScope, checkedMemoryDocumentUri, memoryRoot } from './memory-reference.js';

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

export type WriterClassifier = (input: { selectedText: string; candidateText: string;
  scope: string | null }) => Promise<'target' | 'unrelated' | 'uncertain'>;

function occurrences(text: string, selected: string): number {
  return text.split(selected).length - 1;
}

/** Exact-text governance for an unambiguously selected document. */
export class MemorySelectiveService {
  constructor(private readonly store: GovernanceStateStore, private readonly transport: SelectiveTransport,
    private readonly drainWriter?: (operationId: string, jobId: string) => Promise<void>,
    private readonly classifyWriter?: WriterClassifier) {
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
    const initialState = await this.store.read();
    if (initialState.retirement) throw new Error('MEMORY_RETIRED');
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
    let targetContent: string | undefined;
    for (const current of uris) {
      const content = await this.transport.readMemory(current);
      matches += occurrences(content, selectedText);
      if (current === uri) targetContent = content;
    }
    if (matches !== 1 || !targetContent?.includes(selectedText)) {
      throw new Error(matches ? 'MEMORY_TARGET_AMBIGUOUS' : 'MEMORY_TARGET_NOT_FOUND');
    }
    // An exact phrase can be unique while the same fact survives in a title or
    // paraphrase. Require a broader owner-selected replacement before creating
    // a job when the remainder cannot be proven independent of the old fact.
    const remainder = targetContent.replace(selectedText, '').trim();
    const selectedEnd = [...selectedText.trim().replace(/[.,!?;:。！？；：]+$/u, '')].slice(-4).join('');
    if (remainder && [...selectedEnd].length === 4 && remainder.includes(selectedEnd)) {
      throw new Error('MEMORY_TARGET_AMBIGUOUS');
    }
    if (remainder && (await this.classifyWriter?.({ selectedText, candidateText: remainder,
      scope: this.transport.scope }) ?? 'uncertain') !== 'unrelated') {
      throw new Error('MEMORY_TARGET_AMBIGUOUS');
    }
    // OpenViking may merge independently selected facts into one document and
    // paraphrase their original text. A fact digest then identifies neither
    // document phrase. Revoke the whole source group only after the exact
    // phrase is unique and the rest of the document is proven unrelated.
    const matching = Object.values(initialState.operations).filter(operation =>
      operation.scope === this.transport.scope && operation.memoryUris?.includes(uri));
    const exactDigest = createHash('sha256').update(selectedText).digest('hex');
    const exact = matching.filter(operation => operation.factDigest === exactDigest);
    const verifiedCoalescedOperationIds = matching.length > 1 && exact.length !== 1
      ? matching.map(operation => operation.id).sort() : undefined;
    return new MemoryGovernanceBarrier(this.store).begin({ kind: input.kind, scope: this.transport.scope,
      memoryUri: uri, selectivePlan: { memoryUri: uri, selectedText, replacementText },
      verifiedCoalescedOperationIds });
  }

  /** An owner-reviewed exact phrase in a merged derivative. The original
   * selected phrase and this phrase are both removed before acknowledgement. */
  async resolveMergedWriter(jobId: string, operationId: string, exactText: string): Promise<void> {
    if (typeof exactText !== 'string' || !exactText.trim() || exactText.length > 16384) {
      throw new Error('INVALID_MEMORY_GOVERNANCE');
    }
    await this.store.withGovernanceLock(async () => {
      const state = await this.store.read();
      if (state.retirement) throw new Error('MEMORY_RETIRED');
      const job = state.governance?.jobs[jobId];
      const plan = job?.selectivePlan;
      const operation = state.operations[operationId];
      if (!job || job.phase !== 'applying' || job.scope !== this.transport.scope || !plan
        || job.writerClassifications?.[operationId] !== 'target'
        || !operation?.memoryUris?.includes(plan.memoryUri)
        || exactText.includes(plan.selectedText) || plan.selectedText.includes(exactText)
        || plan.replacementText && (exactText.includes(plan.replacementText)
          || plan.replacementText.includes(exactText))) {
        throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
      }
      const content = await this.transport.readMemory(plan.memoryUri);
      if (occurrences(content, exactText) !== 1) throw new Error('MEMORY_TARGET_AMBIGUOUS');
      await this.store.transact(current => {
        const live = current.governance?.jobs[jobId];
        if (!live || live.phase !== 'applying' || live.scope !== this.transport.scope
          || live.writerClassifications?.[operationId] !== 'target') throw new Error('MEMORY_GOVERNANCE_CONFLICT');
        live.mergedResolutions ??= {};
        const prior = live.mergedResolutions[operationId];
        if (prior && prior !== exactText) throw new Error('MEMORY_GOVERNANCE_CONFLICT');
        live.mergedResolutions[operationId] = exactText;
        delete live.errorCode;
      });
    });
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
            job = state.governance!.jobs[id];
            const operation = state.operations[operationId];
            if (job.operationIds.includes(operationId) || job.writerClassifications?.[operationId]
              || !operation?.payload || ['failed', 'blocked', 'blocked_by_pause'].includes(operation.phase)) continue;
            const candidateText = governanceCandidateText(operation.payload);
            const decision = await this.classifyWriter?.({ selectedText: job.selectivePlan!.selectedText,
              candidateText, scope: job.scope }) ?? 'uncertain';
            if (decision !== 'target' && decision !== 'unrelated') {
              await this.store.transact(current => {
                const live = current.governance?.jobs[id];
                if (live?.phase === 'draining') live.errorCode = 'MEMORY_GOVERNANCE_REVIEW_REQUIRED';
              }, signal);
              return { status: 'pending', errorCode: 'MEMORY_GOVERNANCE_REVIEW_REQUIRED' };
            }
            await new MemoryGovernanceBarrier(this.store).classifyWriter(id, operationId, decision);
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
          // A failed remote extraction may leave an unreported partial write.
          // Without a URI lineage, selective cleanup cannot prove that a
          // semantically matching derivative is gone. Keep suppression active
          // until the owner confirms whole-scope clear.
          state = await this.store.read(signal);
          job = state.governance!.jobs[id];
          if (job.writerOperationIds.some(operationId => {
            const operation = state.operations[operationId];
            return operation.phase === 'failed' && operation.errorCode === 'MEMORY_EXTRACTION_FAILED'
              && !operation.memoryUris?.length;
          })) {
            await this.store.transact(current => {
              const live = current.governance?.jobs[id];
              if (live?.phase === 'draining') live.errorCode = 'MEMORY_GOVERNANCE_CLEAR_REQUIRED';
            }, signal);
            return { status: 'pending', errorCode: 'MEMORY_GOVERNANCE_CLEAR_REQUIRED' };
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
        // One explicit save can extract several independent documents. Deleting
        // its source may remove all of them upstream, so classify and preserve
        // the unrelated documents before the first destructive request.
        if (!job.preservedDocuments) {
          const sourceUris = new Set(job.operationIds.flatMap(operationId =>
            state.operations[operationId].memoryUris ?? []));
          const preserved: Record<string, string> = {};
          let bytes = 0;
          for (const uri of sourceUris) {
            signal?.throwIfAborted();
            const content = await this.transport.readMemory(uri);
            if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 32768) {
              throw new Error('MEMORY_GOVERNANCE_REVIEW_REQUIRED');
            }
            let retain: string | undefined;
            if (uri === plan.memoryUri) {
              const revised = content.replaceAll(plan.selectedText, plan.replacementText);
              if (revised.trim()) retain = revised;
            } else if (!content.includes(plan.selectedText)) {
              const decision = await this.classifyWriter?.({ selectedText: plan.selectedText,
                candidateText: content, scope: job.scope }) ?? 'uncertain';
              if (decision === 'unrelated') retain = content;
              else if (decision !== 'target') throw new Error('MEMORY_GOVERNANCE_REVIEW_REQUIRED');
            }
            if (retain !== undefined) {
              bytes += Buffer.byteLength(retain, 'utf8');
              if (bytes > 1048576) throw new Error('MEMORY_GOVERNANCE_REVIEW_REQUIRED');
              preserved[uri] = retain;
            }
          }
          await this.store.transact(current => {
            const live = current.governance!.jobs[id];
            if (live.phase !== 'applying' || live.preservedDocuments) throw new Error('MEMORY_GOVERNANCE_CONFLICT');
            live.preservedDocuments = preserved;
          }, signal);
          state = await this.store.read(signal);
          job = state.governance!.jobs[id];
        }
        const preserved = new Map(Object.entries(job.preservedDocuments!));
        for (const operationId of job.operationIds) {
          signal?.throwIfAborted();
          await this.transport.removeSource(state.operations[operationId]);
        }
        for (const [uri, content] of preserved) {
          signal?.throwIfAborted();
          await this.transport.replaceMemory(uri, content);
        }
        // A classified old paraphrase may have produced a different document.
        // Delete that exclusive derivative; a shared derivative needs review.
        const documents = new Set(await this.#documents());
        const targetIds = job.operationIds;
        const scope = job.scope;
        const writerClassifications = job.writerClassifications ?? {};
        // A second accepted source can merge a paraphrase into the selected
        // document. Exact-text replacement cannot prove that paraphrase gone.
        for (const operationId of targetIds.filter(operationId => writerClassifications[operationId] === 'target'
          && state.operations[operationId].memoryUris?.includes(plan.memoryUri))) {
          const exactText = job.mergedResolutions?.[operationId];
          if (!exactText) throw new Error('MEMORY_GOVERNANCE_REVIEW_REQUIRED');
          const content = await this.transport.readMemory(plan.memoryUri);
          if (occurrences(content, exactText) > 1) throw new Error('MEMORY_TARGET_AMBIGUOUS');
          if (content.includes(exactText)) {
            const revised = content.replace(exactText, '');
            if (revised.trim()) await this.transport.replaceMemory(plan.memoryUri, revised);
            else await this.transport.removeMemory(plan.memoryUri);
          }
        }
        for (const uri of new Set(targetIds.flatMap(operationId => state.operations[operationId].memoryUris ?? []))) {
          if (uri === plan.memoryUri || preserved.has(uri) || !documents.has(uri)) continue;
          const content = await this.transport.readMemory(uri);
          if (content.includes(plan.selectedText)) continue;
          if (Object.values(state.operations).some(operation => !targetIds.includes(operation.id)
            && operation.scope === scope && operation.phase === 'ready' && operation.memoryUris?.includes(uri))) {
            throw new Error('MEMORY_GOVERNANCE_REVIEW_REQUIRED');
          }
          await this.transport.removeMemory(uri);
          documents.delete(uri);
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
        // A generated URI can itself contain the old fact. Relocate retained
        // documents to stable opaque names before releasing the barrier. Only
        // exclusive documents move; shared documents keep their other source.
        const relocated: Record<string, string> = {};
        for (const uri of preserved.keys()) {
          if (Object.values(state.operations).some(operation => !targetIds.includes(operation.id)
            && operation.phase === 'ready' && operation.memoryUris?.includes(uri))) continue;
          const digest = createHash('sha256').update(JSON.stringify([job.id, uri])).digest('hex');
          const destination = `${memoryRoot(this.store.owner, job.scope)}/preserved/${digest}.md`;
          const current = await this.transport.readMemory(uri);
          await this.transport.replaceMemory(destination, current);
          await this.transport.removeMemory(uri);
          relocated[uri] = destination;
        }
        const surviving = new Set(await this.#documents());
        await this.store.transact(current => {
          const live = current.governance!.jobs[id];
          if (live.phase !== 'applying') throw new Error('MEMORY_GOVERNANCE_CONFLICT');
          for (const operationId of live.operationIds) {
            const operation = current.operations[operationId];
            operation.phase = 'blocked'; operation.errorCode = 'MEMORY_SOURCE_REVOKED';
            // Keep the URI lineage for surviving shared documents and export.
            // The old source is marked revoked and its plaintext is erased.
            delete operation.payload;
            if (operation.memoryUris) operation.memoryUris = operation.memoryUris
              .map(uri => relocated[uri] ?? uri).filter(uri => surviving.has(uri));
            operation.updatedAt = new Date().toISOString();
          }
          for (const operationId of live.writerOperationIds) delete current.operations[operationId].payload;
          // A later correction can move a document that an earlier completed
          // job still names. Keep its revision and preserved-source lineage on
          // the surviving URI, otherwise state validation prevents recovery.
          for (const previous of Object.values(current.governance!.jobs)) {
            if (previous.id === id || previous.phase !== 'complete') continue;
            previous.memoryUris = previous.memoryUris.map(uri => relocated[uri] ?? uri)
              .filter(uri => surviving.has(uri));
            if (previous.preservedUris) {
              const retained = previous.preservedUris.map(uri => relocated[uri] ?? uri)
                .filter(uri => surviving.has(uri));
              if (retained.length) previous.preservedUris = retained;
              else delete previous.preservedUris;
            }
          }
          live.phase = 'complete'; live.completedAt = new Date().toISOString();
          const retained = [...preserved.keys()].filter(uri => uri !== plan.memoryUri)
            .map(uri => relocated[uri] ?? uri);
          if (retained.length) live.preservedUris = retained;
          const targetUri = relocated[plan.memoryUri] ?? plan.memoryUri;
          live.memoryUris = surviving.has(targetUri) ? [targetUri] : [];
          delete live.selectivePlan; delete live.mergedResolutions; delete live.preservedDocuments; delete live.errorCode;
        }, signal);
        return { status: 'complete' };
      } catch (error) {
        const code = error instanceof Error && error.message === 'MEMORY_GOVERNANCE_REVIEW_REQUIRED'
          ? error.message : 'MEMORY_GOVERNANCE_RETRY_REQUIRED';
        await this.store.transact(current => {
          const live = current.governance?.jobs[id];
          if (live && live.phase !== 'complete') live.errorCode = code;
        });
        return { status: 'pending', errorCode: code };
      }
    }, signal);
  }
}
