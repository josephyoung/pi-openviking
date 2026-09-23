import { isTaskFactProjection } from './task-facts.js';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { flock } from 'fs-ext';
import { checkedOwner, sameOwner, isCollectionSource, type Owner, type OwnerState, type StateStore } from './types.js';
import { isMemoryDocumentUri } from './memory-reference.js';

async function lock(fd: number, operation: 'ex' | 'un', signal?: AbortSignal): Promise<void> {
  // Blocking flock consumes a libuv worker: enough waiting writers can starve
  // the current holder's fsync. Nonblocking acquisition keeps that pool free.
  for (;;) {
    signal?.throwIfAborted();
    try {
      await new Promise<void>((accept, reject) => flock(fd, operation === 'ex' ? 'exnb' : 'un',
        error => error ? reject(error) : accept()));
      return;
    } catch (error) {
      if (operation !== 'ex' || !['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(10, undefined, { signal });
    }
  }
}

function verify(state: OwnerState, owner: Owner): void {
  if (state?.version !== 1 || !state.owner || !sameOwner(state.owner, owner)
      || !Number.isSafeInteger(state.revision) || state.revision < 0
      || !state.authorization || typeof state.authorization.enabled !== 'boolean'
      || typeof state.authorization.automaticCollection !== 'boolean'
      || !Number.isSafeInteger(state.authorization.epoch)
      || !state.operations || Array.isArray(state.operations)) {
    throw new Error('INVALID_MEMORY_STATE');
  }
  if (state.retirement !== undefined && (!state.retirement
    || !/^[a-f0-9-]{36}$/.test(state.retirement.id)
    || !['requested', 'remote_cleared'].includes(state.retirement.phase)
    || !Number.isFinite(Date.parse(state.retirement.requestedAt))
    || state.authorization.enabled || state.authorization.automaticCollection)) {
    throw new Error('INVALID_MEMORY_RETIREMENT');
  }
  if (state.governance !== undefined) {
    const governance = state.governance;
    if (!governance || !Number.isSafeInteger(governance.revision) || governance.revision < 1
      || !governance.jobs || typeof governance.jobs !== 'object' || Array.isArray(governance.jobs)) {
      throw new Error('INVALID_MEMORY_GOVERNANCE');
    }
    const revisions = new Set<number>();
    const pendingScopes = new Set<string | null>();
    for (const [id, job] of Object.entries(governance.jobs)) {
      if (!job || job.id !== id || !/^[a-f0-9-]{36}$/.test(id)
        || !Number.isSafeInteger(job.revision) || job.revision < 1 || job.revision > governance.revision
        || revisions.has(job.revision) || !['forget', 'correct', 'clear'].includes(job.kind)
        || !['draining', 'applying', 'complete'].includes(job.phase)
        || (job.scope !== null && (typeof job.scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(job.scope)))
        || (job.errorCode !== undefined && (typeof job.errorCode !== 'string' || !/^MEMORY_[A-Z_]+$/.test(job.errorCode)))
        || (job.completedAt !== undefined && (job.phase !== 'complete' || !Number.isFinite(Date.parse(job.completedAt))))
        || (job.supersededBy !== undefined && (job.kind === 'clear' || job.phase !== 'complete'
          || state.governance?.jobs[job.supersededBy]?.kind !== 'clear'
          || state.governance.jobs[job.supersededBy].scope !== job.scope
          || state.governance.jobs[job.supersededBy].revision <= job.revision))
        || (job.cancelledByRetirement !== undefined && (job.cancelledByRetirement !== true
          || job.phase !== 'complete' || state.retirement?.phase !== 'remote_cleared'))
        || typeof job.createdAt !== 'string' || !Number.isFinite(Date.parse(job.createdAt))
        || !Array.isArray(job.sourceKeys) || new Set(job.sourceKeys).size !== job.sourceKeys.length
        || job.sourceKeys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))
        || (job.replaySourceKeys !== undefined && (job.kind === 'clear'
          || !Array.isArray(job.replaySourceKeys) || new Set(job.replaySourceKeys).size !== job.replaySourceKeys.length
          || job.replaySourceKeys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))))
        || !Array.isArray(job.operationIds) || new Set(job.operationIds).size !== job.operationIds.length
        || job.operationIds.some(operationId => typeof operationId !== 'string'
          || !state.operations[operationId] || state.operations[operationId].scope !== job.scope)
        || !Array.isArray(job.writerOperationIds) || new Set(job.writerOperationIds).size !== job.writerOperationIds.length
        || job.writerOperationIds.some(operationId => typeof operationId !== 'string'
          || !state.operations[operationId] || state.operations[operationId].scope !== job.scope)
        || (job.writerClassifications !== undefined && (job.kind === 'clear'
          || !job.writerClassifications || typeof job.writerClassifications !== 'object'
          || Array.isArray(job.writerClassifications)
          || Object.entries(job.writerClassifications).some(([operationId, decision]) =>
            !job.writerOperationIds.includes(operationId) || !['target', 'unrelated'].includes(decision))))
        || (job.mergedResolutions !== undefined && (job.kind === 'clear' || job.phase === 'complete'
          || !job.mergedResolutions || typeof job.mergedResolutions !== 'object'
          || Array.isArray(job.mergedResolutions)
          || Object.entries(job.mergedResolutions).some(([operationId, text]) =>
            job.writerClassifications?.[operationId] !== 'target'
            || !state.operations[operationId]?.memoryUris?.includes(job.memoryUris[0])
            || typeof text !== 'string' || !text.trim() || text.length > 16384)))
        || job.operationIds.some(operationId => !job.writerOperationIds.includes(operationId))
        || (job.collectionRequestIds !== undefined && (!Array.isArray(job.collectionRequestIds)
          || job.kind === 'clear' || new Set(job.collectionRequestIds).size !== job.collectionRequestIds.length
          || job.collectionRequestIds.some(requestId => typeof requestId !== 'string'
            || !state.collectionRequests?.[requestId] || state.collectionRequests[requestId].scope !== job.scope)))
        || !Array.isArray(job.memoryUris) || new Set(job.memoryUris).size !== job.memoryUris.length
        || (job.kind !== 'clear' && job.memoryUris.length !== 1)) throw new Error('INVALID_MEMORY_GOVERNANCE');
      if (job.memoryUris.some(uri => !isMemoryDocumentUri(owner, job.scope, uri))) {
        throw new Error('INVALID_MEMORY_GOVERNANCE');
      }
      const plan = job.selectivePlan;
      if (plan !== undefined && (job.kind === 'clear' || job.phase === 'complete'
        || plan.memoryUri !== job.memoryUris[0]
        || typeof plan.selectedText !== 'string' || !plan.selectedText.trim() || plan.selectedText.length > 16384
        || typeof plan.replacementText !== 'string' || plan.replacementText.length > 16384
        || (job.kind === 'correct' && (!plan.replacementText.trim() || plan.replacementText.includes(plan.selectedText)))
        || (job.kind === 'forget' && plan.replacementText !== ''))) throw new Error('INVALID_MEMORY_GOVERNANCE');
      revisions.add(job.revision);
      if (job.phase !== 'complete') {
        if (pendingScopes.has(job.scope)) throw new Error('INVALID_MEMORY_GOVERNANCE');
        pendingScopes.add(job.scope);
      }
    }
  }
  const consent = state.authorization.collectionConsent;
  if ((state.authorization.automaticCollection && !consent) || (consent !== undefined && (!consent
      || !Number.isSafeInteger(consent.revision) || consent.revision < 1
      || typeof consent.policyVersion !== 'string' || !consent.policyVersion.trim()
      || typeof consent.effectiveAt !== 'string' || !Number.isFinite(Date.parse(consent.effectiveAt))
      || (consent.scope !== null && (typeof consent.scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(consent.scope)))
      || !Array.isArray(consent.boundaries) || consent.boundaries.some(boundary => !boundary
        || typeof boundary.sessionId !== 'string' || !boundary.sessionId
        || ![boundary.entryId, boundary.branchId].every(id => id === null || (typeof id === 'string' && id.length > 0)))
      || new Set(consent.boundaries.map(boundary => boundary.sessionId)).size !== consent.boundaries.length))) {
    throw new Error('INVALID_COLLECTION_CONSENT');
  }
  if (state.collectionSessionFiles !== undefined && (!state.collectionSessionFiles
    || typeof state.collectionSessionFiles !== 'object' || Array.isArray(state.collectionSessionFiles)
    || Object.entries(state.collectionSessionFiles).some(([id, path]) => !id || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')))) {
    throw new Error('INVALID_COLLECTION_SESSION_REGISTRY');
  }
  if (state.collectionRequests !== undefined) {
    if (!state.collectionRequests || typeof state.collectionRequests !== 'object' || Array.isArray(state.collectionRequests)) {
      throw new Error('INVALID_COLLECTION_REQUEST');
    }
    for (const [id, request] of Object.entries(state.collectionRequests)) {
      if (!request || request.id !== id || !id || typeof request.sessionId !== 'string' || !request.sessionId
        || (request.baselineEntryId !== null && (typeof request.baselineEntryId !== 'string' || !request.baselineEntryId))
        || (request.scope !== null && (typeof request.scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.scope)))
        || !Number.isSafeInteger(request.authorizationEpoch) || request.authorizationEpoch < 0
        || !Number.isSafeInteger(request.collectionRevision) || request.collectionRevision < 1
        || !['running', 'settled', 'processed', 'discarded', 'blocked_by_pause', 'selection_failed'].includes(request.phase)
        || !Array.isArray(request.sourceEntries) || request.sourceEntries.some(entry => typeof entry !== 'string' || !entry)
        || new Set(request.sourceEntries).size !== request.sourceEntries.length
        || ![request.createdAt, request.updatedAt].every(time => typeof time === 'string' && Number.isFinite(Date.parse(time)))
        || (['settled', 'processed', 'selection_failed'].includes(request.phase) && (typeof request.settledEntryId !== 'string' || !request.settledEntryId || !request.sourceEntries.length))) {
        throw new Error('INVALID_COLLECTION_REQUEST');
      }
      if (request.completedAssistant !== undefined && (!isCollectionSource(request.completedAssistant)
        || request.completedAssistant.sessionId !== request.sessionId || request.completedAssistant.branchId !== request.settledEntryId
        || !request.sourceEntries.includes(request.completedAssistant.entryId))) throw new Error('INVALID_COLLECTION_COMPLETION');
      const reference = request.confirmationReference;
      if (reference !== undefined) {
        const prior = state.collectionRequests[reference?.requestId];
        if (!reference || typeof reference.requestId !== 'string' || !reference.requestId
          || typeof reference.entryId !== 'string' || !reference.entryId || !prior || prior.id === request.id
          || prior.scope !== request.scope
          || prior.authorizationEpoch !== request.authorizationEpoch || prior.collectionRevision !== request.collectionRevision
          || prior.completedAssistant?.entryId !== reference.entryId || !prior.sourceEntries.includes(reference.entryId)) throw new Error('INVALID_COLLECTION_REFERENCE');
      }
      if ((request.selectionAttempts !== undefined && (!Number.isSafeInteger(request.selectionAttempts) || request.selectionAttempts < 0))
        || (request.selectionNextAttemptAt !== undefined && (!Number.isSafeInteger(request.selectionNextAttemptAt) || request.selectionNextAttemptAt < 0))
        || (request.selectionErrorCode !== undefined && (typeof request.selectionErrorCode !== 'string' || !/^MEMORY_[A-Z_]+$/.test(request.selectionErrorCode)))
        || (request.selectionLease !== undefined && (!request.selectionLease || request.phase !== 'settled'
          || typeof request.selectionLease.id !== 'string' || !request.selectionLease.id
          || !Number.isSafeInteger(request.selectionLease.expiresAt) || request.selectionLease.expiresAt < 0))) {
        throw new Error('INVALID_COLLECTION_CLAIM');
      }
      if (request.phase === 'processed'  && (typeof request.selectionDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(request.selectionDigest) || !Array.isArray(request.operationIds)
        || new Set(request.operationIds).size !== request.operationIds.length
        || request.operationIds.some(operationId => typeof operationId !== 'string'
          || !/^[a-f0-9]{64}$/.test(operationId) || state.operations[operationId]?.kind !== 'automatic'
          || state.operations[operationId]?.scope !== request.scope))) {
        throw new Error('INVALID_COLLECTION_RECEIPT');
      }
    }
  }
  if (state.collectedSources !== undefined) {
    if (!state.collectedSources || typeof state.collectedSources !== 'object' || Array.isArray(state.collectedSources)) {
      throw new Error('INVALID_COLLECTION_LEDGER');
    }
    for (const [key, receipt] of Object.entries(state.collectedSources)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !receipt
        || typeof receipt.operationId !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.operationId)
        || typeof receipt.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.payloadDigest)
        || state.operations[receipt.operationId]?.kind !== 'automatic') {
        throw new Error('INVALID_COLLECTION_LEDGER');
      }
    }
  }
  for (const [id, operation] of Object.entries(state.operations)) {
    if (id !== operation.id || !operation.owner || !sameOwner(operation.owner, owner)) {
      throw new Error('MEMORY_OWNER_MISMATCH');
    }
    if (operation.reconciliationPhase !== undefined && !['queued', 'session_unknown', 'session_created',
      'message_unknown', 'message_delivered', 'commit_unknown', 'processing'].includes(operation.reconciliationPhase)) {
      throw new Error('INVALID_MEMORY_RECONCILIATION_PHASE');
    }
    if (operation.factDigest !== undefined && !/^[a-f0-9]{64}$/.test(operation.factDigest)) {
      throw new Error('INVALID_MEMORY_OPERATION');
    }
    if (operation.collectionSources !== undefined && (operation.kind !== 'automatic'
      || !Array.isArray(operation.collectionSources) || !operation.collectionSources.length
      || operation.collectionSources.some(source => !isCollectionSource(source)))) {
      throw new Error('INVALID_COLLECTION_PROVENANCE');
    }
    if (operation.collectionEvidence !== undefined && (operation.kind !== 'automatic'
      || !Array.isArray(operation.collectionEvidence) || !operation.collectionEvidence.length
      || operation.collectionEvidence.some(evidence => !evidence || !isCollectionSource(evidence.source)
        || (evidence.projection !== undefined && !isTaskFactProjection(evidence.projection))
        || typeof evidence.quoteDigest !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.quoteDigest)))) {
      throw new Error('INVALID_COLLECTION_PROVENANCE');
    }
    if (!['explicit', 'automatic'].includes(operation.kind) || (operation.kind === 'automatic'
      && (!Number.isSafeInteger(operation.collectionRevision) || operation.collectionRevision! < 1))) {
      throw new Error('INVALID_MEMORY_OPERATION');
    }
  }
}

