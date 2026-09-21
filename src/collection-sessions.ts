import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, isAbsolute, relative, resolve } from 'node:path';
import { SessionManager, parseSessionEntries, CURRENT_SESSION_VERSION, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CollectionBoundary, StateStore } from './types.js';

type Session = Pick<ExtensionContext['sessionManager'], 'getSessionId' | 'getSessionFile' | 'getBranch'>;

/** Owner-private source references only. Never copies or edits pi conversation data. */
export class CollectionSessionRegistry {
  readonly #live = new Map<string, WeakRef<Session>>();
  constructor(private readonly options: { store: StateStore; sessionRoot: string }) {
    if (!isAbsolute(options.sessionRoot)) throw new Error('INVALID_COLLECTION_SESSION_ROOT');
  }

  async #path(path: string, allowMissing: boolean, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const root = await realpath(this.options.sessionRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077)) {
      throw new Error('UNPROTECTED_COLLECTION_SESSION_ROOT');
    }
    if (!isAbsolute(path)) throw new Error('INVALID_COLLECTION_SESSION_PATH');
    // Canonicalize the parent, then refuse a symlink at the file itself. The root
    // is host configuration and must already be outside isolated tool access.
    const candidate = resolve(await realpath(dirname(path)), basename(path));
    const inside = relative(root, candidate);
    if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) throw new Error('FOREIGN_COLLECTION_SESSION');
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('INVALID_COLLECTION_SESSION_FILE');
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    signal?.throwIfAborted();
    return candidate;
  }

  /** Called by the trusted extension context before a new request. New pi files
   * may not be flushed yet; the reference is durable before collection begins. */
  async register(session: Session, signal?: AbortSignal): Promise<void> {
    const file = session.getSessionFile();
    if (!file) throw new Error('PERSISTENT_COLLECTION_SESSION_REQUIRED');
    const path = await this.#path(file, true, signal);
    const id = session.getSessionId();
    if (!id) throw new Error('INVALID_COLLECTION_SESSION_ID');
    await this.options.store.transact(state => {
      signal?.throwIfAborted();
      state.collectionSessionFiles ??= {};
      const existing = state.collectionSessionFiles[id];
      if (existing && existing !== path) throw new Error('COLLECTION_SESSION_REBOUND');
      state.collectionSessionFiles[id] = path;
    }, signal);
    this.#live.set(id, new WeakRef(session));
  }

  async resolveSession(id: string, signal?: AbortSignal): Promise<SessionManager> {
    const state = await this.options.store.read(signal);
    const file = state.collectionSessionFiles?.[id];
    if (!file) throw new Error('MEMORY_SOURCE_UNAVAILABLE');
    const path = await this.#path(file, false, signal);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.uid !== process.getuid?.()) throw new Error('MEMORY_SOURCE_UNAVAILABLE');
      const text = await handle.readFile({ encoding: 'utf8', signal });
      const entries = parseSessionEntries(text);
      const header = entries[0];
      if (!header || header.type !== 'session' || header.id !== id || header.version !== CURRENT_SESSION_VERSION
        || entries.length !== text.split('\n').filter(line => line.trim()).length) throw new Error('MEMORY_SOURCE_UNAVAILABLE');
      const seen = new Set<string>();
      for (const entry of entries.slice(1)) {
        if (entry.type === 'session' || !entry.id || seen.has(entry.id)
          || (entry.parentId !== null && !seen.has(entry.parentId)) || !Number.isFinite(Date.parse(entry.timestamp))) {
          throw new Error('MEMORY_SOURCE_UNAVAILABLE');
        }
        seen.add(entry.id);
      }
      signal?.throwIfAborted();
      // The public in-memory constructor retains pi's branch semantics while
      // preventing open() from repairing empty files or migrating old sources.
      return SessionManager.inMemory(this.options.sessionRoot, undefined, entries);
    } catch { throw new Error('MEMORY_SOURCE_UNAVAILABLE'); }
    finally { await handle.close(); }
  }

  /** Snapshot current persisted leaves for a new grant/resume boundary. Missing
   * registered files represent never-flushed empty sessions only when no request
   * has recorded sources; missing collected history fails closed. */
  async boundaries(signal?: AbortSignal): Promise<CollectionBoundary[]> {
    const state = await this.options.store.read(signal);
    const boundaries: CollectionBoundary[] = [];
    for (const id of Object.keys(state.collectionSessionFiles ?? {})) {
      let entryId: string | null = null;
      try {
        await this.#path(state.collectionSessionFiles![id], false, signal);
        const live = this.#live.get(id)?.deref();
        entryId = (live?.getSessionId() === id ? live : await this.resolveSession(id, signal)).getBranch().at(-1)?.id ?? null;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
          || Object.values(state.collectionRequests ?? {}).some(request => request.sessionId === id && request.sourceEntries.length)) throw error;
      }
      boundaries.push({ sessionId: id, entryId, branchId: entryId });
    }
    return boundaries;
  }
}
