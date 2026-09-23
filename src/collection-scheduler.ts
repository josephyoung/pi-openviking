import { governanceHoldsCollection, sourceRevoked } from './governance.js';
import { randomUUID } from 'node:crypto';
import type { CollectionFactSelector } from './collection-selection.js';
import type { MemoryDelivery } from './delivery.js';
import { sameOwner, type CollectionRequest, type OwnerState, type StateStore } from './types.js';

type Session = Parameters<CollectionFactSelector['select']>[1];
export interface CollectionSchedulerOptions {
  store: StateStore;
  delivery: Pick<MemoryDelivery, 'owner' | 'collectSelection'>;
  selector: Pick<CollectionFactSelector, 'select'>;
  /** Trusted owner-bound lookup, including persisted sessions without viewers. */
  resolveSession(sessionId: string, signal: AbortSignal): Promise<Session>;
  scope?: string | null;
  pollIntervalMs: number;
  mergeWindowMs: number;
  maxWaitMs: number;
  workTimeoutMs: number;
  leaseMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  maxAttempts: number;
  maxRequestsPerBatch: number;
  wakeDelivery(): void;
  onError?(code: 'MEMORY_COLLECTION_SCHEDULER_UNAVAILABLE'): void;
}

function permitted(state: OwnerState, request: CollectionRequest, scope: string | null): boolean {
  const auth = state.authorization;
  return !governanceHoldsCollection(state, request) && !request.sourceEntries.some(entryId => sourceRevoked(state, scope, entryId))
    && request.phase === 'settled' && request.scope === scope && auth.enabled && auth.automaticCollection
    && request.authorizationEpoch === auth.epoch && request.collectionRevision === auth.collectionConsent?.revision
    && request.scope === auth.collectionConsent?.scope;
}
function available(request: CollectionRequest, now: number): boolean {
  return (request.selectionNextAttemptAt ?? 0) <= now && (request.selectionLease?.expiresAt ?? 0) <= now;
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let aborted: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); }),
      new Promise<never>((_, reject) => {
        aborted = () => reject(new Error('MEMORY_SELECTION_ABORTED'));
        signal.addEventListener('abort', aborted, { once: true });
      })]);
  } finally {
    clearTimeout(timer);
    if (aborted) signal.removeEventListener('abort', aborted);
  }
}

/** Owner service: durable claims and recovery never depend on an open viewer. */
export class CollectionScheduler {
  readonly #options: CollectionSchedulerOptions;
  #lifetime = new AbortController();
  #active = false;
  #timer?: ReturnType<typeof setTimeout>;
  #running?: Promise<void>;
  #wakeRequested = false;

