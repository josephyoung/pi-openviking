import { createHash } from 'node:crypto';
import { lintSource } from '@secretlint/core';
import { rules } from '@secretlint/secretlint-rule-preset-recommend';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CollectionRequest, CollectionSource, StateStore } from './types.js';

// Conversation text is never allowed to suppress a scanner finding.
const scanners = rules.filter(rule => rule.meta.id !== '@secretlint/secretlint-rule-filter-comments')
  .map(rule => ({ id: rule.meta.id, rule }));

/** Vendor-independent credential declarations supplement the vendor rule set.
 * These detect disclosures, not every mention of credential management. */
const credentialDeclarations = [
  /-----BEGIN[ \t]+(?:[A-Z0-9]+[ \t]+)*PRIVATE[ \t]+KEY(?:[ \t]+BLOCK)?-----/u,
  /(?:\b(?:[a-z][a-z0-9]*[_-])*(?:password|passwd|secret|token|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key)\b|密码|口令|密钥|令牌|验证码)\s*["']?\s*(?:[:=：]|\bis\b|是|为)\s*\S+/iu,
  /\b(?:authorization|proxy-authorization)\s*:\s*\S+/iu,
  /\b(?:cookie|set-cookie)\s*:\s*\S+/iu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/u,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
];

export interface CollectionInputMessage {
  source: CollectionSource;
  /** An assistant reference is never itself an authorized fact. */
  role: 'user' | 'assistant_reference';
  text: string;
}
export type CollectionInputResult =
  | { status: 'ready'; request: CollectionRequest; messages: CollectionInputMessage[]; excludedEntries: string[] }
  | { status: 'blocked'; code: 'MEMORY_COLLECTION_NOT_AUTHORIZED' | 'MEMORY_SOURCE_UNAVAILABLE' | 'MEMORY_COLLECTION_INPUT_LIMIT' | 'MEMORY_COLLECTION_SCAN_FAILED' };

type Session = Pick<ExtensionContext['sessionManager'], 'getSessionId' | 'getEntry'>;

/** Local-only screening; successful screening is not confirmation or permission to send. */
export class CollectionInputBuilder {
  constructor(private readonly options: {
    store: StateStore;
    scope?: string | null;
    maxInputBytes: number;
    /** Trusted host snapshot. Never persisted, returned, or supplied by model input. */
    sensitiveValues?: () => readonly string[] | Promise<readonly string[]>;
  }) {
    if (!Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1) throw new Error('INVALID_COLLECTION_LIMIT');
  }

  async build(requestId: string, session: Session): Promise<CollectionInputResult> {
    try {
      const state = await this.options.store.read();
      const request = state.collectionRequests?.[requestId];
      const scope = this.options.scope ?? null;
      const permitted = (current: typeof state) => request && current.collectionRequests?.[requestId]?.phase === 'settled'
        && request.sessionId === session.getSessionId() && request.scope === scope
        && current.authorization.enabled && current.authorization.automaticCollection
        && current.authorization.epoch === request.authorizationEpoch
        && current.authorization.collectionConsent?.revision === request.collectionRevision
        && current.authorization.collectionConsent.scope === scope;
      if (!request || !permitted(state)) return { status: 'blocked', code: 'MEMORY_COLLECTION_NOT_AUTHORIZED' };
      const secrets = [...(await this.options.sensitiveValues?.() ?? [])];
      const messages: CollectionInputMessage[] = [];
      const excludedEntries: string[] = [];
      let bytes = 0;
      for (const id of request.sourceEntries) {
        const entry = session.getEntry(id);
        if (!entry || entry.type !== 'message') return { status: 'blocked', code: 'MEMORY_SOURCE_UNAVAILABLE' };
        const message = entry.message;
        if (message.role !== 'user' && message.role !== 'assistant') { excludedEntries.push(id); continue; }
        if (message.role === 'assistant' && message.stopReason !== 'stop') { excludedEntries.push(id); continue; }
        const text = typeof message.content === 'string' ? message.content : message.content
          .filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (!text.trim()) { excludedEntries.push(id); continue; }
        bytes += Buffer.byteLength(text);
        // Do not silently truncate a request into a different apparent meaning.
        if (bytes > this.options.maxInputBytes) return { status: 'blocked', code: 'MEMORY_COLLECTION_INPUT_LIMIT' };
        const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '');
        if (secrets.some(secret => secret.length > 0 && (text.includes(secret) || normalized.includes(secret.normalize('NFKC'))))
          || credentialDeclarations.some(pattern => pattern.test(normalized))) {
          excludedEntries.push(id); continue;
        }
        const scan = await lintSource({ source: { content: normalized, contentType: 'text', filePath: 'conversation.txt' },
          options: { noPhysicFilePath: true, maskSecrets: true, config: { rules: scanners } } });
        if (scan.messages.length > 0) { excludedEntries.push(id); continue; }
        messages.push({ source: { sessionId: request.sessionId, entryId: entry.id,
          entryTimestamp: entry.timestamp, branchId: request.settledEntryId!,
          contentVersion: createHash('sha256').update(JSON.stringify(message)).digest('hex') },
          role: message.role === 'user' ? 'user' : 'assistant_reference', text });
      }
      // Scanning/host secret discovery must not bypass a concurrent pause/revoke.
      if (!permitted(await this.options.store.read())) return { status: 'blocked', code: 'MEMORY_COLLECTION_NOT_AUTHORIZED' };
      return { status: 'ready', request: structuredClone(request), messages, excludedEntries };
    } catch {
      // Scanner diagnostics may contain source text. Do not propagate their cause.
      return { status: 'blocked', code: 'MEMORY_COLLECTION_SCAN_FAILED' };
    }
  }
}
