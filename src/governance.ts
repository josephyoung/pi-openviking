import { createHash, randomUUID } from 'node:crypto';
import type { GovernanceJob, Operation, OwnerState, StateStore } from './types.js';

const unsent = new Set(['queued', 'session_created', 'message_delivered']);
export function governancePending(state: OwnerState, scope: string | null): boolean {
  return Object.values(state.governance?.jobs ?? {}).some(job => job.scope === scope && job.phase !== 'complete');
}
export function governanceHoldsDelivery(state: OwnerState, operation: Operation): boolean {
  return unsent.has(operation.phase) && governancePending(state, operation.scope);
}
function sourceKey(state: OwnerState, scope: string | null, entryId: string): string {
  // Pi copies entry IDs to forks. Session, branch and rewritten source encoding
  // must not turn an old entry into a fresh authorization to collect it.
  return createHash('sha256').update(JSON.stringify([state.owner, scope, entryId])).digest('hex');
}
export function sourceRevoked(state: OwnerState, scope: string | null, entryId: string): boolean {
  const key = sourceKey(state, scope, entryId);
  return Object.values(state.governance?.jobs ?? {}).some(job => job.scope === scope && job.sourceKeys.includes(key));
}
export function operationRevoked(state: OwnerState, operation: Operation): boolean {
  return [operation.source, ...(operation.collectionSources ?? []), ...(operation.collectionEvidence ?? []).map(item => item.source)]
    .some(source => sourceRevoked(state, operation.scope, source.entryId));
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

  async begin(input: { kind: GovernanceJob['kind']; scope: string | null; memoryUri?: string }): Promise<GovernanceJob> {
    if (!input || !['forget', 'correct', 'clear'].includes(input.kind)
      || (input.scope !== null && (typeof input.scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.scope)))
      || (input.kind === 'clear' ? input.memoryUri !== undefined : typeof input.memoryUri !== 'string')) {
      throw new Error('INVALID_MEMORY_GOVERNANCE');
    }
    input = structuredClone(input);
    return this.store.transact(state => {
      if (input.kind === 'correct' && !state.authorization.enabled) throw new Error('MEMORY_DISABLED');
      if (governancePending(state, input.scope)) throw new Error('MEMORY_GOVERNANCE_PENDING');
      const scoped = Object.values(state.operations).filter(operation => operation.scope === input.scope);
      const operations = input.kind === 'clear' ? scoped : scoped.filter(operation => operation.memoryUris?.includes(input.memoryUri!));
      if (input.kind !== 'clear' && !operations.length) throw new Error('MEMORY_TARGET_NOT_FOUND');
      const entries = new Set(operations.flatMap(operation => [operation.source.entryId,
        ...(operation.collectionSources ?? []).map(source => source.entryId),
        ...(operation.collectionEvidence ?? []).map(item => item.source.entryId)]));
      const now = new Date().toISOString();
      for (const request of Object.values(state.collectionRequests ?? {})) {
        if (request.scope !== input.scope) continue;
        if (input.kind === 'clear') for (const entryId of request.sourceEntries) entries.add(entryId);
        if (['running', 'settled'].includes(request.phase)
          && (input.kind === 'clear' || request.sourceEntries.some(entryId => entries.has(entryId)))) {
          request.phase = 'discarded';
          delete request.selectionLease;
          request.updatedAt = now;
        }
      }
      state.governance ??= { revision: 0, jobs: {} };
      const job: GovernanceJob = { id: randomUUID(), revision: ++state.governance.revision,
        kind: input.kind, scope: input.scope, phase: 'draining', createdAt: now,
        memoryUris: input.kind === 'clear' ? [...new Set(operations.flatMap(operation => operation.memoryUris ?? []))] : [input.memoryUri!],
        operationIds: operations.map(operation => operation.id),
        writerOperationIds: scoped.map(operation => operation.id),
        sourceKeys: [...entries].map(entryId => sourceKey(state, input.scope, entryId)) };
      state.governance.jobs[job.id] = job;
      blockRevokedOperations(state);
      return structuredClone(job);
    });
  }
}
