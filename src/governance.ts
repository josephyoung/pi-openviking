import { createHash, randomUUID } from 'node:crypto';
import type { CollectionRequest, GovernanceJob, Operation, OwnerState, StateStore } from './types.js';

const unsent = new Set(['queued', 'session_created', 'message_delivered']);
export function governanceCandidateText(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && 'facts' in parsed && Array.isArray(parsed.facts)
      && parsed.facts.length === 1 && typeof parsed.facts[0] === 'string') return parsed.facts[0];
  } catch { /* Explicit save body is plain text. */ }
  return payload;
}
export function governancePending(state: OwnerState, scope: string | null): boolean {
  return Object.values(state.governance?.jobs ?? {}).some(job => job.scope === scope && job.phase !== 'complete');
}
export function governanceHoldsDelivery(state: OwnerState, operation: Operation): boolean {
  return unsent.has(operation.phase) && governancePending(state, operation.scope);
}
export function governanceCollectionJob(state: OwnerState, request: CollectionRequest): GovernanceJob | undefined {
  return Object.values(state.governance?.jobs ?? {}).find(job => job.phase === 'draining'
    && job.kind !== 'clear' && job.scope === request.scope && job.collectionRequestIds?.includes(request.id));
}
export function governanceHoldsCollection(state: OwnerState, request: CollectionRequest): boolean {
  return governancePending(state, request.scope) && !governanceCollectionJob(state, request);
}
function sourceKey(state: OwnerState, scope: string | null, entryId: string, factDigest?: string): string {
  // Pi copies entry IDs to forks. Session, branch and rewritten source encoding
  // must not turn an old entry into a fresh authorization to collect it.
  return createHash('sha256').update(JSON.stringify([state.owner, scope, entryId, factDigest ?? null])).digest('hex');
}
export function sourceRevoked(state: OwnerState, scope: string | null, entryId: string, factDigest?: string): boolean {
  const entryKey = sourceKey(state, scope, entryId);
  const factKey = factDigest === undefined ? undefined : sourceKey(state, scope, entryId, factDigest);
  return Object.values(state.governance?.jobs ?? {}).some(job => job.scope === scope
    && (job.sourceKeys.includes(entryKey) || factKey !== undefined && job.sourceKeys.includes(factKey)));
}
export function sourceReplayRevoked(state: OwnerState, scope: string | null, entryId: string): boolean {
  const key = sourceKey(state, scope, entryId);
  return Object.values(state.governance?.jobs ?? {}).some(job => job.scope === scope && job.phase === 'complete'
    && (job.sourceKeys.includes(key) || job.replaySourceKeys?.includes(key)));
}
export function operationRevoked(state: OwnerState, operation: Operation): boolean {
  return Object.values(state.governance?.jobs ?? {}).some(job => job.scope === operation.scope
    && job.operationIds.includes(operation.id)) || [operation.source, ...(operation.collectionSources ?? []),
    ...(operation.collectionEvidence ?? []).map(item => item.source)]
    .some(source => sourceRevoked(state, operation.scope, source.entryId, operation.factDigest));
}
export function blockRevokedOperations(state: OwnerState): void {
  for (const operation of Object.values(state.operations)) {
    if (unsent.has(operation.phase) && operationRevoked(state, operation)) {
      operation.phase = 'blocked';
      operation.errorCode = 'MEMORY_SOURCE_REVOKED';
      delete operation.payload;
      operation.updatedAt = new Date().toISOString();
    }
  }
}

/** Durable beginning of governance; no remote work or success acknowledgement.
 * Trusted host resolves an unambiguous document before calling this service.
 * Completion belongs to the coordinator that drains writers and verifies cleanup.
 */
export class MemoryGovernanceBarrier {
  constructor(private readonly store: StateStore) {}

