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
const source = { sessionId: 'chat', entryId: 'entry', branchId: 'branch', contentVersion: 'v1' };

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
