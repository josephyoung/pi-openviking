import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore } from '../dist/state-store.js';
import { MemoryDelivery } from '../dist/delivery.js';

async function setup(t, lose = new Set()) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const options = { owner, directory, policyVersion: 'v1' };
  const remote = { sessions: new Set(), sources: new Set(), commits: new Map(), mutations: [], ready: false };
  const lost = name => { if (lose.has(name)) throw new Error('synthetic lost response'); };
  const transport = {
    owner,
    async createSession(id) { remote.sessions.add(id); remote.mutations.push('create'); lost('create'); },
    async sessionExists(id) { return remote.sessions.has(id); },
    async append(op) { remote.sources.add(op.id); remote.mutations.push('append'); lost('append'); },
    async hasSource(op) { return remote.sources.has(op.id); },
    async commit(id) { const receipt = { taskId: 'task', archiveId: 'archive' }; remote.commits.set(id, receipt); remote.mutations.push('commit'); lost('commit'); return receipt; },
    async findCommit(id) { return remote.commits.get(id) ?? null; },
    async inspect() { return remote.ready ? { status: 'ready', archiveId: 'archive', memoryUris: ['viking://user/alice/memories/preference.md'] } : { status: 'processing' }; },
  };
  const recreate = () => {
    const store = new FileStateStore(options);
    return { store, service: new MemoryDelivery({ store, transport, maxPayloadBytes: 8192 }) };
  };
  return { ...recreate(), recreate, remote, transport };
}
const source = { sessionId: 'chat', entryId: 'entry', branchId: 'branch', contentVersion: 'v1', entryTimestamp: '2026-09-21T00:00:00.000Z' };

test('disabled save sends nothing; enable does not authorize automatic collection', async t => {
  const { service, store, remote } = await setup(t);
  assert.equal((await service.save(source, 'fact')).phase, 'blocked');
  assert.deepEqual((await store.read()).operations, {});
  assert.deepEqual(remote.mutations, []);
  await service.enable('v1');
  assert.equal((await store.read()).authorization.automaticCollection, false);
});

test('durable dedup and response-loss recovery use one mutation each across new service instances', async t => {
  const f = await setup(t, new Set(['create', 'append', 'commit']));
  await f.service.enable('v1');
  const first = await f.service.save(source, 'fact');
  assert.equal((await f.service.save(source, 'fact')).id, first.id);
  await assert.rejects(f.service.save(source, 'changed'), /MEMORY_SOURCE_CONFLICT/);
  for (let i = 0; i < 9; i++) await f.recreate().service.advance(first.id);
  assert.deepEqual(f.remote.mutations, ['create', 'append', 'commit']);
  assert.equal((await f.store.read()).operations[first.id].phase, 'processing');
  f.remote.ready = true;
  await f.recreate().service.advance(first.id);
  const saved = (await f.store.read()).operations[first.id];
  assert.equal(saved.phase, 'ready');
  assert.equal(saved.payload, undefined);
});

test('concurrent processors never both send the same non-idempotent message', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const operation = await f.service.save(source, 'fact');
  for (let i = 0; i < 5; i++) {
    await Promise.all(Array.from({ length: 12 }, () => f.recreate().service.advance(operation.id)));
  }
  assert.deepEqual(f.remote.mutations, ['create', 'append', 'commit']);
});

test('pause erases queued content; resume does not replay it and requires a new operation', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const first = await f.service.save(source, 'fact');
  await f.service.pause();
  await f.service.enable('v1');
  await f.service.advance(first.id);
  const blocked = (await f.store.read()).operations[first.id];
  assert.equal(blocked.phase, 'blocked_by_pause');
  assert.equal(blocked.payload, undefined);
  assert.deepEqual(f.remote.mutations, []);
  assert.notEqual((await f.service.save(source, 'fact')).id, first.id);
});

test('an absent receipt after a lost mutation never authorizes resending', async t => {
  const f = await setup(t);
  f.transport.append = async () => { f.remote.mutations.push('append'); throw new Error('unknown'); };
  await f.service.enable('v1');
  const op = await f.service.save(source, 'fact');
  for (let i = 0; i < 8; i++) await f.recreate().service.advance(op.id);
  assert.deepEqual(f.remote.mutations, ['create', 'append']);
  assert.equal((await f.store.read()).operations[op.id].phase, 'message_unknown');
});

test('a terminal extraction failure retains its reason and erases pending content', async t => {
  const f = await setup(t);
  f.transport.inspect = async () => ({ status: 'failed', code: 'MEMORY_NO_EXTRACTED_FACT' });
  await f.service.enable('v1');
  const operation = await f.service.save(source, 'fact');
  for (let i = 0; i < 4; i++) await f.service.advance(operation.id);
  const current = (await f.store.read()).operations[operation.id];
  assert.equal(current.phase, 'failed');
  assert.equal(current.errorCode, 'MEMORY_NO_EXTRACTED_FACT');
  assert.equal(current.payload, undefined);
});

