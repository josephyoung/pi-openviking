import type { TaskFactProjection } from './task-facts.js';
export interface Owner {
  readonly accountId: string;
  readonly userId: string;
}

export interface Authorization {
  enabled: boolean;
  automaticCollection: boolean;
  epoch: number;
  effectiveAt: string;
  policyVersion: string;
  collectionConsent?: CollectionConsent;
}

/** Stable pi entries observed by the trusted host at the authorization boundary. */
export interface CollectionBoundary {
  sessionId: string;
  entryId: string | null;
  branchId: string | null;
}

export interface CollectionConsent {
  revision: number;
  effectiveAt: string;
  policyVersion: string;
  scope: string | null;
  boundaries: CollectionBoundary[];
}

export type DeliveryPhase =
  | 'queued' | 'session_unknown' | 'session_created'
  | 'message_unknown' | 'message_delivered' | 'commit_unknown'
  | 'processing' | 'ready' | 'failed' | 'blocked_by_pause' | 'blocked';

export interface Source {
  sessionId: string;
  entryId: string;
  branchId: string;
  contentVersion: string;
}

/** Original persisted entry timestamp is preserved when pi copies fork ancestors. */
export interface CollectionSource extends Source {
  entryTimestamp: string;
}

export interface CollectedSource {
  operationId: string;
  payloadDigest: string;
}

export interface Operation {
  id: string;
  owner: Owner;
  scope: string | null;
  source: Source;
  kind: 'explicit' | 'automatic';
  authorizationEpoch: number;
  collectionRevision?: number;
  collectionSources?: CollectionSource[];
  collectionEvidence?: Array<{ source: CollectionSource; quoteDigest: string; projection?: TaskFactProjection }>;
  createdAt: string;
  updatedAt: string;
  phase: DeliveryPhase;
  remoteSessionId: string;
  payload?: string;
  taskId?: string;
  archiveId?: string;
  memoryUris?: string[];
  errorCode?: string;
  /** Last phase retained when automatic reconciliation exhausts its budget. */
  reconciliationPhase?: DeliveryPhase;
  deliveryAttempts?: number;
  nextAttemptAt?: number;
}

/** Metadata only: messages remain in pi's original session store. */
export interface CollectionRequest {
  id: string;
  sessionId: string;
  baselineEntryId: string | null;
  settledEntryId?: string;
  scope: string | null;
  authorizationEpoch: number;
  collectionRevision: number;
  phase: 'running' | 'settled' | 'processed' | 'discarded' | 'blocked_by_pause' | 'selection_failed';
  /** Adjacent completed assistant proposition, evidence only, never a new source. */
  completedAssistant?: CollectionSource;
  confirmationReference?: { requestId: string; entryId: string };
  selectionAttempts?: number;
  selectionNextAttemptAt?: number;
  selectionLease?: { id: string; expiresAt: number };
  selectionErrorCode?: string;
  selectionDigest?: string;
  operationIds?: string[];
  createdAt: string;
  updatedAt: string;
  sourceEntries: string[];
}

export interface GovernanceJob {
  id: string;
  revision: number;
  kind: 'forget' | 'correct' | 'clear';
  scope: string | null;
  phase: 'draining' | 'applying' | 'complete';
  memoryUris: string[];
  operationIds: string[];
  /** All pre-barrier scope writers must be reconciled or edited before release. */
  writerOperationIds: string[];
  /** Hashes of stable entry identity, never deleted plaintext. */
  sourceKeys: string[];
  errorCode?: string;
  completedAt?: string;
  createdAt: string;
}

export interface OwnerState {
  version: 1;
  owner: Owner;
  revision: number;
  authorization: Authorization;
  operations: Record<string, Operation>;
  governance?: { revision: number; jobs: Record<string, GovernanceJob> };
  /** Source receipts contain no conversation text and survive consent changes. */
  collectedSources?: Record<string, CollectedSource>;
  collectionRequests?: Record<string, CollectionRequest>;
  /** Host-validated owner-private pi source paths, never browser/model input. */
  collectionSessionFiles?: Record<string, string>;
}

export interface StateStore {
  readonly owner: Owner;
  read(signal?: AbortSignal): Promise<OwnerState>;
  /** Synchronous mutation, serialized across processes and committed before return. */
  transact<T>(mutation: (state: OwnerState) => T, signal?: AbortSignal): Promise<T>;
}

export function checkedOwner(owner: Owner): Owner {
  if (!owner || ![owner.accountId, owner.userId].every(id =>
    typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    throw new Error('INVALID_MEMORY_OWNER');
  }
  return Object.freeze({ accountId: owner.accountId, userId: owner.userId });
}

export function sameOwner(a: Owner, b: Owner): boolean {
  return a.accountId === b.accountId && a.userId === b.userId;
}

export function isCollectionSource(value: unknown): value is CollectionSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as CollectionSource;
  return [source.sessionId, source.entryId, source.branchId, source.contentVersion]
    .every(item => typeof item === 'string' && item.length > 0)
    && typeof source.entryTimestamp === 'string' && Number.isFinite(Date.parse(source.entryTimestamp));
}

/** A reference can cross a processed batch, but never a consent/scope boundary. */
export function collectionReferenceRequest(state: OwnerState, request: CollectionRequest): CollectionRequest | undefined {
  const reference = request.confirmationReference;
  const prior = reference && state.collectionRequests?.[reference.requestId];
  return prior && prior.id !== request.id && prior.scope === request.scope
    && prior.authorizationEpoch === request.authorizationEpoch && prior.collectionRevision === request.collectionRevision
    && ['settled', 'processed', 'selection_failed'].includes(prior.phase)
    && prior.completedAssistant?.entryId === reference!.entryId && prior.sourceEntries.includes(reference!.entryId)
    ? prior : undefined;
}
