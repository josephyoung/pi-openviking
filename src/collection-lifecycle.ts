import { randomUUID, createHash } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CollectionRequest, StateStore } from './types.js';

type Session = Pick<ExtensionContext['sessionManager'], 'getSessionId' | 'getBranch'>;

/** Records request boundaries; it neither selects facts nor sends conversation text. */
export class CollectionLifecycle {
  constructor(readonly store: StateStore, readonly scope: string | null = null) {}

  /** Call before the new user entry is appended, never from a message-end hook. */
  async begin(session: Session, continuationId?: string, signal?: AbortSignal): Promise<string | undefined> {
    const sessionId = session.getSessionId();
    const branch = session.getBranch();
    const baselineEntryId = branch.at(-1)?.id ?? null;
    return this.store.transact(state => {
      signal?.throwIfAborted();
      const authorization = state.authorization;
      const consent = authorization.collectionConsent;
      if (!authorization.enabled || !authorization.automaticCollection || !consent || consent.scope !== this.scope) return;
      state.collectionRequests ??= {};
      // Queued continuations/retries belong to the same not-yet-settled request.
      const existing = Object.values(state.collectionRequests).find(request => request.id === continuationId && request.sessionId === sessionId
        && request.phase === 'running' && request.authorizationEpoch === authorization.epoch
        && request.collectionRevision === consent.revision && request.scope === this.scope);
      if (existing) return existing.id;
      // A new process/request cannot infer settlement of an interrupted run.
      for (const prior of Object.values(state.collectionRequests)) {
        if (prior.sessionId === sessionId && prior.phase === 'running') {
          prior.phase = 'discarded';
          prior.updatedAt = new Date().toISOString();
        }
      }
      const preceding = [...branch].reverse().find(entry => entry.type === 'message');
      const prior = preceding?.type === 'message' && preceding.message.role === 'assistant' && preceding.message.stopReason === 'stop'
        ? Object.values(state.collectionRequests).find(request => request.scope === this.scope
          && request.completedAssistant?.entryId === preceding.id && request.completedAssistant.entryTimestamp === preceding.timestamp
          && request.completedAssistant.contentVersion === createHash('sha256').update(JSON.stringify(preceding.message)).digest('hex')
          && request.authorizationEpoch === authorization.epoch && request.collectionRevision === consent.revision
          && ['settled', 'processed', 'selection_failed'].includes(request.phase) && request.sourceEntries.includes(preceding.id))
        : undefined;
      const id = randomUUID();
      const now = new Date().toISOString();
      state.collectionRequests[id] = { id, sessionId, baselineEntryId, scope: this.scope,
        authorizationEpoch: authorization.epoch, collectionRevision: consent.revision,
        phase: 'running', createdAt: now, updatedAt: now, sourceEntries: [],
        ...(prior && preceding ? { confirmationReference: { requestId: prior.id, entryId: preceding.id } } : {}) };
      return id;
    }, signal);
  }

  /** Only agent_settled may call this: turn_end/agent_end are insufficient. */
  async settle(id: string, session: Session, waitingForInput = false, signal?: AbortSignal): Promise<CollectionRequest | undefined> {
    const sessionId = session.getSessionId();
    const branch = session.getBranch();
    return this.store.transact(state => {
      signal?.throwIfAborted();
      const request = state.collectionRequests?.[id];
      if (!request || request.sessionId !== sessionId || request.scope !== this.scope) return;
      if (request.phase !== 'running') return structuredClone(request);
      const authorization = state.authorization;
      if (!authorization.enabled || !authorization.automaticCollection
        || request.authorizationEpoch !== authorization.epoch
        || request.collectionRevision !== authorization.collectionConsent?.revision
        || request.scope !== authorization.collectionConsent?.scope) {
        request.phase = 'blocked_by_pause';
      } else {
        // getBranch uses original entries, including those summarized by compaction.
        const baseline = request.baselineEntryId === null ? -1 : branch.findIndex(entry => entry.id === request.baselineEntryId);
        const newEntries = baseline < 0 && request.baselineEntryId !== null ? [] : branch.slice(baseline + 1);
        const messages = newEntries.filter(entry => entry.type === 'message');
        const final = messages.at(-1);
        if (waitingForInput) return structuredClone(request);
        // Errors, cancellation, unfinished tool calls, and changed ancestry are
        // not a completed user request. They must not authorize partial capture.
        if (final?.type !== 'message' || final.message.role !== 'assistant' || final.message.stopReason !== 'stop'
          || !messages.some(entry => entry.type === 'message' && entry.message.role === 'user')) {
          request.phase = 'discarded';
        } else {
          request.phase = 'settled';
          request.settledEntryId = branch.at(-1)!.id;
          request.sourceEntries = messages.map(entry => entry.id);
          request.completedAssistant = { sessionId, entryId: final.id, entryTimestamp: final.timestamp,
            branchId: request.settledEntryId, contentVersion: createHash('sha256').update(JSON.stringify(final.message)).digest('hex') };
        }
      }
      request.updatedAt = new Date().toISOString();
      return structuredClone(request);
    }, signal);
  }
}
