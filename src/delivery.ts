import { createHash, randomUUID } from 'node:crypto';
import type { CollectionSelectionResult, SelectedCollectionFact } from './collection-selection.js';
import { checkedOwner, sameOwner, isCollectionSource, type CollectionBoundary, type CollectionSource, type Operation, type Owner, type OwnerState, type Source, type StateStore } from './types.js';

/** Each method is owner-bound. Reconciliation never mutates the service. */
export interface DeliveryTransport {
  readonly owner: Owner;
  createSession(id: string): Promise<void>;
  sessionExists(id: string): Promise<boolean>;
  append(operation: Readonly<Operation>): Promise<void>;
  hasSource(operation: Readonly<Operation>): Promise<boolean>;
  commit(id: string): Promise<{ taskId: string; archiveId?: string }>;
  findCommit(id: string): Promise<{ taskId: string; archiveId?: string } | null>;
  inspect(operation: Readonly<Operation>): Promise<
    | { status: 'processing' }
    | { status: 'failed'; code: string }
    | { status: 'ready'; archiveId: string; memoryUris: string[] }
  >;
}

const terminal = new Set(['ready', 'failed', 'blocked_by_pause', 'blocked']);
const unsent = new Set(['queued', 'session_created', 'message_delivered']);

function maySend(state: OwnerState, operation: Operation): boolean {
  const authorization = state.authorization;
  return authorization.enabled && authorization.epoch === operation.authorizationEpoch
    && (operation.kind === 'explicit' || (authorization.automaticCollection
      && authorization.collectionConsent !== undefined
      && authorization.collectionConsent.revision === operation.collectionRevision
      && authorization.collectionConsent.scope === operation.scope));
}
function blockUnsent(state: OwnerState): void {
  for (const request of Object.values(state.collectionRequests ?? {})) {
    const authorization = state.authorization;
    if (['running', 'settled'].includes(request.phase) && (!authorization.enabled
      || !authorization.automaticCollection || request.authorizationEpoch !== authorization.epoch
      || request.collectionRevision !== authorization.collectionConsent?.revision
      || request.scope !== authorization.collectionConsent?.scope)) {
      request.phase = 'blocked_by_pause';
      delete request.selectionLease;
      request.updatedAt = new Date().toISOString();
    }
  }
  for (const operation of Object.values(state.operations)) {
    if (unsent.has(operation.phase) && !maySend(state, operation)) {
      operation.phase = 'blocked_by_pause';
      delete operation.payload;
      operation.updatedAt = new Date().toISOString();
    }
  }
}
function validateBoundary(policyVersion: string, boundaries: CollectionBoundary[]): void {
  if (typeof policyVersion !== 'string' || !policyVersion.trim()) throw new Error('MISSING_POLICY_VERSION');
  if (!Array.isArray(boundaries) || boundaries.some(boundary => !boundary
    || typeof boundary.sessionId !== 'string' || !boundary.sessionId
    || ![boundary.entryId, boundary.branchId].every(id => id === null || (typeof id === 'string' && id.length > 0)))
    || new Set(boundaries.map(boundary => boundary.sessionId)).size !== boundaries.length) {
    throw new Error('INVALID_COLLECTION_BOUNDARY');
  }
}
function validateScope(scope: string | null): void {
  if (scope !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(scope)) throw new Error('INVALID_MEMORY_SCOPE');
}

