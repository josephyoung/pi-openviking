import { OpenVikingClient, isOpenVikingError } from '@openviking/sdk';
import { checkedOwner, sameOwner, type Operation, type Owner } from './types.js';
import type { DeliveryTransport } from './delivery.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_MEMORY_RESPONSE');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('INVALID_MEMORY_REFERENCE');
  return value;
}
function sourcePresent(value: unknown, id: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => sourcePresent(item, id));
  const record = value as Record<string, unknown>;
  return (Array.isArray(record.source_message_ids) && record.source_message_ids.includes(id))
    || Object.entries(record).some(([key, item]) => key !== 'source_message_ids' && sourcePresent(item, id));
}

export interface RecalledMemory { uri: string; text: string; score: number }

/** No management key, caller-controlled headers or owner overrides are exposed. */
export class OwnerMemoryClient implements DeliveryTransport {
  readonly owner: Owner;
  readonly scope: string | null;
  readonly #sdk: OpenVikingClient;
  readonly #baseUrl: string;
  readonly #key: string;
  readonly #timeoutMs: number;
  readonly #root: string;
  #identity: Promise<void> | undefined;

  constructor(options: { owner: Owner; baseUrl: string; apiKey: string; scope?: string | null; timeoutMs: number }) {
    this.owner = checkedOwner(options.owner);
    this.scope = options.scope ?? null;
    if (this.scope !== null) identifier(this.scope);
    const url = new URL(options.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || url.pathname !== '/' || !options.apiKey || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('INVALID_MEMORY_CONNECTION');
    }
    this.#baseUrl = url.origin;
    this.#key = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#root = `viking://user/${this.owner.userId}/${this.scope === null ? '' : `peers/${this.scope}/`}memories`;
    this.#sdk = new OpenVikingClient({ baseUrl: this.#baseUrl, apiKey: this.#key,
      actorPeerId: this.scope ?? undefined, timeout: this.#timeoutMs,
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) });
  }

  async verifyIdentity(): Promise<void> {
    this.#identity ??= (async () => {
      const response = await fetch(`${this.#baseUrl}/health`, { redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs), headers: { 'X-API-Key': this.#key } });
      if (!response.ok) throw new Error('MEMORY_IDENTITY_UNAVAILABLE');
      const identity = object(await response.json());
      if (identity.auth_mode !== 'api_key' || identity.role !== 'user'
          || identity.account_id !== this.owner.accountId || identity.user_id !== this.owner.userId) {
        throw new Error('MEMORY_CREDENTIAL_OWNER_MISMATCH');
      }
    })();
    try { await this.#identity; }
    catch (error) { this.#identity = undefined; throw error; }
  }

  #check(operation: Readonly<Operation>): void {
    if (!sameOwner(operation.owner, this.owner) || operation.scope !== this.scope) throw new Error('MEMORY_OWNER_MISMATCH');
    identifier(operation.remoteSessionId);
  }

  #memoryUri(uri: unknown): string {
    if (typeof uri !== 'string' || /[%?#\\\x00-\x1f]/.test(uri)) throw new Error('INVALID_MEMORY_REFERENCE');
    const segments = uri.split('/');
    const root = this.#root.split('/');
    if (segments.length <= root.length || !root.every((segment, i) => segments[i] === segment)
        || segments.slice(root.length).some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('MEMORY_SCOPE_MISMATCH');
    }
    return uri;
  }

  async #request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.#baseUrl}/api/v1${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
      headers: { 'X-API-Key': this.#key, 'Content-Type': 'application/json',
        ...(this.scope ? { 'X-OpenViking-Actor-Peer': this.scope } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`MEMORY_HTTP_${response.status}`);
    const envelope = object(await response.json());
    if (envelope.status !== 'ok') throw new Error('MEMORY_REMOTE_ERROR');
    return envelope.result;
  }

  async createSession(id: string): Promise<void> {
    await this.verifyIdentity();
    const result = object(await this.#request('/sessions', 'POST', {
      session_id: identifier(id), auto_commit_policy: null,
    }));
    if (result.session_id !== id) throw new Error('MEMORY_SESSION_MISMATCH');
  }

  async sessionExists(id: string): Promise<boolean> {
    await this.verifyIdentity();
    try {
      const result = await this.#sdk.getSession(identifier(id), false);
      if (result.session_id !== id) throw new Error('MEMORY_SESSION_MISMATCH');
      return true;
    } catch (error) {
      if (isOpenVikingError(error) && error.statusCode === 404) return false;
      throw new Error('MEMORY_SESSION_UNAVAILABLE');
    }
  }

  async append(operation: Readonly<Operation>): Promise<void> {
    this.#check(operation);
    await this.verifyIdentity();
    if (!operation.payload) throw new Error('MEMORY_SOURCE_UNAVAILABLE');
    await this.#request(`/sessions/${operation.remoteSessionId}/messages`, 'POST', {
      role: 'user', content: operation.payload, source_message_ids: [operation.id],
    });
  }

  async hasSource(operation: Readonly<Operation>): Promise<boolean> {
    this.#check(operation);
    await this.verifyIdentity();
    return sourcePresent(await this.#sdk.getSessionContext(operation.remoteSessionId), operation.id);
  }

  async commit(id: string): Promise<{ taskId: string; archiveId?: string }> {
    await this.verifyIdentity();
    const result = object(await this.#request(`/sessions/${identifier(id)}/commit`, 'POST', { keep_recent_count: 0 }));
    return { taskId: identifier(result.task_id) };
  }

  async findCommit(id: string): Promise<{ taskId: string } | null> {
    await this.verifyIdentity();
    const tasks = await this.#sdk.listTasks({ taskType: 'session_commit', resourceId: identifier(id), limit: 200 });
    if (tasks.length !== 1) return null;
    const task = object(tasks[0]);
    if (task.resource_id !== id || task.task_type !== 'session_commit') throw new Error('MEMORY_TASK_MISMATCH');
    return { taskId: identifier(task.task_id) };
  }

  async inspect(operation: Readonly<Operation>): ReturnType<DeliveryTransport['inspect']> {
    this.#check(operation);
    await this.verifyIdentity();
    const task = object(await this.#sdk.getTask(identifier(operation.taskId)));
    if (task.resource_id !== operation.remoteSessionId || task.task_id !== operation.taskId
        || task.task_type !== 'session_commit') throw new Error('MEMORY_TASK_MISMATCH');
    if (task.status === 'failed' || task.status === 'cancelled') return { status: 'failed', code: 'MEMORY_EXTRACTION_FAILED' };
    if (task.status !== 'completed') return { status: 'processing' };
    const result = object(task.result);
    if (result.session_id !== operation.remoteSessionId) throw new Error('MEMORY_SESSION_MISMATCH');
    const sessionRoot = `viking://user/${this.owner.userId}/sessions/${operation.remoteSessionId}/history/`;
    if (typeof result.archive_uri !== 'string' || !result.archive_uri.startsWith(sessionRoot)) throw new Error('MEMORY_ARCHIVE_MISMATCH');
    const archiveId = identifier(result.archive_uri.slice(sessionRoot.length));
    const archive = await this.#sdk.getSessionArchive(operation.remoteSessionId, archiveId);
    if (archive.archive_id !== archiveId || !sourcePresent(archive, operation.id)) throw new Error('MEMORY_SOURCE_NOT_PROVEN');
    if (result.memory_diff_uri !== `${result.archive_uri}/memory_diff.json`) throw new Error('MEMORY_DIFF_MISMATCH');
    const diff = object(JSON.parse(await this.#sdk.read(result.memory_diff_uri as string)));
    if (diff.archive_uri !== result.archive_uri) throw new Error('MEMORY_DIFF_MISMATCH');
    const operations = object(diff.operations);
    if (!Array.isArray(operations.adds) || !Array.isArray(operations.updates)) throw new Error('INVALID_MEMORY_RESPONSE');
    const changes = [...operations.adds, ...operations.updates].map(object);
    if (!changes.length) return { status: 'failed', code: 'MEMORY_NO_EXTRACTED_FACT' };
    const recalled = await this.recall(operation.payload ?? '', changes.length);
    const memoryUris: string[] = [];
    for (const change of changes) {
      const uri = this.#memoryUri(change.uri);
      const content = await this.#sdk.read(uri);
      const expected = change.after ?? change.content;
      if (typeof expected !== 'string' || !expected.trim() || content.trim() !== expected.trim()) continue;
      if (recalled.some(memory => memory.uri === uri)) memoryUris.push(uri);
    }
    return memoryUris.length ? { status: 'ready', archiveId, memoryUris } : { status: 'processing' };
  }

  /** Transport only: the host must persist its governance barrier and drain writers first. */
  async replaceMemory(uri: string, content: string): Promise<void> {
    const target = this.#documentUri(uri);
    if (typeof content !== 'string' || !content.trim()) throw new Error('INVALID_MEMORY_REPLACEMENT');
    await this.verifyIdentity();
    await this.#sdk.write(target, content, { mode: 'replace', wait: true,
      timeout: Math.ceil(this.#timeoutMs / 1000) });
    // A successful HTTP reply alone is not proof that the replacement is visible.
    if (await this.#sdk.read(target) !== content) throw new Error('MEMORY_REPLACEMENT_UNCONFIRMED');
  }

  /** Remove one document, never a caller-selected directory or derived metadata file. */
  async removeMemory(uri: string): Promise<void> {
    const target = this.#documentUri(uri);
    await this.verifyIdentity();
    try {
      await this.#sdk.remove(target, { recursive: false, wait: true,
        timeout: Math.ceil(this.#timeoutMs / 1000) });
    } catch (error) {
      if (!isOpenVikingError(error) || error.statusCode !== 404) throw error;
    }
    try { await this.#sdk.read(target); }
    catch (error) {
      if (isOpenVikingError(error) && error.statusCode === 404) return;
      throw error;
    }
    throw new Error('MEMORY_DELETION_UNCONFIRMED');
  }

  /** A source can be removed only through an owner/scope-bound durable operation. */
  async removeSource(operation: Readonly<Operation>): Promise<void> {
    this.#check(operation);
    await this.verifyIdentity();
    try { await this.#sdk.deleteSession(operation.remoteSessionId); }
    catch (error) {
      if (!isOpenVikingError(error) || error.statusCode !== 404) throw error;
    }
    if (await this.sessionExists(operation.remoteSessionId)) throw new Error('MEMORY_SOURCE_DELETION_UNCONFIRMED');
  }

  #documentUri(uri: unknown): string {
    const target = this.#memoryUri(uri);
    const relative = target.slice(this.#root.length + 1);
    if (!relative.endsWith('.md') || relative.split('/').some(segment => segment.startsWith('.'))) {
      throw new Error('INVALID_MEMORY_DOCUMENT');
    }
    return target;
  }

  async readMemory(uri: string): Promise<string> {
    const target = this.#memoryUri(uri);
    await this.verifyIdentity();
    return this.#sdk.read(target);
  }

  async recall(query: string, limit: number, signal?: AbortSignal): Promise<RecalledMemory[]> {
    if (!query.trim() || !Number.isSafeInteger(limit) || limit <= 0) return [];
    signal?.throwIfAborted();
    await this.verifyIdentity();
    signal?.throwIfAborted();
    const result = await this.#sdk.find(query, { targetUri: this.#root, limit, level: [2] });
    signal?.throwIfAborted();
    return (result.memories ?? []).flatMap(value => {
      const memory = object(value);
      const uri = this.#memoryUri(memory.uri);
      return typeof memory.abstract === 'string' && typeof memory.score === 'number'
        ? [{ uri, text: memory.abstract, score: memory.score }] : [];
    });
  }
}