/** The directory must be outside tool access; permissions alone are not a sandbox. */
export class FileStateStore implements StateStore {
  readonly owner: Owner;
  readonly #directory: string;
  readonly #policyVersion: string;

  constructor(options: { owner: Owner; directory: string; policyVersion: string }) {
    this.owner = checkedOwner(options.owner);
    this.#directory = resolve(options.directory);
    if (!options.policyVersion) throw new Error('MISSING_POLICY_VERSION');
    this.#policyVersion = options.policyVersion;
  }

  async #prepare(): Promise<void> {
    // Do not follow a final-component symlink or relax an existing directory.
    await mkdir(this.#directory, { mode: 0o700, recursive: true });
    const metadata = await lstat(this.#directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || (metadata.mode & 0o077) !== 0
        || metadata.uid !== process.getuid?.()) throw new Error('UNPROTECTED_MEMORY_STATE');
  }

  async #load(): Promise<OwnerState> {
    let file;
    try {
      file = await open(join(this.#directory, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('MEMORY_STATE_UNREADABLE');
      return {
        version: 1, owner: this.owner, revision: 0,
        authorization: { enabled: false, automaticCollection: false, epoch: 0,
          effectiveAt: new Date().toISOString(), policyVersion: this.#policyVersion },
        operations: {},
      };
    }
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) {
        throw new Error('UNPROTECTED_MEMORY_STATE');
      }
      const state = JSON.parse(await file.readFile('utf8')) as OwnerState;
      verify(state, this.owner);
      return state;
    } finally { await file.close(); }
  }

