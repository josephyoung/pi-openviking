import { createHash, randomUUID } from 'node:crypto';
import { checkedOwner, sameOwner, type Operation, type Owner, type Source, type StateStore } from './types.js';

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

  async enable(policyVersion: string): Promise<void> {
    if (!policyVersion) throw new Error('MISSING_POLICY_VERSION');
    await this.#store.transact(state => {
      state.authorization = { enabled: true, automaticCollection: false,
        epoch: state.authorization.epoch + 1, effectiveAt: new Date().toISOString(), policyVersion };
    });
  }

  async pause(): Promise<void> {
    await this.#store.transact(state => {
      state.authorization.enabled = false;
      state.authorization.epoch++;
      state.authorization.effectiveAt = new Date().toISOString();
      for (const operation of Object.values(state.operations)) {
        if (unsent.has(operation.phase)) {
          operation.phase = 'blocked_by_pause';
          delete operation.payload;
          operation.updatedAt = new Date().toISOString();
        }
      }
    });
  }

  async save(source: Source, content: string, scope: string | null = null): Promise<Operation | { phase: 'blocked'; errorCode: string }> {
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > this.#maxPayloadBytes
        || !source || ![source.sessionId, source.entryId, source.branchId, source.contentVersion].every(x => typeof x === 'string' && x.length > 0)) {
      throw new Error('INVALID_MEMORY_SOURCE');
    }
    // Scope is supplied by the host, never copied from model input.
    if (scope !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(scope)) throw new Error('INVALID_MEMORY_SCOPE');
    return this.#store.transact(state => {
      if (!state.authorization.enabled) return { phase: 'blocked', errorCode: 'MEMORY_DISABLED' };
      const id = createHash('sha256').update(JSON.stringify([
        state.owner, scope, source, state.authorization.epoch,
      ])).digest('hex');
      const previous = state.operations[id];
      if (previous) {
        if (previous.payload !== undefined && previous.payload !== content) throw new Error('MEMORY_SOURCE_CONFLICT');
        return structuredClone(previous);
      }
      const now = new Date().toISOString();
      const operation: Operation = {
        id, owner: state.owner, source: { ...source }, scope, kind: 'explicit',
        authorizationEpoch: state.authorization.epoch, createdAt: now, updatedAt: now,
        phase: 'queued', remoteSessionId: randomUUID(), payload: content,
      };
      state.operations[id] = operation;
      return structuredClone(operation);
    });
  }

  /** Advances at most one remote mutation. The caller owns scheduling/lifetime. */
  async advance(id: string): Promise<void> {
    const operation = await this.#store.transact(state => {
      const current = state.operations[id];
      if (!current || terminal.has(current.phase)) return null;
      if (unsent.has(current.phase) && (!state.authorization.enabled
          || current.authorizationEpoch !== state.authorization.epoch)) {
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
    });
  }
}
