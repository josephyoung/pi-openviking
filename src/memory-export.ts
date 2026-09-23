import { governancePending } from './governance.js';
import { checkedOwner, sameOwner, type Owner, type StateStore } from './types.js';

export interface MemoryExportTransport {
  readonly owner: Owner;
  readonly scope: string | null;
  listMemoryDocuments(): Promise<string[]>;
  readMemory(uri: string): Promise<string>;
}

export interface ExportedMemory {
  uri: string;
  content: string;
  sources: Array<{
    kind: 'explicit' | 'automatic';
    sessionId: string;
    entryId: string;
    createdAt: string;
  }>;
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
  constructor(private readonly store: StateStore, private readonly transport: MemoryExportTransport) {
    checkedOwner(store.owner);
    if (!sameOwner(store.owner, transport.owner)) throw new Error('MEMORY_OWNER_MISMATCH');
    if (transport.scope !== null && (typeof transport.scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(transport.scope))) {
      throw new Error('INVALID_MEMORY_SCOPE');
    }
  }

  async page(input: { limit: number; cursor?: string }): Promise<{ items: ExportedMemory[]; nextCursor?: string }> {
    if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('INVALID_MEMORY_EXPORT_LIMIT');
    }
    const start = await this.store.read();
    if (governancePending(start, this.transport.scope)) throw new Error('MEMORY_GOVERNANCE_PENDING');
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (cursor && (!sameOwner(cursor.owner, this.store.owner) || cursor.scope !== this.transport.scope
      || cursor.revision !== start.revision)) throw new Error('INVALID_MEMORY_EXPORT_CURSOR');
    const uris = await this.transport.listMemoryDocuments();
    const root = `viking://user/${this.store.owner.userId}/${this.transport.scope === null ? '' : `peers/${this.transport.scope}/`}memories/`;
    if (!Array.isArray(uris) || uris.some((uri, index) => typeof uri !== 'string'
      || !uri.startsWith(root) || /[%?#\\\x00-\x1f]/.test(uri) || !uri.endsWith('.md')
      || uri.slice(root.length).split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))
      || index > 0 && uri <= uris[index - 1])) {
      throw new Error('INVALID_MEMORY_RESPONSE');
    }
    const position = cursor ? uris.indexOf(cursor.after) : -1;
    if (cursor && position < 0) throw new Error('INVALID_MEMORY_EXPORT_CURSOR');
    const selected = uris.slice(position + 1, position + 1 + input.limit);
    const items: ExportedMemory[] = [];
    for (const uri of selected) {
      const content = await this.transport.readMemory(uri);
      if (typeof content !== 'string') throw new Error('INVALID_MEMORY_RESPONSE');
      const sources = Object.values(start.operations).filter(operation => operation.scope === this.transport.scope
        && operation.memoryUris?.includes(uri) && operation.phase === 'ready').map(operation => ({
        kind: operation.kind, sessionId: operation.source.sessionId,
        entryId: operation.source.entryId, createdAt: operation.createdAt,
      }));
      for (const source of sources) {
        if (![source.sessionId, source.entryId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))
          || !Number.isFinite(Date.parse(source.createdAt))) throw new Error('INVALID_MEMORY_SOURCE');
      }
      items.push({ uri, content, sources });
    }
    const finish = await this.store.read();
    if (finish.revision !== start.revision || governancePending(finish, this.transport.scope)) {
      throw new Error('MEMORY_EXPORT_CHANGED');
    }
    const last = selected.at(-1);
    const nextCursor = last && position + 1 + selected.length < uris.length
      ? Buffer.from(JSON.stringify({ version: 1, owner: this.store.owner, scope: this.transport.scope,
        revision: start.revision, after: last } satisfies Cursor)).toString('base64url') : undefined;
    return { items, nextCursor };
  }
}
