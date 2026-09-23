import { sameOwner, checkedOwner, type Owner, type StateStore, type Operation } from './types.js';

export interface GovernanceStateStore extends StateStore {
  /** Kernel-backed exclusion shared by every cleaner of this owner. */
  withGovernanceLock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export interface GovernanceTransport {
  readonly owner: Owner;
  readonly scope: string | null;
  writerSettled(operation: Readonly<Operation>): Promise<boolean>;
  removeSource(operation: Readonly<Operation>): Promise<void>;
  clearMemoryScope(): Promise<void>;
}
export type GovernanceProgress = { status: 'complete' } | { status: 'pending'; errorCode?: string };

/** Executes the whole-scope clear path. Selective editing uses a separate plan. */
export class MemoryClearCoordinator {
  constructor(private readonly store: GovernanceStateStore, private readonly transport: GovernanceTransport) {
    checkedOwner(store.owner);
    if (!sameOwner(store.owner, transport.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    if (transport.scope !== null && (typeof transport.scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(transport.scope))) {
      throw new Error('INVALID_MEMORY_SCOPE');
    }
    if (typeof store.withGovernanceLock !== 'function') throw new Error('MEMORY_GOVERNANCE_LOCK_REQUIRED');
  }

  async advance(id: string, signal?: AbortSignal): Promise<GovernanceProgress> {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_MEMORY_GOVERNANCE');
    // Never release this lock on a timer while a remote mutation is in flight.
    return this.store.withGovernanceLock(async () => {
      let state = await this.store.read(signal);
      let job = state.governance?.jobs[id];
      if (!job || job.kind !== 'clear' || job.scope !== this.transport.scope) throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
      if (job.phase === 'complete') return { status: 'complete' };
      try {
        if (job.phase === 'draining') {
          for (const operationId of job.writerOperationIds) {
            signal?.throwIfAborted();
            // Re-read because ordinary delivery may have reconciled its receipt.
            state = await this.store.read(signal);
            const operation = state.operations[operationId];
            if (!operation || !sameOwner(operation.owner, this.transport.owner) || operation.scope !== job.scope) {
              throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
            }
            if (!await this.transport.writerSettled(operation)) return { status: 'pending' };
          }
          await this.store.transact(current => {
            const live = current.governance!.jobs[id];
            if (live.phase !== 'draining') throw new Error('MEMORY_GOVERNANCE_CONFLICT');
            live.phase = 'applying';
            delete live.errorCode;
          }, signal);
        }
        // Applying is durable: after a crash do not require archives already
        // removed by the previous attempt to prove the same drain a second time.
        state = await this.store.read(signal);
        job = state.governance!.jobs[id];
        for (const operationId of job.writerOperationIds) {
          signal?.throwIfAborted();
          await this.transport.removeSource(state.operations[operationId]);
        }
        signal?.throwIfAborted();
        await this.transport.clearMemoryScope();
        signal?.throwIfAborted();
        await this.store.transact(current => {
          const live = current.governance!.jobs[id];
          if (live.phase !== 'applying') throw new Error('MEMORY_GOVERNANCE_CONFLICT');
          for (const operationId of live.writerOperationIds) {
            const operation = current.operations[operationId];
            operation.phase = 'blocked';
            operation.errorCode = 'MEMORY_SOURCE_REVOKED';
            delete operation.payload;
            delete operation.memoryUris;
            operation.updatedAt = new Date().toISOString();
          }
          live.phase = 'complete';
          live.completedAt = new Date().toISOString();
          delete live.errorCode;
        }, signal);
        return { status: 'complete' };
      } catch {
        // Keep credentials, references and suppression until the next bounded
        // attempt. Neither network failure nor local cancellation means success.
        await this.store.transact(current => {
          const live = current.governance?.jobs[id];
          if (live && live.phase !== 'complete') live.errorCode = 'MEMORY_GOVERNANCE_RETRY_REQUIRED';
        });
        return { status: 'pending', errorCode: 'MEMORY_GOVERNANCE_RETRY_REQUIRED' };
      }
    }, signal);
  }
}
