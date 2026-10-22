import { createHash } from 'node:crypto';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { Source } from './types.js';

/** Preserve pre-upgrade receipt identities without matching any source text. */
export function normalizeSaveContent(content: string): string {
  return content.trim().normalize('NFC');
}

/** Shared receipt identity for tool saves and collection's verifier.
 * The entry is the initiating user-turn anchor, NOT verbatim content evidence.
 * Keep this identity stable for existing receipts, revocation and recovery.
 */
export function explicitSaveSource(sessionId: string, entry: SessionMessageEntry, content: string): Source {
  return {
    sessionId,
    entryId: `${entry.id}:${createHash('sha256').update(normalizeSaveContent(content)).digest('hex')}`,
    branchId: entry.id,
    contentVersion: createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
  };
}
