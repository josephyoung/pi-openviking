import { checkedOwner, type Owner } from './types.js';

export function checkedScope(scope: string | null): string | null {
  if (scope !== null && (typeof scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(scope))) {
    throw new Error('INVALID_MEMORY_SCOPE');
  }
  return scope;
}

export function memoryRoot(owner: Owner, scope: string | null): string {
  checkedOwner(owner); checkedScope(scope);
  return `viking://user/${owner.userId}/${scope === null ? '' : `peers/${scope}/`}memories`;
}

export function checkedMemoryUri(owner: Owner, scope: string | null, uri: unknown): string {
  const root = `${memoryRoot(owner, scope)}/`;
  if (typeof uri !== 'string' || /[%?#\\\x00-\x1f]/.test(uri)) throw new Error('INVALID_MEMORY_REFERENCE');
  if (!uri.startsWith(root)
    || uri.slice(root.length).split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('MEMORY_SCOPE_MISMATCH');
  }
  return uri;
}

export function checkedMemoryDocumentUri(owner: Owner, scope: string | null, uri: unknown): string {
  const target = checkedMemoryUri(owner, scope, uri);
  const relative = target.slice(memoryRoot(owner, scope).length + 1);
  if (!relative.endsWith('.md') || relative.split('/').some(segment => segment.startsWith('.'))) {
    throw new Error('INVALID_MEMORY_DOCUMENT');
  }
  return target;
}

export function isMemoryDocumentUri(owner: Owner, scope: string | null, uri: unknown): uri is string {
  try { checkedMemoryDocumentUri(owner, scope, uri); return true; }
  catch { return false; }
}