test('operation references reject prototype property names before touching state', async t => {
  const f = await setup(t);
  await assert.rejects(f.service.advance('__proto__'), /INVALID_MEMORY_OPERATION/);
  await assert.rejects(f.service.advance('constructor'), /INVALID_MEMORY_OPERATION/);
  assert.equal(Object.prototype.updatedAt, undefined);
});

const boundary = [{ sessionId: 'chat', entryId: 'before-consent', branchId: 'before-consent' }];
async function consent(f) {
  const a = (await f.store.read()).authorization;
  return { epoch: a.epoch, collectionRevision: a.collectionConsent?.revision ?? 1 };
}
async function authorize(f) {
  await f.service.authorizeCollection({ policyVersion: 'v2', scope: null, boundaries: boundary });
  return consent(f);
}

test('automatic collection needs separate consent and its exact scope and revision', async t => {
  const f = await setup(t);
  await assert.rejects(authorize(f), /MEMORY_DISABLED/);
  await f.service.enable('v1');
  assert.equal((await f.service.collect(source, 'fact', await consent(f))).errorCode, 'MEMORY_COLLECTION_NOT_AUTHORIZED');
  const policy = await authorize(f);
  const state = await f.store.read();
  assert.equal(state.authorization.collectionConsent.policyVersion, 'v2');
  assert.deepEqual(state.authorization.collectionConsent.boundaries, boundary);
  assert(Number.isFinite(Date.parse(state.authorization.collectionConsent.effectiveAt)));
  assert.equal((await f.service.collect(source, 'fact', policy, 'unapproved-project')).phase, 'blocked');
  const first = await f.service.collect(source, 'fact', policy);
  assert.equal(first.kind, 'automatic');
  assert.equal(first.phase, 'queued');
  assert.equal((await f.recreate().service.collect(source, 'fact', policy)).id, first.id);
  assert.notEqual((await f.service.save(source, 'fact')).id, first.id);
  assert.deepEqual(f.remote.mutations, []);
});

test('revoking only automatic consent blocks its pending work without stopping explicit delivery', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const policy = await authorize(f);
  const automatic = await f.service.collect(source, 'automatic fact', policy);
  const explicit = await f.service.save({ ...source, entryId: 'explicit' }, 'explicit fact');
  await f.service.revokeCollection();
  const state = await f.store.read();
  assert(state.authorization.enabled);
  assert(!state.authorization.automaticCollection);
  assert.equal(state.operations[automatic.id].phase, 'blocked_by_pause');
  assert.equal(state.operations[automatic.id].payload, undefined);
  assert.equal(state.operations[explicit.id].phase, 'queued');
  assert.equal((await f.service.collect(source, 'automatic fact', policy)).phase, 'blocked');
  await f.service.advance(explicit.id);
  assert.deepEqual(f.remote.mutations, ['create']);
  await authorize(f);
  assert.equal((await f.service.collect(source, 'automatic fact', policy)).phase, 'blocked');
  await f.recreate().service.advance(automatic.id);
  assert.deepEqual(f.remote.mutations, ['create']);
});

test('resume preserves separately granted consent but installs fresh boundaries and rejects stale intents', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const policy = await authorize(f);
  const old = await f.service.collect(source, 'fact', policy);
  await f.service.pause();
  const newBoundary = [{ sessionId: 'chat', entryId: 'after-pause', branchId: 'other-branch' }];
  await f.service.enable('v2', newBoundary);
  const state = await f.recreate().store.read();
  assert(state.authorization.automaticCollection);
  assert.deepEqual(state.authorization.collectionConsent.boundaries, newBoundary);
  assert(state.authorization.collectionConsent.revision > policy.collectionRevision);
  assert.equal((await f.service.collect(source, 'fact', policy)).errorCode, 'MEMORY_CONFIRM_AGAIN');
  assert.equal((await f.service.save(source, 'fact', null, policy.epoch)).errorCode, 'MEMORY_CONFIRM_AGAIN');
  await f.service.advance(old.id);
  assert.equal((await f.store.read()).operations[old.id].phase, 'blocked_by_pause');
  assert.deepEqual(f.remote.mutations, []);
});

for (const change of ['pause', 'revokeCollection']) {
  for (const [method, preparations] of [['createSession', 0], ['append', 1], ['commit', 2]]) {
    test(`${change} during ${method} only reconciles an accepted lost response, even after reauthorization`, async t => {
      const f = await setup(t);
      await f.service.enable('v1');
      const policy = await authorize(f);
      const operation = await f.service.collect(source, 'fact', policy);
      for (let i = 0; i < preparations; i++) await f.service.advance(operation.id);
      const original = f.transport[method];
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      f.transport[method] = async (...args) => {
        await original(...args);
        entered();
        await gate;
        throw new Error('accepted by server but response lost');
      };
      const inFlight = f.service.advance(operation.id);
      await started;
      await f.recreate().service[change]();
      assert.match((await f.store.read()).operations[operation.id].phase, /unknown$/);
      if (change === 'pause') await f.service.enable('v2', boundary);
      else await authorize(f);
      const sent = [...f.remote.mutations];
      release();
      await inFlight;
      f.remote.ready = true;
      for (let i = 0; i < 4; i++) await f.recreate().service.advance(operation.id);
      assert.deepEqual(f.remote.mutations, sent);
      const result = (await f.store.read()).operations[operation.id];
      assert.equal(result.phase, method === 'commit' ? 'ready' : 'blocked_by_pause');
      assert.equal(result.payload, undefined);
    });
  }
}

