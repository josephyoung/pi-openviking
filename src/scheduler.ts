import { governanceHoldsDelivery } from './governance.js';
import type { MemoryDelivery } from './delivery.js';
import { sameOwner, type DeliveryPhase, type StateStore } from './types.js';

const terminal = new Set<DeliveryPhase>(['ready', 'failed', 'blocked', 'blocked_by_pause']);
export interface DeliverySchedulerOptions {
  store: StateStore;
  delivery: Pick<MemoryDelivery, 'advance' | 'owner'>;
  pollIntervalMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  maxAttemptsPerPhase: number;
  maxOperationsPerTick: number;
  onStatus?(status: { operationId: string; phase: DeliveryPhase; errorCode?: string }): void;
  onError?(code: 'MEMORY_SCHEDULER_UNAVAILABLE'): void;
}

/** One owner-level service, independent of viewers and session lifetimes. */
export class DeliveryScheduler {
  readonly #options: DeliverySchedulerOptions;
  #active = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #wakeRequested = false;

  constructor(options: DeliverySchedulerOptions) {
    if (![options.pollIntervalMs, options.initialBackoffMs, options.maxBackoffMs,
      options.maxAttemptsPerPhase, options.maxOperationsPerTick]
      .every(value => Number.isSafeInteger(value) && value > 0)
      || options.maxBackoffMs < options.initialBackoffMs) throw new Error('INVALID_MEMORY_SCHEDULER_POLICY');
    if (!sameOwner(options.store.owner, options.delivery.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    this.#options = { ...options };
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.wake();
  }

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
      this.#running = this.#tick().catch(() => {
        try { this.#options.onError?.('MEMORY_SCHEDULER_UNAVAILABLE'); } catch { /* observer isolation */ }
      }).finally(() => {
        this.#running = undefined;
        const delay = this.#wakeRequested ? 0 : this.#options.pollIntervalMs;
        this.#wakeRequested = false;
        this.#schedule(delay);
      });
    }, delay);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    const { store, delivery, maxOperationsPerTick, maxAttemptsPerPhase, initialBackoffMs, maxBackoffMs } = this.#options;
    const snapshot = await store.read();
    const candidates = Object.values(snapshot.operations).filter(operation => !terminal.has(operation.phase) && !governanceHoldsDelivery(snapshot, operation) && (operation.nextAttemptAt ?? 0) <= Date.now())
      .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0) || a.createdAt.localeCompare(b.createdAt));
    let processed = 0;
    for (const candidate of candidates) {
      if (!this.#active || processed >= maxOperationsPerTick) break;
      processed++;
      const claimed = await store.transact(state => {
        const operation = state.operations[candidate.id];
        const now = Date.now();
        if (!operation || terminal.has(operation.phase) || governanceHoldsDelivery(state, operation) || (operation.nextAttemptAt ?? 0) > now) return false;
        const attempts = operation.deliveryAttempts ?? 0;
        if (attempts >= maxAttemptsPerPhase) {
          // This is an unresolved outcome, never a claim that the server failed
          // or cancelled work. Keep remote references for governance/inspection.
          operation.phase = 'blocked';
          operation.errorCode = 'MEMORY_RECONCILIATION_LIMIT';
          operation.updatedAt = new Date(now).toISOString();
          delete operation.payload;
          return false;
        }
        operation.deliveryAttempts = attempts + 1;
        operation.nextAttemptAt = now + Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.min(attempts, 30));
        return true;
      });
      if (claimed) await delivery.advance(candidate.id);
      const current = (await store.read()).operations[candidate.id];
      if (current && (claimed || current.phase !== candidate.phase)) {
        try { this.#options.onStatus?.({ operationId: current.id, phase: current.phase, errorCode: current.errorCode }); }
        catch { /* status observers must not interrupt durable delivery */ }
      }
    }
  }

  /** Stop taking new work. Without a deadline, wait for the entire active tick,
   * including local receipt writes. A bounded wait returns false if still busy;
   * it is not a persistence fence and does not cancel a sent mutation. */
  async stop(waitMs?: number): Promise<boolean> {
    if (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 0)) throw new Error('INVALID_MEMORY_SHUTDOWN_TIMEOUT');
    this.#active = false;
    this.#wakeRequested = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const running = this.#running;
    if (!running) return true;
    if (waitMs === undefined) { await running; return true; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([running.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), waitMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