  constructor(options: CollectionSchedulerOptions) {
    if (![options.pollIntervalMs, options.maxWaitMs, options.workTimeoutMs, options.leaseMs,
      options.initialBackoffMs, options.maxBackoffMs, options.maxAttempts, options.maxRequestsPerBatch]
      .every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(options.mergeWindowMs) || options.mergeWindowMs < 0
      || options.maxWaitMs < options.mergeWindowMs || options.leaseMs <= options.workTimeoutMs
      || options.maxBackoffMs < options.initialBackoffMs) throw new Error('INVALID_COLLECTION_SCHEDULER_POLICY');
    if (!sameOwner(options.store.owner, options.delivery.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    this.#options = { ...options };
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#lifetime = new AbortController();
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
      const signal = this.#lifetime.signal;
      this.#running = this.#tick(signal).catch(() => {
        try { this.#options.onError?.('MEMORY_COLLECTION_SCHEDULER_UNAVAILABLE'); } catch { /* observer isolation */ }
      }).finally(() => {
        this.#running = undefined;
        const delay = this.#wakeRequested ? 0 : this.#options.pollIntervalMs;
        this.#wakeRequested = false;
        this.#schedule(delay);
      });
    }, delay);
    this.#timer.unref();
  }

  async #tick(signal: AbortSignal): Promise<void> {
    const o = this.#options;
    const scope = o.scope ?? null;
    const snapshot = await bounded(abort => o.store.read(abort), o.workTimeoutMs, signal);
    const now = Date.now();
    if (Object.values(snapshot.collectionRequests ?? {}).some(request => (request.selectionLease?.expiresAt ?? 0) > now)) return;
    const eligible = Object.values(snapshot.collectionRequests ?? {})
      .filter(request => permitted(snapshot, request, scope) && available(request, now))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
    // Pick the oldest due session; a newer wake must never postpone its max wait.
    let batch: CollectionRequest[] = [];
    for (const first of eligible) {
      const group = eligible.filter(request => request.sessionId === first.sessionId
        && request.authorizationEpoch === first.authorizationEpoch && request.collectionRevision === first.collectionRevision);
      const dueAt = Math.min(Date.parse(group[0].updatedAt) + o.maxWaitMs,
        Date.parse(group.at(-1)!.updatedAt) + o.mergeWindowMs);
      if (now < dueAt) continue;
      batch = group.slice(0, o.maxRequestsPerBatch);
      break;
    }
    if (!batch.length) return;
    let session: Session | undefined;
    try {
      session = await bounded(abort => o.resolveSession(batch[0].sessionId, abort), o.workTimeoutMs, signal);
      if (session.getSessionId() !== batch[0].sessionId) throw new Error('MEMORY_SOURCE_UNAVAILABLE');
      const positions = new Map(session.getEntries().map((entry, index) => [entry.id, index]));
      batch.sort((a, b) => (positions.get(a.settledEntryId!) ?? Infinity) - (positions.get(b.settledEntryId!) ?? Infinity));
      // Merge only one actual pi lineage. Sibling branches remain pending.
      const compatible = [batch[0]];
      for (const candidate of batch.slice(1)) {
        const lineage = new Set(session.getBranch(candidate.settledEntryId).map(entry => entry.id));
        if (compatible.every(request => request.sourceEntries.every(id => lineage.has(id)))) compatible.push(candidate);
      }
      batch = compatible;
    } catch {
      signal.throwIfAborted();
      session = undefined;
      batch = batch.slice(0, 1);
    }
    const leaseId = randomUUID();
    const ids = batch.map(request => request.id);
    const claimed = await bounded(abort => o.store.transact(state => {
      if (abort.aborted) return false;
      const current = ids.map(id => state.collectionRequests?.[id]);
      const now = Date.now();
      if (Object.values(state.collectionRequests ?? {}).some(request => (request.selectionLease?.expiresAt ?? 0) > now)) return false;
      if (current.some(request => !request || !permitted(state, request, scope) || !available(request, now))) return false;
      if (current.some(request => (request!.selectionAttempts ?? 0) >= o.maxAttempts)) {
        for (const request of current) if ((request!.selectionAttempts ?? 0) >= o.maxAttempts) {
          request!.phase = 'selection_failed';
          request!.selectionErrorCode = 'MEMORY_SELECTION_RETRY_LIMIT';
          delete request!.selectionLease;
        }
        return false;
      }
      for (const request of current) {
        request!.selectionAttempts = (request!.selectionAttempts ?? 0) + 1;
        request!.selectionLease = { id: leaseId, expiresAt: now + o.leaseMs };
      }
      return true;
    }, abort), o.workTimeoutMs, signal);
    if (!claimed) return;
    let code = 'MEMORY_SOURCE_UNAVAILABLE';
    try {
      if (session) {
        const selected = await bounded(abort => o.selector.select(ids, session!, abort), o.workTimeoutMs, signal);
        signal.throwIfAborted();
        if (selected.status === 'ready') {
          if (selected.requestIds.length !== ids.length || selected.requestIds.some(id => !ids.includes(id))) {
            code = 'MEMORY_SELECTION_INVALID';
          } else {
            const receipt = await bounded(abort => o.delivery.collectSelection(selected, leaseId, abort), o.workTimeoutMs, signal);
            if (receipt.status === 'recorded') {
              try { o.wakeDelivery(); } catch { /* committed work is recovered by delivery polling */ }
              return;
            }
            code = receipt.errorCode;
          }
        } else code = selected.code;
      }
    } catch { code = signal.aborted ? 'MEMORY_SELECTION_ABORTED' : 'MEMORY_SELECTION_FAILED'; }
    // A stopped/expired process can never release another process's claim.
    // Use a separate bounded cleanup lifetime: stopping must still persist retry state.
    await bounded(abort => o.store.transact(state => {
      if (abort.aborted) return;
      for (const id of ids) {
        const request = state.collectionRequests?.[id];
        if (!request || request.phase !== 'settled' || request.selectionLease?.id !== leaseId) continue;
        delete request.selectionLease;
        request.selectionErrorCode = /^MEMORY_[A-Z_]+$/.test(code) ? code : 'MEMORY_SELECTION_FAILED';
        if ((request.selectionAttempts ?? 0) >= o.maxAttempts) request.phase = 'selection_failed';
        else request.selectionNextAttemptAt = Date.now() + Math.min(o.maxBackoffMs,
          o.initialBackoffMs * 2 ** Math.min((request.selectionAttempts ?? 1) - 1, 30));
      }
    }, abort), o.workTimeoutMs, new AbortController().signal);
  }

  async stop(): Promise<void> {
    this.#active = false;
    this.#wakeRequested = false;
    this.#lifetime.abort();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
