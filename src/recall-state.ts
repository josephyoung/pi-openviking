import type { OwnerState } from './types.js';

/** A recall fence, not the store's transaction counter. No payloads are retained.
 * Collection bookkeeping and delivery polls cannot change searchable memory.
 * Commit/extraction transitions can, including reconciliation after a lost reply.
 * Governance jobs are retained after completion, so a full edit during a slow
 * recall still changes the fence even when no barrier remains pending.
 * This opaque token is NOT permission to recall: callers must separately reject
 * disabled/retired state and pending governance in their host-bound scope before
 * reading and before returning. Also retain owner/isolation, model and abort guards.
 * Compare tokens only within a request; do not persist them across plugin versions.
 */
export function memoryRecallStateKey(state: OwnerState, scope: string | null): string {
  const authorization = state.authorization;
  const governance = Object.values(state.governance?.jobs ?? {})
    .filter(job => job.scope === scope)
    .map(job => [job.id, job.revision, job.phase]).sort();
  const memories = Object.values(state.operations).filter(operation => operation.scope === scope)
    .flatMap(operation => {
      const phase = operation.reconciliationPhase ?? operation.phase;
      if (!['commit_unknown', 'processing', 'ready', 'failed'].includes(phase)
        && !operation.taskId && !operation.archiveId && !operation.memoryUris?.length) return [];
      return [[operation.id, phase, operation.taskId, operation.archiveId, operation.memoryUris]];
    }).sort();
  return JSON.stringify([state.owner, scope, authorization.enabled, authorization.epoch,
    authorization.effectiveAt, authorization.policyVersion, state.retirement, governance, memories]);
}