function collectionSourceKey(owner: Owner, scope: string | null, source: CollectionSource): string {
  return digest(JSON.stringify([owner, scope, source.entryId, source.entryTimestamp, source.contentVersion]));
}
function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function sameSource(a: CollectionSource, b: CollectionSource): boolean {
  return a.sessionId === b.sessionId && a.entryId === b.entryId && a.branchId === b.branchId
    && a.contentVersion === b.contentVersion && a.entryTimestamp === b.entryTimestamp;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export type CollectionHandoffResult =
  | { status: 'recorded'; operationIds: string[] }
  | { status: 'blocked'; errorCode: string };

export class MemoryDelivery {
  readonly #store: StateStore;
  readonly #transport: DeliveryTransport;
  readonly #maxPayloadBytes: number;

  constructor(options: { store: StateStore; transport: DeliveryTransport; maxPayloadBytes: number }) {
    checkedOwner(options.store.owner);
    if (!sameOwner(options.store.owner, options.transport.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    if (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes <= 0) throw new Error('INVALID_MEMORY_LIMIT');
    this.#store = options.store;
    this.#transport = options.transport;
    this.#maxPayloadBytes = options.maxPayloadBytes;
  }

  get owner(): Owner { return this.#store.owner; }

  async enable(policyVersion: string, boundaries: CollectionBoundary[] = []): Promise<void> {
    validateBoundary(policyVersion, boundaries);
    await this.#store.transact(state => {
      const previous = state.authorization;
      const effectiveAt = new Date().toISOString();
      state.authorization = { ...previous, enabled: true,
        epoch: previous.epoch + 1, effectiveAt, policyVersion };
      // Resuming memory does not revoke a separate consent. It does establish
      // a new boundary: old automatic work cannot inherit the resumed policy.
      if (previous.automaticCollection && previous.collectionConsent) {
        state.authorization.collectionConsent = { ...previous.collectionConsent,
          revision: previous.collectionConsent.revision + 1, effectiveAt, policyVersion,
          boundaries: structuredClone(boundaries) };
      }
      blockUnsent(state);
    });
  }

  async pause(): Promise<void> {
    await this.#store.transact(state => {
      state.authorization.enabled = false;
      state.authorization.epoch++;
      state.authorization.effectiveAt = new Date().toISOString();
      blockUnsent(state);
    });
  }

  /** Only trusted, authenticated management code may grant collection consent. */
  async authorizeCollection(options: { policyVersion: string; scope: string | null; boundaries: CollectionBoundary[] }): Promise<void> {
    validateBoundary(options.policyVersion, options.boundaries);
    validateScope(options.scope);
    await this.#store.transact(state => {
      if (!state.authorization.enabled) throw new Error('MEMORY_DISABLED');
      state.authorization.collectionConsent = {
        revision: (state.authorization.collectionConsent?.revision ?? 0) + 1,
        effectiveAt: new Date().toISOString(), policyVersion: options.policyVersion,
        scope: options.scope, boundaries: structuredClone(options.boundaries),
      };
      state.authorization.automaticCollection = true;
      blockUnsent(state);
    });
  }

  async revokeCollection(): Promise<void> {
    await this.#store.transact(state => {
      state.authorization.automaticCollection = false;
      if (state.authorization.collectionConsent) {
        state.authorization.collectionConsent.revision++;
        state.authorization.collectionConsent.effectiveAt = new Date().toISOString();
      }
      blockUnsent(state);
    });
  }

  async save(source: Source, content: string, scope: string | null = null, expectedEpoch?: number): Promise<Operation | { phase: 'blocked'; errorCode: string }> {
    return this.#enqueue(source, content, scope, 'explicit', expectedEpoch);
  }

  /** Collect only against the policy captured for this source, never latest consent. */
  async collect(source: CollectionSource, content: string, policy: { epoch: number; collectionRevision: number }, scope: string | null = null): Promise<Operation | { phase: 'blocked'; errorCode: string }> {
    if (!policy || !Number.isSafeInteger(policy.epoch) || policy.epoch < 0
      || !Number.isSafeInteger(policy.collectionRevision) || policy.collectionRevision < 1) throw new Error('INVALID_COLLECTION_POLICY');
    if (typeof source?.entryTimestamp !== 'string' || !Number.isFinite(Date.parse(source.entryTimestamp))) {
      throw new Error('INVALID_COLLECTION_SOURCE');
    }
    // Session and branch change on fork; copied entries keep their identity.
    const sourceKey = collectionSourceKey(this.owner, scope, source);
    return this.#enqueue(source, content, scope, 'automatic', policy.epoch, policy.collectionRevision, sourceKey);
  }

  /** Trusted selector output only. One durable commit covers results, sources and outbox. */
  async collectSelection(selection: Extract<CollectionSelectionResult, { status: 'ready' }>, leaseId?: string, signal?: AbortSignal): Promise<CollectionHandoffResult> {
    const selected = structuredClone(selection);
    if (!selected || selected.status !== 'ready' || !Array.isArray(selected.requestIds) || !selected.requestIds.length
      || selected.requestIds.some(id => typeof id !== 'string' || !id)
      || new Set(selected.requestIds).size !== selected.requestIds.length || !Array.isArray(selected.facts)) {
      throw new Error('INVALID_COLLECTION_SELECTION');
    }
    return this.#store.transact(state => {
      if (signal?.aborted) return { status: 'blocked', errorCode: 'MEMORY_SELECTION_ABORTED' };
      const requests = selected.requestIds.map(id => state.collectionRequests?.[id]);
      const first = requests[0];
      if (!first || requests.some(request => !request || request.scope !== first.scope
        || request.sessionId !== first.sessionId || request.authorizationEpoch !== first.authorizationEpoch
        || request.collectionRevision !== first.collectionRevision)) {
        return { status: 'blocked', errorCode: 'MEMORY_COLLECTION_BATCH_CONFLICT' };
      }
      const sourceIds = new Set(requests.flatMap(request => request!.sourceEntries));
      const validSource = (source: CollectionSource) => isCollectionSource(source)
        && source.sessionId === first.sessionId && sourceIds.has(source.entryId);
      const groups = new Map<string, { source: CollectionSource; facts: SelectedCollectionFact[]; texts: string[]; payloadDigest: string }>();
      for (const fact of selected.facts) {
        if (!fact || typeof fact.text !== 'string' || !fact.text.trim() || !validSource(fact.source)
          || !Array.isArray(fact.evidence) || !fact.evidence.length || fact.evidence.length > 2
          || fact.evidence.some(evidence => !evidence || !validSource(evidence.source)
            || typeof evidence.quote !== 'string' || !evidence.quote.trim())
          || fact.evidence[0].quote !== fact.text || !sameSource(fact.source, fact.evidence.at(-1)!.source)) {
          throw new Error('INVALID_COLLECTION_SELECTION');
        }
        const key = collectionSourceKey(state.owner, first.scope, fact.source);
        const group = groups.get(key) ?? { source: fact.source, facts: [], texts: [], payloadDigest: '' };
        if (!group.texts.includes(fact.text)) { group.texts.push(fact.text); group.facts.push(fact); }
        groups.set(key, group);
      }
      const ordered = [...groups.entries()].sort(([a], [b]) => compare(a, b));
      for (const [, group] of ordered) {
        group.texts.sort(compare);
        group.payloadDigest = digest(JSON.stringify(group.texts));
      }
      const selectionDigest = digest(JSON.stringify([selected.requestIds.slice().sort(compare),
        ordered.map(([key, group]) => [key, group.payloadDigest])]));
      if (requests.every(request => request!.phase === 'processed')) {
        if (requests.some(request => request!.selectionDigest !== selectionDigest)) {
          return { status: 'blocked', errorCode: 'MEMORY_COLLECTION_BATCH_CONFLICT' };
        }
        return { status: 'recorded', operationIds: [...new Set(requests.flatMap(request => request!.operationIds!))] };
      }
      if (requests.some(request => request!.phase !== 'settled')) {
        return { status: 'blocked', errorCode: 'MEMORY_COLLECTION_BATCH_CONFLICT' };
      }
      if (requests.some(request => leaseId === undefined ? request!.selectionLease !== undefined
        : request!.selectionLease?.id !== leaseId || request!.selectionLease.expiresAt <= Date.now())) {
        return { status: 'blocked', errorCode: 'MEMORY_COLLECTION_CLAIM_EXPIRED' };
      }
      const authorization = state.authorization;
      if (!authorization.enabled || !authorization.automaticCollection
        || authorization.epoch !== first.authorizationEpoch
        || authorization.collectionConsent?.revision !== first.collectionRevision
        || authorization.collectionConsent.scope !== first.scope) {
        return { status: 'blocked', errorCode: 'MEMORY_COLLECTION_NOT_AUTHORIZED' };
      }
      const operationIds = new Set<string>();
      const pending = ordered.filter(([key, group]) => {
        const receipt = state.collectedSources?.[key];
        if (!receipt) return true;
        if (receipt.payloadDigest !== group.payloadDigest) throw new Error('MEMORY_SOURCE_CONFLICT');
        operationIds.add(receipt.operationId);
        return false;
      });
      const now = new Date().toISOString();
      if (pending.length) {
        // Only necessary fact text is sent. Confirmation quotes remain hashed
        // provenance, not another raw conversation copy or provider instruction.
        const payload = JSON.stringify({ type: 'user_confirmed_memory_facts',
          facts: [...new Set(pending.flatMap(([, group]) => group.texts))] });
        if (Buffer.byteLength(payload) > this.#maxPayloadBytes) {
          return { status: 'blocked', errorCode: 'MEMORY_COLLECTION_INPUT_LIMIT' };
        }
        const id = digest(JSON.stringify([state.owner, first.scope, 'collection-batch',
          first.authorizationEpoch, first.collectionRevision, selectionDigest]));
        if (state.operations[id]) throw new Error('MEMORY_COLLECTION_RECEIPT_MISSING');
        const evidence = pending.flatMap(([, group]) => group.facts.flatMap(fact => fact.evidence
          .map(item => ({ source: { ...item.source }, quoteDigest: digest(item.quote) }))));
        const operation: Operation = { id, owner: state.owner, scope: first.scope,
          source: { ...pending[0][1].source }, kind: 'automatic', authorizationEpoch: first.authorizationEpoch,
          collectionRevision: first.collectionRevision, collectionSources: pending.map(([, group]) => ({ ...group.source })),
          collectionEvidence: evidence, createdAt: now, updatedAt: now, phase: 'queued',
          remoteSessionId: randomUUID(), payload };
        state.operations[id] = operation;
        state.collectedSources ??= {};
        for (const [key, group] of pending) state.collectedSources[key] = { operationId: id, payloadDigest: group.payloadDigest };
        operationIds.add(id);
      }
      for (const request of requests) {
        request!.phase = 'processed';
        delete request!.selectionLease;
        delete request!.selectionErrorCode;
        delete request!.selectionNextAttemptAt;
        request!.selectionDigest = selectionDigest;
        request!.operationIds = [...operationIds];
        request!.updatedAt = now;
      }
      return { status: 'recorded', operationIds: [...operationIds] };
    }, signal);
  }

  async #enqueue(source: Source, content: string, scope: string | null, kind: Operation['kind'], expectedEpoch?: number,
    collectionRevision?: number, sourceKey?: string): Promise<Operation | { phase: 'blocked'; errorCode: string }> {
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > this.#maxPayloadBytes
        || !source || ![source.sessionId, source.entryId, source.branchId, source.contentVersion].every(x => typeof x === 'string' && x.length > 0)) {
      throw new Error('INVALID_MEMORY_SOURCE');
    }
    // Scope is supplied by the host, never copied from model input.
    validateScope(scope);
    return this.#store.transact(state => {
      if (!state.authorization.enabled) return { phase: 'blocked', errorCode: 'MEMORY_DISABLED' };
      if (expectedEpoch !== undefined && expectedEpoch !== state.authorization.epoch) {
        return { phase: 'blocked', errorCode: 'MEMORY_CONFIRM_AGAIN' };
      }
      if (kind === 'automatic' && (!state.authorization.automaticCollection
        || collectionRevision !== state.authorization.collectionConsent?.revision
        || scope !== state.authorization.collectionConsent?.scope)) {
        return { phase: 'blocked', errorCode: 'MEMORY_COLLECTION_NOT_AUTHORIZED' };
      }
      const payloadDigest = createHash('sha256').update(content).digest('hex');
      const receipt = sourceKey === undefined ? undefined : state.collectedSources?.[sourceKey];
      if (receipt) {
        if (receipt.payloadDigest !== payloadDigest) throw new Error('MEMORY_SOURCE_CONFLICT');
        // Return the original terminal/unknown receipt; never revive it with a
        // new grant, session, branch or delivery identifier.
        return structuredClone(state.operations[receipt.operationId]);
      }
      const identity: unknown[] = [state.owner, scope, source, state.authorization.epoch];
      if (kind === 'automatic') identity.push(kind, collectionRevision);
      const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const previous = state.operations[id];
      if (previous) {
        if (previous.payload !== undefined && previous.payload !== content) throw new Error('MEMORY_SOURCE_CONFLICT');
        return structuredClone(previous);
      }
      const now = new Date().toISOString();
      const operation: Operation = {
        id, owner: state.owner, source: { ...source }, scope, kind,
        authorizationEpoch: state.authorization.epoch, ...(collectionRevision === undefined ? {} : { collectionRevision }), createdAt: now, updatedAt: now,
        phase: 'queued', remoteSessionId: randomUUID(), payload: content,
      };
      state.operations[id] = operation;
      if (sourceKey !== undefined) {
        state.collectedSources ??= {};
        state.collectedSources[sourceKey] = { operationId: id, payloadDigest };
      }
      return structuredClone(operation);
    });
  }

  /** Advances at most one remote mutation. The caller owns scheduling/lifetime. */
  async advance(id: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('INVALID_MEMORY_OPERATION');
    const operation = await this.#store.transact(state => {
      const current = state.operations[id];
      if (!current || terminal.has(current.phase)) return null;
      if (unsent.has(current.phase) && !maySend(state, current)) {
        current.phase = 'blocked_by_pause';
        delete current.payload;
        return null;
      }
      const snapshot = structuredClone(current);
      if (current.phase === 'queued') current.phase = 'session_unknown';
      if (current.phase === 'session_created') current.phase = 'message_unknown';
      if (current.phase === 'message_delivered') current.phase = 'commit_unknown';
      current.updatedAt = new Date().toISOString();
      return snapshot;
    });
    if (!operation) return;
    try {
      switch (operation.phase) {
        case 'queued':
          await this.#transport.createSession(operation.remoteSessionId);
          await this.#transition(id, 'session_unknown', { phase: 'session_created' });
          break;
        case 'session_unknown':
          if (await this.#transport.sessionExists(operation.remoteSessionId)) {
            await this.#transition(id, 'session_unknown', { phase: 'session_created' });
          }
          break;
        case 'session_created':
          await this.#transport.append(operation);
          await this.#transition(id, 'message_unknown', { phase: 'message_delivered' });
          break;
        case 'message_unknown':
          if (await this.#transport.hasSource(operation)) {
            await this.#transition(id, 'message_unknown', { phase: 'message_delivered' });
          }
          break;
        case 'message_delivered': {
          const receipt = await this.#transport.commit(operation.remoteSessionId);
          await this.#transition(id, 'commit_unknown', { phase: 'processing', ...receipt });
          break;
        }
        case 'commit_unknown': {
          const receipt = await this.#transport.findCommit(operation.remoteSessionId);
          if (receipt) await this.#transition(id, 'commit_unknown', { phase: 'processing', ...receipt });
          break;
        }
        case 'processing': {
          const result = await this.#transport.inspect(operation);
          if (result.status === 'failed') {
            await this.#transition(id, 'processing', { phase: 'failed', errorCode: result.code });
          } else if (result.status === 'ready') {
            if (!result.memoryUris.length) throw new Error('MEMORY_NOT_RETRIEVABLE');
            await this.#transition(id, 'processing', { phase: 'ready', archiveId: result.archiveId, memoryUris: result.memoryUris });
          }
          break;
        }
      }
    } catch {
      // The persisted unknown phase survives transport errors. Neither an
      // exception nor an absent receipt authorizes replay of a mutation.
      await this.#store.transact(state => {
        const current = state.operations[id];
        if (current && !terminal.has(current.phase)) current.errorCode = 'MEMORY_RECONCILIATION_REQUIRED';
      });
    }
  }

  async #transition(id: string, expected: Operation['phase'], patch: Partial<Operation>): Promise<void> {
    await this.#store.transact(state => {
      const current = state.operations[id];
      if (current?.phase !== expected) return;
      Object.assign(current, patch, { updatedAt: new Date().toISOString() });
      if (!patch.errorCode) delete current.errorCode;
      current.deliveryAttempts = 0;
      current.nextAttemptAt = 0;
      if (terminal.has(current.phase)) delete current.payload;
      // A response may arrive after consent changed. Never leave a newly
      // reconciled send phase eligible to carry its old payload forward.
      blockUnsent(state);
    });
  }
}
