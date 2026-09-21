import { createHash } from 'node:crypto';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { Source } from './types.js';

/** Shared receipt identity for the explicit tool and collection's verifier. */
export function explicitSaveSource(sessionId: string, entry: SessionMessageEntry, content: string): Source {
  return {
    sessionId,
    entryId: `${entry.id}:${createHash('sha256').update(content).digest('hex')}`,
    branchId: entry.id,
    contentVersion: createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
  };
}
