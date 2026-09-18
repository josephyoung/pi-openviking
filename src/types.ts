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

export interface Operation {
  id: string;
  owner: Owner;
  scope: string | null;
  source: Source;
  kind: 'explicit';
  authorizationEpoch: number;
  createdAt: string;
  updatedAt: string;
  phase: DeliveryPhase;
  remoteSessionId: string;
  payload?: string;
  taskId?: string;
  archiveId?: string;
  memoryUris?: string[];
  errorCode?: string;
}

export interface OwnerState {
  version: 1;
  owner: Owner;
  revision: number;
  authorization: Authorization;
  operations: Record<string, Operation>;
}

export interface StateStore {
  readonly owner: Owner;
  read(): Promise<OwnerState>;
  /** Synchronous mutation, serialized across processes and committed before return. */
  transact<T>(mutation: (state: OwnerState) => T): Promise<T>;
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