test('fork ancestors and concurrent viewers share one durable automatic source receipt', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const policy = await authorize(f);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    f.recreate().service.collect({ ...source, sessionId: `fork-${i}`, branchId: `leaf-${i}` }, 'fact', policy)));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  const first = results[0];
  f.remote.ready = true;
  for (let i = 0; i < 4; i++) await f.recreate().service.advance(first.id);
  assert.deepEqual(f.remote.mutations, ['create', 'append', 'commit']);
  const state = await f.recreate().store.read();
  assert.equal(state.operations[first.id].payload, undefined);
  assert.equal(Object.keys(state.collectedSources).length, 1);
  assert.equal(Object.keys(state.operations).length, 1);
  assert.equal((await f.recreate().service.collect(source, 'fact', policy)).phase, 'ready');
  // Conflict detection remains effective after successful payload erasure.
  await assert.rejects(f.recreate().service.collect(source, 'different fact', policy), /MEMORY_SOURCE_CONFLICT/);
});

test('a fresh consent cannot resurrect a source cleared by pause, including on another branch', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const first = await f.service.collect(source, 'fact', await authorize(f));
  await f.service.pause();
  await f.service.enable('v2', boundary);
  const repeated = await f.recreate().service.collect({ ...source, sessionId: 'fork', branchId: 'new-leaf' }, 'fact', await consent(f));
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.phase, 'blocked_by_pause');
  assert.equal(repeated.payload, undefined);
  await f.service.advance(repeated.id);
  assert.deepEqual(f.remote.mutations, []);
  assert.equal(Object.keys((await f.store.read()).operations).length, 1);
});

test('reused short entry IDs do not deduplicate independently created messages', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const policy = await authorize(f);
  const first = await f.service.collect(source, 'fact', policy);
  const distinct = await f.service.collect({ ...source, entryTimestamp: '2026-09-21T00:00:01.000Z' }, 'fact', policy);
  assert.notEqual(distinct.id, first.id);
  await assert.rejects(f.service.collect({ ...source, entryTimestamp: undefined }, 'fact', policy), /INVALID_COLLECTION_SOURCE/);
});

test('failed atomic enqueue does not leave a source consumed without an outbox record', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const policy = await authorize(f);
  const failing = new MemoryDelivery({ transport: f.transport, maxPayloadBytes: 8192,
    store: { owner: f.store.owner, read: () => f.store.read(),
      transact: mutation => f.store.transact(state => { mutation(state); throw new Error('disk failure before commit'); }) } });
  await assert.rejects(failing.collect(source, 'fact', policy), /disk failure/);
  const state = await f.recreate().store.read();
  assert.deepEqual(state.operations, {});
  assert.equal(state.collectedSources, undefined);
  assert.equal((await f.recreate().service.collect(source, 'fact', policy)).phase, 'queued');
});

test('real pi fork preserves source identity even when labels change the ancestry chain', async t => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { createHash } = await import('node:crypto');
  const pi = SessionManager.inMemory('/private/tmp');
  const first = pi.appendMessage({ role: 'user', content: 'I prefer concise reports.', timestamp: Date.now() });
  pi.appendLabelChange(first, 'preference');
  const leaf = pi.appendMessage({ role: 'user', content: 'Use a short conclusion.', timestamp: Date.now() });
  const entry = pi.getEntry(leaf);
  const makeSource = () => ({ sessionId: pi.getSessionId(), branchId: pi.getLeafId(),
    entryId: entry.id, entryTimestamp: entry.timestamp,
    contentVersion: createHash('sha256').update(JSON.stringify(entry.message)).digest('hex') });
  const f = await setup(t);
  await f.service.enable('v1');
  const policy = await authorize(f);
  const originalSource = makeSource();
  const original = await f.service.collect(originalSource, 'Use a short conclusion.', policy);
  pi.createBranchedSession(leaf);
  assert.notEqual(pi.getSessionId(), originalSource.sessionId);
  assert.equal(pi.getEntry(leaf).timestamp, entry.timestamp);
  assert.notEqual(pi.getEntry(leaf).parentId, entry.parentId);
  assert.equal((await f.recreate().service.collect(makeSource(), 'Use a short conclusion.', policy)).id, original.id);
  assert.equal(Object.keys((await f.store.read()).operations).length, 1);
});
