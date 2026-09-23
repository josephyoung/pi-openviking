import { randomUUID } from 'node:crypto';
import { MemoryGovernanceBarrier, governanceCandidateText } from './governance.js';
import { MemoryClearCoordinator, type GovernanceProgress, type GovernanceStateStore,
  type GovernanceTransport } from './governance-coordinator.js';
import { MemorySelectiveService, type SelectiveTransport, type WriterClassifier } from './memory-selective.js';
import { MemoryExportService, type MemoryExportTransport } from './memory-export.js';
import { checkedOwner, sameOwner, type GovernanceJob, type Owner, type Operation } from './types.js';
import type { MemoryDelivery } from './delivery.js';

export type MemoryGovernanceClient = GovernanceTransport & SelectiveTransport & MemoryExportTransport & {
  writerSettledAny(operation: Readonly<Operation>): Promise<boolean>;
  clearOwnerData(): Promise<void>;
};
export interface GovernanceReceipt { jobId: string; status: GovernanceProgress['status'] | 'superseded'; errorCode?: string }

/** Shared entry point for authenticated controls and model tools. */
export class MemoryGovernanceService {
  readonly owner: Owner;
  readonly scope: string | null;
  readonly #selective: MemorySelectiveService;
  readonly #clear: MemoryClearCoordinator;
  readonly #export: MemoryExportService;
  constructor(private readonly store: GovernanceStateStore, private readonly client: MemoryGovernanceClient,
    delivery: Pick<MemoryDelivery, 'advanceGovernance' | 'owner'>, classifyWriter?: WriterClassifier) {
    checkedOwner(store.owner);
    if (!sameOwner(store.owner, client.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    if (!delivery || !sameOwner(store.owner, delivery.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    this.owner = Object.freeze({ ...store.owner });
    this.scope = client.scope;
    this.#selective = new MemorySelectiveService(store, client,
      (operationId, jobId) => delivery.advanceGovernance(operationId, jobId), classifyWriter);
    this.#clear = new MemoryClearCoordinator(store, client);
    this.#export = new MemoryExportService(store, client);
  }

  async correct(memoryUri: string, selectedText: string, replacementText: string): Promise<GovernanceReceipt> {
    const job = await this.#selective.begin({ kind: 'correct', memoryUri, selectedText, replacementText });
    return this.#receipt(job, await this.#selective.advance(job.id));
  }
  async forget(memoryUri: string, selectedText: string): Promise<GovernanceReceipt> {
    const job = await this.#selective.begin({ kind: 'forget', memoryUri, selectedText });
    return this.#receipt(job, await this.#selective.advance(job.id));
  }
  async clear(): Promise<GovernanceReceipt> {
    const job = await this.store.withGovernanceLock(() =>
      new MemoryGovernanceBarrier(this.store).begin({ kind: 'clear', scope: this.client.scope,
        supersedePending: true }));
    return this.#receipt(job, await this.#clear.advance(job.id));
  }
  /** Persist access revocation before any remote operation. The host retains
   * its cleanup credential and state until this returns complete. */
  async retire(): Promise<GovernanceReceipt> {
    if (!(await this.store.read()).retirement) {
      await this.store.transact(state => {
        if (state.retirement) return;
        state.retirement = { id: randomUUID(), phase: 'requested', requestedAt: new Date().toISOString() };
        state.authorization.enabled = false;
        state.authorization.automaticCollection = false;
        state.authorization.epoch++;
        state.authorization.effectiveAt = new Date().toISOString();
      });
    }
    return this.store.withGovernanceLock(async () => {
      const state = await this.store.read();
      const retirement = state.retirement!;
      if (retirement.phase === 'remote_cleared') return { jobId: retirement.id, status: 'complete' };
      try {
        // Every accepted writer, including project peers, must settle before
        // deleting the owner's global and peer memory trees.
        for (const operation of Object.values(state.operations)) {
          if (!await this.client.writerSettledAny(operation)) return { jobId: retirement.id, status: 'pending' };
        }
        await this.client.clearOwnerData();
      } catch {
        return { jobId: retirement.id, status: 'pending', errorCode: 'MEMORY_GOVERNANCE_RETRY_REQUIRED' };
      }
      await this.store.transact(current => {
        if (current.retirement?.id !== retirement.id || current.retirement.phase !== 'requested') {
          throw new Error('MEMORY_RETIREMENT_CONFLICT');
        }
        current.retirement.phase = 'remote_cleared';
        for (const operation of Object.values(current.operations)) {
          operation.phase = 'blocked'; operation.errorCode = 'MEMORY_SOURCE_REVOKED';
          delete operation.payload; delete operation.memoryUris;
        }
        for (const job of Object.values(current.governance?.jobs ?? {})) {
          if (job.phase === 'complete') continue;
          job.phase = 'complete'; job.completedAt = new Date().toISOString();
          job.cancelledByRetirement = true;
          delete job.selectivePlan; delete job.mergedResolutions; delete job.errorCode;
        }
      });
      return { jobId: retirement.id, status: 'complete' };
    });
  }
  exportPage(limit: number, cursor?: string, maxBytes?: number) { return this.#export.page({ limit, cursor, maxBytes }); }

  async status(id: string): Promise<GovernanceReceipt> {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_MEMORY_GOVERNANCE');
    const state = await this.store.read();
    if (state.retirement?.id === id) return { jobId: id,
      status: state.retirement.phase === 'remote_cleared' ? 'complete' : 'pending' };
    const job = state.governance?.jobs[id];
    if (!job || job.scope !== this.client.scope) throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    // Retirement takes over only work that was still pending. A successful
    // historical receipt must not regress while account cleanup is retried.
    if (job.phase === 'complete' && !job.cancelledByRetirement && !job.supersededBy) {
      return { jobId: id, status: 'complete' };
    }
    if (state.retirement) return { jobId: id, status: state.retirement.phase === 'remote_cleared' ? 'superseded' : 'pending' };
    if (job.supersededBy) {
      const replacement = state.governance?.jobs[job.supersededBy];
      if (!replacement || replacement.kind !== 'clear' || replacement.scope !== job.scope) {
        throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
      }
      return { jobId: id, status: replacement.phase === 'complete' ? 'superseded' : 'pending',
        ...(replacement.errorCode ? { errorCode: replacement.errorCode } : {}) };
    }
    return { jobId: id, status: job.phase === 'complete' ? 'complete' : 'pending',
      ...(job.errorCode ? { errorCode: job.errorCode } : {}) };
  }

  async pending(): Promise<GovernanceReceipt | undefined> {
    const state = await this.store.read();
    if (state.retirement?.phase === 'requested') return { jobId: state.retirement.id, status: 'pending' };
    if (state.retirement?.phase === 'remote_cleared') return undefined;
    const job = Object.values(state.governance?.jobs ?? {}).find(job =>
      job.scope === this.client.scope && job.phase !== 'complete');
    return job ? { jobId: job.id, status: 'pending',
      ...(job.errorCode ? { errorCode: job.errorCode } : {}) } : undefined;
  }

  /** Authenticated management clarification; owner and project come from this service. */
  async reviewWriter(jobId: string, operationId: string, decision: 'target' | 'unrelated'): Promise<GovernanceReceipt> {
    const state = await this.store.read();
    if (state.retirement) throw new Error('MEMORY_RETIRED');
    const job = state.governance?.jobs[jobId];
    if (!job || job.scope !== this.client.scope) throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    await new MemoryGovernanceBarrier(this.store).classifyWriter(jobId, operationId, decision);
    const result = await this.#selective.advance(jobId);
    return this.#receipt(job, result);
  }

  async reviewCandidates(jobId: string): Promise<Array<{ operationId: string; phase: string; candidateText: string }>> {
    const state = await this.store.read();
    if (state.retirement) throw new Error('MEMORY_RETIRED');
    const job = state.governance?.jobs[jobId];
    if (!job || job.scope !== this.client.scope || job.kind === 'clear' || job.phase !== 'draining') {
      throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    }
    const candidates = job.writerOperationIds.flatMap(operationId => {
      const operation = state.operations[operationId];
      if (job.operationIds.includes(operationId) || job.writerClassifications?.[operationId]
        || !operation?.payload || ['failed', 'blocked', 'blocked_by_pause'].includes(operation.phase)) return [];
      return [{ operationId, phase: operation.phase,
        candidateText: governanceCandidateText(operation.payload) }];
    });
    const latest = await this.store.read();
    if (latest.retirement || latest.revision !== state.revision) throw new Error('MEMORY_CONTENT_CHANGED');
    return candidates;
  }

  /** Exact remote text is shown only through the authenticated management API. */
  async reviewMergedCandidates(jobId: string): Promise<Array<{ operationId: string;
    candidateText: string; documentText: string }>> {
    const state = await this.store.read();
    if (state.retirement) throw new Error('MEMORY_RETIRED');
    const job = state.governance?.jobs[jobId];
    const plan = job?.selectivePlan;
    if (!job || job.scope !== this.client.scope || job.phase !== 'applying' || !plan) {
      throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    }
    const operationIds = job.operationIds.filter(operationId =>
      job.writerClassifications?.[operationId] === 'target'
      && state.operations[operationId].memoryUris?.includes(plan.memoryUri)
      && !job.mergedResolutions?.[operationId]);
    if (!operationIds.length) return [];
    const documentText = await this.client.readMemoryLimited(plan.memoryUri, 32768);
    const latest = await this.store.read();
    if (latest.retirement || latest.revision !== state.revision) throw new Error('MEMORY_CONTENT_CHANGED');
    return operationIds.map(operationId => ({ operationId,
      candidateText: governanceCandidateText(state.operations[operationId].payload ?? ''), documentText }));
  }

  async review(jobId: string) {
    const state = await this.store.read();
    if (state.retirement) throw new Error('MEMORY_RETIRED');
    const job = state.governance?.jobs[jobId];
    if (!job || job.scope !== this.client.scope || job.phase === 'complete') {
      throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    }
    return job.phase === 'draining'
      ? { stage: 'classify' as const, candidates: await this.reviewCandidates(jobId) }
      : { stage: 'merged' as const, candidates: await this.reviewMergedCandidates(jobId) };
  }

  async resolveMergedWriter(jobId: string, operationId: string, exactText: string): Promise<GovernanceReceipt> {
    const state = await this.store.read();
    if (state.retirement) throw new Error('MEMORY_RETIRED');
    const job = state.governance?.jobs[jobId];
    if (!job || job.scope !== this.client.scope) throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    await this.#selective.resolveMergedWriter(jobId, operationId, exactText);
    return this.#receipt(job, await this.#selective.advance(jobId));
  }

  /** Idempotent recovery after restart or an unknown remote reply. */
  async advancePending(): Promise<GovernanceReceipt | undefined> {
    const state = await this.store.read();
    if (state.retirement?.phase === 'requested') return this.retire();
    if (state.retirement?.phase === 'remote_cleared') return undefined;
    const job = Object.values(state.governance?.jobs ?? {}).find(job =>
      job.scope === this.client.scope && job.phase !== 'complete');
    if (!job) return undefined;
    const result = job.kind === 'clear' ? await this.#clear.advance(job.id) : await this.#selective.advance(job.id);
    return this.#receipt(job, result);
  }

  #receipt(job: GovernanceJob, result: GovernanceProgress): GovernanceReceipt {
    return { jobId: job.id, status: result.status,
      ...(result.status === 'pending' && result.errorCode ? { errorCode: result.errorCode } : {}) };
  }
}

/** Periodically resumes durable jobs without requiring an open browser session. */
export class MemoryGovernanceScheduler {
  #active = false;
  #timer?: ReturnType<typeof setTimeout>;
  #running?: Promise<void>;
  #wakeRequested = false;
  constructor(private readonly service: Pick<MemoryGovernanceService, 'advancePending'>,
    private readonly pollIntervalMs: number,
    private readonly onError?: (code: 'MEMORY_GOVERNANCE_SCHEDULER_UNAVAILABLE') => void) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('INVALID_MEMORY_SCHEDULER_POLICY');
  }
  start(): void { if (this.#active) return; this.#active = true; this.#schedule(this.pollIntervalMs); }
  wake(): void {
    if (!this.#active) return;
    if (this.#running) { this.#wakeRequested = true; return; }
    this.#schedule(0);
  }
  #schedule(delay: number): void {
    if (!this.#active) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.service.advancePending().then(() => {}, () => {
        try { this.onError?.('MEMORY_GOVERNANCE_SCHEDULER_UNAVAILABLE'); } catch { /* observer isolation */ }
      }).finally(() => {
        this.#running = undefined;
        const next = this.#wakeRequested ? 0 : this.pollIntervalMs;
        this.#wakeRequested = false;
        this.#schedule(next);
      });
    }, delay);
    this.#timer.unref();
  }
  async stop(): Promise<void> {
    this.#active = false; this.#wakeRequested = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
