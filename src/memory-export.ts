import { governancePending } from './governance.js';
import { checkedOwner, sameOwner, type Owner, type StateStore } from './types.js';
import { checkedScope, isMemoryDocumentUri } from './memory-reference.js';

export interface MemoryExportTransport {
  readonly owner: Owner;
  readonly scope: string | null;
  listMemoryDocuments(): Promise<string[]>;
  memoryDocumentSize(uri: string): Promise<number>;
  readMemoryLimited(uri: string, maxBytes: number): Promise<string>;
}

export interface ExportedMemory {
  uri: string;
  content: string;
  sources: Array<{
    kind: 'explicit' | 'automatic';
    status: 'current' | 'preserved' | 'revoked';
    sessionId: string;
    entryId: string;
    createdAt: string;
  }>;
  revisions: Array<{ kind: 'correct' | 'forget'; revision: number; createdAt: string; completedAt?: string }>;
}

interface Cursor {
  version: 1;
  owner: Owner;
  scope: string | null;
  revision: number;
  after: string;
}

function decodeCursor(value: string): Cursor {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('INVALID_MEMORY_EXPORT_CURSOR');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const cursor = parsed as Cursor;
    if (cursor.version !== 1 || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0
      || typeof cursor.after !== 'string' || !cursor.after || cursor.scope !== null
      && (typeof cursor.scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(cursor.scope))) throw new Error();
    checkedOwner(cursor.owner);
    if (Buffer.from(JSON.stringify(cursor)).toString('base64url') !== value) throw new Error();
    return cursor;
  } catch { throw new Error('INVALID_MEMORY_EXPORT_CURSOR'); }
}