  async #write(state: OwnerState): Promise<void> {
    verify(state, this.owner);
    const temporary = join(this.#directory, `.state-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally { await file.close(); }
    try {
      await rename(temporary, join(this.#directory, 'state.json'));
      const directory = await open(this.#directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }

  async #locked<T>(action: () => Promise<T>, signal?: AbortSignal, filename: 'state.lock' | 'governance.lock' = 'state.lock'): Promise<T> {
    signal?.throwIfAborted();
    await this.#prepare();
    signal?.throwIfAborted();
    const file = await open(join(this.#directory, filename),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) {
        throw new Error('UNPROTECTED_MEMORY_LOCK');
      }
      await lock(file.fd, 'ex', signal);
      try { signal?.throwIfAborted(); return await action(); } finally { await lock(file.fd, 'un'); }
    } finally { await file.close(); }
  }

  /** A crash releases this kernel lock; it never expires while a writer is alive. */
  withGovernanceLock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#locked(action, signal, 'governance.lock');
  }

  read(signal?: AbortSignal): Promise<OwnerState> {
    return this.#locked(() => this.#load(), signal);
  }

  transact<T>(mutation: (state: OwnerState) => T, signal?: AbortSignal): Promise<T> {
    return this.#locked(async () => {
      const state = await this.#load();
      signal?.throwIfAborted();
      const result = mutation(state);
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('ASYNC_MEMORY_TRANSACTION');
      }
      state.revision++;
      await this.#write(state);
      return result;
    }, signal);
  }
}
