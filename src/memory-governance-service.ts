import { MemoryGovernanceBarrier, governanceCandidateText } from './governance.js';
import { MemoryClearCoordinator, type GovernanceProgress, type GovernanceStateStore,
  type GovernanceTransport } from './governance-coordinator.js';
import { MemorySelectiveService, type SelectiveTransport, type WriterClassifier } from './memory-selective.js';
import { MemoryExportService, type MemoryExportTransport } from './memory-export.js';
import { checkedOwner, sameOwner, type GovernanceJob } from './types.js';
import type { MemoryDelivery } from './delivery.js';

export type MemoryGovernanceClient = GovernanceTransport & SelectiveTransport & MemoryExportTransport;
export interface GovernanceReceipt { jobId: string; status: GovernanceProgress['status']; errorCode?: string }

/** Shared entry point for authenticated controls and model tools. */
export class MemoryGovernanceService {
  readonly #selective: MemorySelectiveService;
  readonly #clear: MemoryClearCoordinator;
  readonly #export: MemoryExportService;
  constructor(private readonly store: GovernanceStateStore, private readonly client: MemoryGovernanceClient,
    delivery: Pick<MemoryDelivery, 'advanceGovernance' | 'owner'>, classifyWriter?: WriterClassifier) {
    checkedOwner(store.owner);
    if (!sameOwner(store.owner, client.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    if (!delivery || !sameOwner(store.owner, delivery.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
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
    await this.store.transact(state => {
      if (!state.retirement) state.retirement = { phase: 'requested', requestedAt: new Date().toISOString() };
      state.authorization.enabled = false;
      state.authorization.automaticCollection = false;
      state.authorization.epoch++;
      state.authorization.effectiveAt = new Date().toISOString();
      // Retirement supersedes selective edits: the whole owner scope will be
      // cleared, and the durable retirement fence already blocks all reads.
      for (const job of Object.values(state.governance?.jobs ?? {})) {
        if (job.scope !== this.client.scope || job.kind === 'clear' || job.phase === 'complete') continue;
        job.phase = 'complete'; job.completedAt = new Date().toISOString();
        delete job.selectivePlan; delete job.mergedResolutions; delete job.errorCode;
      }
    });
    let state = await this.store.read();
    if (state.retirement?.phase === 'remote_cleared') {
      return { jobId: state.retirement.clearJobId!, status: 'complete' };
    }
    let pending = await this.pending();
    if (pending) {
      pending = await this.advancePending();
      if (pending?.status === 'pending') return pending;
      if (pending && (await this.store.read()).governance?.jobs[pending.jobId]?.kind === 'clear') {
        await this.store.transact(current => {
          if (current.retirement?.phase === 'requested' && !current.retirement.clearJobId) {
            current.retirement.clearJobId = pending!.jobId;
          }
        });
      }
    }
    state = await this.store.read();
    let clearJob = state.retirement?.clearJobId
      ? state.governance?.jobs[state.retirement.clearJobId] : undefined;
    if (!clearJob) {
      const result = await this.clear();
      await this.store.transact(current => {
        if (current.retirement?.phase === 'requested' && !current.retirement.clearJobId) {
          current.retirement.clearJobId = result.jobId;
        }
      });
      if (result.status === 'pending') return result;
      state = await this.store.read();
      clearJob = state.governance?.jobs[result.jobId];
    }
    if (!clearJob || clearJob.kind !== 'clear' || clearJob.phase !== 'complete') {
      return { jobId: state.retirement!.clearJobId!, status: 'pending' };
    }
    await this.store.transact(current => {
      if (current.retirement?.clearJobId === clearJob!.id) current.retirement.phase = 'remote_cleared';
    });
    return { jobId: clearJob.id, status: 'complete' };
  }
  exportPage(limit: number, cursor?: string, maxBytes?: number) { return this.#export.page({ limit, cursor, maxBytes }); }

  async status(id: string): Promise<GovernanceReceipt> {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_MEMORY_GOVERNANCE');
    const job = (await this.store.read()).governance?.jobs[id];
    if (!job || job.scope !== this.client.scope) throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    return { jobId: id, status: job.phase === 'complete' ? 'complete' : 'pending',
      ...(job.errorCode ? { errorCode: job.errorCode } : {}) };
  }

  async pending(): Promise<GovernanceReceipt | undefined> {
    const job = Object.values((await this.store.read()).governance?.jobs ?? {}).find(job =>
      job.scope === this.client.scope && job.phase !== 'complete');
    return job ? { jobId: job.id, status: 'pending',
      ...(job.errorCode ? { errorCode: job.errorCode } : {}) } : undefined;
  }

  /** Authenticated management clarification; owner and project come from this service. */
  async reviewWriter(jobId: string, operationId: string, decision: 'target' | 'unrelated'): Promise<GovernanceReceipt> {
    const job = (await this.store.read()).governance?.jobs[jobId];
    if (!job || job.scope !== this.client.scope) throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    await new MemoryGovernanceBarrier(this.store).classifyWriter(jobId, operationId, decision);
    const result = await this.#selective.advance(jobId);
    return this.#receipt(job, result);
  }

  async reviewCandidates(jobId: string): Promise<Array<{ operationId: string; phase: string; candidateText: string }>> {
    const state = await this.store.read();
    const job = state.governance?.jobs[jobId];
    if (!job || job.scope !== this.client.scope || job.kind === 'clear' || job.phase !== 'draining') {
      throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    }
    return job.writerOperationIds.flatMap(operationId => {
      const operation = state.operations[operationId];
      if (job.operationIds.includes(operationId) || job.writerClassifications?.[operationId]
        || !operation?.payload || ['failed', 'blocked', 'blocked_by_pause'].includes(operation.phase)) return [];
      return [{ operationId, phase: operation.phase,
        candidateText: governanceCandidateText(operation.payload) }];
    });
  }

  /** Exact remote text is shown only through the authenticated management API. */
  async reviewMergedCandidates(jobId: string): Promise<Array<{ operationId: string;
    candidateText: string; documentText: string }>> {
    const state = await this.store.read();
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
    return operationIds.map(operationId => ({ operationId,
      candidateText: governanceCandidateText(state.operations[operationId].payload ?? ''), documentText }));
  }

  async review(jobId: string) {
    const job = (await this.store.read()).governance?.jobs[jobId];
    if (!job || job.scope !== this.client.scope || job.phase === 'complete') {
      throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    }
    return job.phase === 'draining'
      ? { stage: 'classify' as const, candidates: await this.reviewCandidates(jobId) }
      : { stage: 'merged' as const, candidates: await this.reviewMergedCandidates(jobId) };
  }

  async resolveMergedWriter(jobId: string, operationId: string, exactText: string): Promise<GovernanceReceipt> {
    const job = (await this.store.read()).governance?.jobs[jobId];
    if (!job || job.scope !== this.client.scope) throw new Error('MEMORY_GOVERNANCE_TARGET_MISMATCH');
    await this.#selective.resolveMergedWriter(jobId, operationId, exactText);
    return this.#receipt(job, await this.#selective.advance(jobId));
  }

  /** Idempotent recovery after restart or an unknown remote reply. */
  async advancePending(): Promise<GovernanceReceipt | undefined> {
    const job = Object.values((await this.store.read()).governance?.jobs ?? {}).find(job =>
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