/** Host-owned, read-only export. Model or browser parameters cannot select an owner or project. */
export class MemoryExportService {
  constructor(private readonly store: StateStore, private readonly transport: MemoryExportTransport,
    private readonly maxDocumentBytes = 1048576, private readonly maxPageBytes = 2097152) {
    checkedOwner(store.owner);
    if (!sameOwner(store.owner, transport.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    checkedScope(transport.scope);
    if (![maxDocumentBytes, maxPageBytes].every(value => Number.isSafeInteger(value) && value > 0)
      || maxDocumentBytes > 2097152
      || maxPageBytes < maxDocumentBytes) throw new Error('INVALID_MEMORY_EXPORT_LIMIT');
  }

  async page(input: { limit: number; cursor?: string; maxBytes?: number }): Promise<{ items: ExportedMemory[]; nextCursor?: string }> {
    if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('INVALID_MEMORY_EXPORT_LIMIT');
    }
    const budget = input.maxBytes ?? this.maxPageBytes;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > this.maxPageBytes) throw new Error('INVALID_MEMORY_EXPORT_LIMIT');
    const start = await this.store.read();
    if (start.retirement) throw new Error('MEMORY_RETIRED');
    if (governancePending(start, this.transport.scope)) throw new Error('MEMORY_GOVERNANCE_PENDING');
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (cursor && (!sameOwner(cursor.owner, this.store.owner) || cursor.scope !== this.transport.scope
      || cursor.revision !== start.revision)) throw new Error('INVALID_MEMORY_EXPORT_CURSOR');
    const uris = await this.transport.listMemoryDocuments();
    if (!Array.isArray(uris) || uris.some((uri, index) => typeof uri !== 'string'
      || !isMemoryDocumentUri(this.store.owner, this.transport.scope, uri)
      || index > 0 && uri <= uris[index - 1])) {
      throw new Error('INVALID_MEMORY_RESPONSE');
    }
    const position = cursor ? uris.indexOf(cursor.after) : -1;
    if (cursor && position < 0) throw new Error('INVALID_MEMORY_EXPORT_CURSOR');
    const selected: string[] = [];
    let declaredBytes = 0;
    for (const uri of uris.slice(position + 1, position + 1 + input.limit)) {
      const size = await this.transport.memoryDocumentSize(uri);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('INVALID_MEMORY_RESPONSE');
      if (size > this.maxDocumentBytes || size > budget && !selected.length) throw new Error('MEMORY_EXPORT_TOO_LARGE');
      if (declaredBytes + size > budget) break;
      declaredBytes += size; selected.push(uri);
    }
    const items: ExportedMemory[] = [];
    let actualBytes = 0;
    for (const uri of selected) {
      if (actualBytes >= budget) break;
      let content: string;
      try { content = await this.transport.readMemoryLimited(uri,
        Math.min(this.maxDocumentBytes, budget - actualBytes)); }
      catch (error) {
        if (items.length && error instanceof Error && error.message === 'MEMORY_EXPORT_TOO_LARGE') break;
        throw error;
      }
      if (typeof content !== 'string') throw new Error('INVALID_MEMORY_RESPONSE');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > this.maxDocumentBytes) throw new Error('MEMORY_EXPORT_TOO_LARGE');
      const sources = Object.values(start.operations).filter(operation => operation.scope === this.transport.scope
        && operation.memoryUris?.includes(uri) && (operation.phase === 'ready'
          || operation.phase === 'blocked' && operation.errorCode === 'MEMORY_SOURCE_REVOKED')).map(operation => ({
        kind: operation.kind, status: operation.phase === 'ready' ? 'current' as const
          : Object.values(start.governance?.jobs ?? {}).some(job => job.phase === 'complete'
            && !job.supersededBy && job.operationIds.includes(operation.id)
            && job.preservedUris?.includes(uri)) ? 'preserved' as const : 'revoked' as const,
        sessionId: operation.source.sessionId,
        entryId: operation.source.entryId, createdAt: operation.createdAt,
      }));
      for (const source of sources) {
        // Explicit saves use `<pi-entry-id>:<content-sha256>`; collection
        // sources use the plain Pi entry ID. Both are created by this package.
        if (typeof source.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(source.sessionId)
          || typeof source.entryId !== 'string'
          || !(/^[A-Za-z0-9_-]{1,128}$/.test(source.entryId)
            || /^[A-Za-z0-9_-]{1,63}:[a-f0-9]{64}$/.test(source.entryId))
          || !Number.isFinite(Date.parse(source.createdAt))) throw new Error('INVALID_MEMORY_SOURCE');
      }
      const revisions = Object.values(start.governance?.jobs ?? {}).filter(job =>
        job.phase === 'complete' && !job.supersededBy && job.scope === this.transport.scope
        && (job.kind === 'correct' || job.kind === 'forget') && job.memoryUris.includes(uri))
        .map(job => ({ kind: job.kind as 'correct' | 'forget', revision: job.revision,
          createdAt: job.createdAt, completedAt: job.completedAt }));
      const item = { uri, content, sources, revisions };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
      if (actualBytes + itemBytes > budget) {
        if (!items.length) throw new Error('MEMORY_EXPORT_TOO_LARGE');
        break;
      }
      actualBytes += itemBytes;
      items.push(item);
    }
    const finish = await this.store.read();
    if (finish.revision !== start.revision || governancePending(finish, this.transport.scope)) {
      throw new Error('MEMORY_EXPORT_CHANGED');
    }
    const next = () => {
      const last = items.at(-1)?.uri;
      return last && position + 1 + items.length < uris.length
        ? Buffer.from(JSON.stringify({ version: 1, owner: this.store.owner, scope: this.transport.scope,
          revision: start.revision, after: last } satisfies Cursor)).toString('base64url') : undefined;
    };
    let nextCursor = next();
    while (Buffer.byteLength(JSON.stringify({ items, nextCursor }), 'utf8') > budget) {
      if (!items.length) throw new Error('MEMORY_EXPORT_TOO_LARGE');
      items.pop(); nextCursor = next();
    }
    return { items, nextCursor };
  }
}