  async begin(input: { kind: GovernanceJob['kind']; scope: string | null; memoryUri?: string;
    selectivePlan?: GovernanceJob['selectivePlan']; supersedePending?: boolean }): Promise<GovernanceJob> {
    if (!input || !['forget', 'correct', 'clear'].includes(input.kind)
      || (input.scope !== null && (typeof input.scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.scope)))
      || (input.kind === 'clear' ? input.memoryUri !== undefined || input.selectivePlan !== undefined : typeof input.memoryUri !== 'string')
      || (input.supersedePending !== undefined && (input.kind !== 'clear' || input.supersedePending !== true))
      || (input.selectivePlan !== undefined && (input.kind === 'clear'
        || input.selectivePlan.memoryUri !== input.memoryUri
        || typeof input.selectivePlan.selectedText !== 'string' || !input.selectivePlan.selectedText.trim()
        || input.selectivePlan.selectedText.length > 16384
        || typeof input.selectivePlan.replacementText !== 'string'
        || input.selectivePlan.replacementText.length > 16384
        || (input.kind === 'correct' && (!input.selectivePlan.replacementText.trim()
          || input.selectivePlan.replacementText.includes(input.selectivePlan.selectedText)))
        || (input.kind === 'forget' && input.selectivePlan.replacementText !== '')))) {
      throw new Error('INVALID_MEMORY_GOVERNANCE');
    }
    input = structuredClone(input);
    return this.store.transact(state => {
      if (state.retirement) throw new Error('MEMORY_RETIRED');
      if (input.kind === 'correct' && !state.authorization.enabled) throw new Error('MEMORY_DISABLED');
      const pending = Object.values(state.governance?.jobs ?? {}).find(job =>
        job.scope === input.scope && job.phase !== 'complete');
      if (pending) {
        if (!input.supersedePending) throw new Error('MEMORY_GOVERNANCE_PENDING');
        if (pending.kind === 'clear') return structuredClone(pending);
        pending.phase = 'complete'; pending.completedAt = new Date().toISOString();
        delete pending.selectivePlan; delete pending.mergedResolutions; delete pending.errorCode;
      }
      const scoped = Object.values(state.operations).filter(operation => operation.scope === input.scope);
      const matchingUri = input.kind === 'clear' ? [] : scoped.filter(operation => operation.memoryUris?.includes(input.memoryUri!));
      const exactSources = input.selectivePlan ? matchingUri.filter(operation =>
        operation.factDigest === createHash('sha256').update(input.selectivePlan!.selectedText).digest('hex')) : [];
      if (input.kind !== 'clear' && matchingUri.length > 1 && exactSources.length !== 1) {
        throw new Error('MEMORY_TARGET_AMBIGUOUS');
      }
      const targetIds = new Set((exactSources.length === 1 ? exactSources : matchingUri).map(operation => operation.id));
      const operations = input.kind === 'clear' ? scoped : scoped.filter(operation => targetIds.has(operation.id)
        || input.selectivePlan && operation.payload?.includes(input.selectivePlan.selectedText));
      if (input.kind !== 'clear' && !operations.length && !input.selectivePlan) throw new Error('MEMORY_TARGET_NOT_FOUND');
      const entries = new Set<string>();
      const replayEntries = new Set<string>();
      const revokedEntryIds = new Set<string>();
      for (const operation of input.kind === 'clear' ? scoped : operations) {
        for (const entryId of [operation.source.entryId, ...(operation.collectionSources ?? []).map(source => source.entryId),
          ...(operation.collectionEvidence ?? []).map(item => item.source.entryId)]) {
          entries.add(sourceKey(state, input.scope, entryId, input.kind === 'clear' ? undefined : operation.factDigest));
          if (input.kind !== 'clear') replayEntries.add(sourceKey(state, input.scope, entryId));
          if (input.kind === 'clear' || !operation.factDigest) revokedEntryIds.add(entryId);
        }
      }
      const now = new Date().toISOString();
      const collectionRequestIds: string[] = [];
      for (const request of Object.values(state.collectionRequests ?? {})) {
        if (request.scope !== input.scope) continue;
        if (input.kind === 'clear') for (const entryId of request.sourceEntries) {
          entries.add(sourceKey(state, input.scope, entryId)); revokedEntryIds.add(entryId);
        }
        if (['running', 'settled'].includes(request.phase)
          && (input.kind === 'clear' || request.sourceEntries.some(entryId => revokedEntryIds.has(entryId)))) {
          request.phase = 'discarded';
          delete request.selectionLease;
          request.updatedAt = now;
        } else if (input.kind !== 'clear' && ['running', 'settled'].includes(request.phase)) {
          collectionRequestIds.push(request.id);
        }
      }
      state.governance ??= { revision: 0, jobs: {} };
      const job: GovernanceJob = { id: randomUUID(), revision: ++state.governance.revision,
        kind: input.kind, scope: input.scope, phase: 'draining', createdAt: now,
        memoryUris: input.kind === 'clear' ? [...new Set(operations.flatMap(operation => operation.memoryUris ?? []))] : [input.memoryUri!],
        operationIds: operations.map(operation => operation.id),
        writerOperationIds: scoped.map(operation => operation.id),
        ...(collectionRequestIds.length ? { collectionRequestIds } : {}),
        sourceKeys: [...entries],
        ...(replayEntries.size ? { replaySourceKeys: [...replayEntries] } : {}),
        ...(input.selectivePlan ? { selectivePlan: input.selectivePlan } : {}) };
      state.governance.jobs[job.id] = job;
      if (pending) pending.supersededBy = job.id;
      blockRevokedOperations(state);
      return structuredClone(job);
    });
  }

  /** Resolve a pre-barrier fact while the target text is still available to the job. */
  async classifyWriter(jobId: string, operationId: string, decision: 'target' | 'unrelated'): Promise<void> {
    if (!['target', 'unrelated'].includes(decision)) throw new Error('INVALID_MEMORY_GOVERNANCE');
    await this.store.transact(state => {
      if (state.retirement) throw new Error('MEMORY_RETIRED');
      const job = state.governance?.jobs[jobId];
      const operation = state.operations[operationId];
      if (!job || job.kind === 'clear' || job.phase !== 'draining' || !job.selectivePlan
        || !job.writerOperationIds.includes(operationId) || !operation || operation.scope !== job.scope
        || job.operationIds.includes(operationId) && decision !== 'target') {
        throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
      }
      const prior = job.writerClassifications?.[operationId];
      if (prior && prior !== decision) throw new Error('MEMORY_GOVERNANCE_CONFLICT');
      job.writerClassifications ??= {};
      job.writerClassifications[operationId] = decision;
      delete job.errorCode;
      if (decision === 'target' && !job.operationIds.includes(operationId)) {
        job.operationIds.push(operationId);
        job.replaySourceKeys ??= [];
        for (const entryId of [operation.source.entryId, ...(operation.collectionSources ?? []).map(source => source.entryId),
          ...(operation.collectionEvidence ?? []).map(item => item.source.entryId)]) {
          const fact = sourceKey(state, job.scope, entryId, operation.factDigest);
          const replay = sourceKey(state, job.scope, entryId);
          if (!job.sourceKeys.includes(fact)) job.sourceKeys.push(fact);
          if (!job.replaySourceKeys.includes(replay)) job.replaySourceKeys.push(replay);
        }
        blockRevokedOperations(state);
      }
    });
  }
}
