import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { flock } from 'fs-ext';
import { checkedOwner, sameOwner, isCollectionSource, type Owner, type OwnerState, type StateStore } from './types.js';

async function lock(fd: number, operation: 'ex' | 'un'): Promise<void> {
  // Blocking flock consumes a libuv worker: enough waiting writers can starve
  // the current holder's fsync. Nonblocking acquisition keeps that pool free.
  for (;;) {
    try {
      await new Promise<void>((accept, reject) => flock(fd, operation === 'ex' ? 'exnb' : 'un',
        error => error ? reject(error) : accept()));
      return;
    } catch (error) {
      if (operation !== 'ex' || !['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
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
        || !['running', 'settled', 'processed', 'discarded', 'blocked_by_pause'].includes(request.phase)
        || !Array.isArray(request.sourceEntries) || request.sourceEntries.some(entry => typeof entry !== 'string' || !entry)
        || new Set(request.sourceEntries).size !== request.sourceEntries.length
        || ![request.createdAt, request.updatedAt].every(time => typeof time === 'string' && Number.isFinite(Date.parse(time)))
        || (['settled', 'processed'].includes(request.phase) && (typeof request.settledEntryId !== 'string' || !request.settledEntryId || !request.sourceEntries.length))) {
        throw new Error('INVALID_COLLECTION_REQUEST');
      }
      if (request.phase === 'processed' && (typeof request.selectionDigest !== 'string'
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
    if (operation.collectionSources !== undefined && (operation.kind !== 'automatic'
      || !Array.isArray(operation.collectionSources) || !operation.collectionSources.length
      || operation.collectionSources.some(source => !isCollectionSource(source)))) {
      throw new Error('INVALID_COLLECTION_PROVENANCE');
    }
    if (operation.collectionEvidence !== undefined && (operation.kind !== 'automatic'
      || !Array.isArray(operation.collectionEvidence) || !operation.collectionEvidence.length
      || operation.collectionEvidence.some(evidence => !evidence || !isCollectionSource(evidence.source)
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

  async #locked<T>(action: () => Promise<T>): Promise<T> {
    await this.#prepare();
    const file = await open(join(this.#directory, 'state.lock'),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) {
        throw new Error('UNPROTECTED_MEMORY_LOCK');
      }
      await lock(file.fd, 'ex');
      try { return await action(); } finally { await lock(file.fd, 'un'); }
    } finally { await file.close(); }
  }

  read(): Promise<OwnerState> {
    return this.#locked(() => this.#load());
  }

  transact<T>(mutation: (state: OwnerState) => T): Promise<T> {
    return this.#locked(async () => {
      const state = await this.#load();
      const result = mutation(state);
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('ASYNC_MEMORY_TRANSACTION');
      }
      state.revision++;
      await this.#write(state);
      return result;
    });
  }
}
