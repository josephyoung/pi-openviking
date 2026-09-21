import { fork } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, MemoryDelivery, MemoryGovernanceBarrier, DeliveryScheduler } from '../dist/host.js';

const source = entryId => ({ sessionId: 'chat', entryId, branchId: 'branch', contentVersion: 'v1', entryTimestamp: '2026-09-21T00:00:00.000Z' });
const uri = 'viking://user/alice/memories/preferences/fact.md';
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-governance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const mutations = [], sessions = new Set(), sources = new Set(), commits = new Map();
  const transport = { owner,
    async createSession(id) { mutations.push('create'); sessions.add(id); },
    async sessionExists(id) { return sessions.has(id); },
    async append(op) { mutations.push('append'); sources.add(op.id); },
    async hasSource(op) { return sources.has(op.id); },
    async commit(id) { mutations.push('commit'); const receipt = { taskId: 'task' }; commits.set(id, receipt); return receipt; },
    async findCommit(id) { return commits.get(id) ?? null; },
    async inspect() { return { status: 'ready', archiveId: 'archive', memoryUris: [uri] }; },
  };
  const service = new MemoryDelivery({ store, transport, maxPayloadBytes: 8192 });
  await service.enable('v1');
  const target = await service.save(source('original'), 'synthetic sensitive original');
  for (let i = 0; i < 4; i++) await service.advance(target.id);
  const barrier = new MemoryGovernanceBarrier(store);
  return { directory, owner, store, service, transport, mutations, target, barrier };
}

test('durable revocation removes targeted unsent payload, holds unrelated writes and survives reopen', async t => {
  const f = await setup(t);
  const copied = await f.service.save({ ...source('original'), sessionId: 'fork', branchId: 'fork', contentVersion: 'copied' }, 'synthetic sensitive original');
  const unrelated = await f.service.save(source('unrelated'), 'unrelated preference');
  f.mutations.length = 0;
  const job = await f.barrier.begin({ kind: 'forget', scope: null, memoryUri: uri });
  let state = await f.store.read();
  assert.equal(state.operations[copied.id].phase, 'blocked');
  assert.equal(state.operations[copied.id].payload, undefined);
  assert.equal(state.operations[unrelated.id].phase, 'queued');
  assert.equal(state.operations[unrelated.id].payload, 'unrelated preference');
  assert(!JSON.stringify(state.governance).includes('synthetic sensitive original'));
  assert.equal(job.revision, 1);
  assert.deepEqual(new Set(job.writerOperationIds), new Set([f.target.id, copied.id, unrelated.id]));
  const reopened = new FileStateStore({ owner: f.owner, directory: f.directory, policyVersion: 'v1' });
  const service = new MemoryDelivery({ store: reopened, transport: f.transport, maxPayloadBytes: 8192 });
  await service.advance(copied.id); await service.advance(unrelated.id);
  assert.deepEqual(f.mutations, []);
  assert.equal((await service.save(source('fresh'), 'new fact')).errorCode, 'MEMORY_GOVERNANCE_PENDING');
  // Coordinator completion is deliberately represented only by a test transaction.
  // This test proves the interlock, not remote cleanup or a public completion API.
  await reopened.transact(s => { s.governance.jobs[job.id].phase = 'complete'; });
  assert.equal((await service.save({ ...source('original'), sessionId: 'another-fork' }, 'old fact')).errorCode, 'MEMORY_SOURCE_REVOKED');
  assert.equal((await service.save(source('fresh-explicit'), 'synthetic sensitive original')).phase, 'queued');
  await service.advance(unrelated.id);
  assert.deepEqual(f.mutations, ['create']);
  assert.equal((await reopened.read()).operations[copied.id].phase, 'blocked');
});

test('an accepted commit response arriving after revocation is reconciled without replay', async t => {
  const f = await setup(t);
  const old = await f.service.save(source('other-old-source'), 'an old extraction');
  await f.service.advance(old.id); await f.service.advance(old.id);
  let release, started;
  const sent = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const commit = f.transport.commit;
  f.transport.commit = async id => { const result = await commit(id); started(); await gate; return result; };
  const flight = f.service.advance(old.id); await sent;
  await f.barrier.begin({ kind: 'forget', scope: null, memoryUri: uri });
  assert.equal((await f.store.read()).operations[old.id].phase, 'commit_unknown');
  release(); await flight; await f.service.advance(old.id);
  assert.equal((await f.store.read()).operations[old.id].phase, 'ready');
  assert.equal(f.mutations.filter(value => value === 'commit').length, 2);
  assert.equal(Object.values((await f.store.read()).governance.jobs)[0].phase, 'draining');
});

test('clear works while paused, correction does not, and caller cannot override owner or project', async t => {
  const f = await setup(t);
  await f.service.pause();
  await assert.rejects(f.barrier.begin({ kind: 'correct', scope: null, memoryUri: uri }), /MEMORY_DISABLED/);
  await assert.rejects(f.barrier.begin({ kind: 'forget', scope: 'other', memoryUri: uri }), /TARGET_NOT_FOUND/);
  await assert.rejects(f.barrier.begin({ kind: 'forget', scope: null, memoryUri: 'viking://user/bob/memories/fact.md' }), /TARGET_NOT_FOUND/);
  const job = await f.barrier.begin({ kind: 'clear', scope: null });
  assert.deepEqual(job.operationIds, [f.target.id]);
  await assert.rejects(f.barrier.begin({ kind: 'clear', scope: null }), /GOVERNANCE_PENDING/);
  const other = await f.barrier.begin({ kind: 'clear', scope: 'other' });
  assert.equal(other.scope, 'other');
});

test('clear invalidates running collection and a late selection cannot create an outbox entry', async t => {
  const f = await setup(t);
  await f.service.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] });
  await f.store.transact(state => {
    state.collectionRequests = { request: { id: 'request', sessionId: 'chat', baselineEntryId: null,
      scope: null, authorizationEpoch: state.authorization.epoch, collectionRevision: 1, phase: 'running',
      sourceEntries: ['late-source'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
  });
  const job = await f.barrier.begin({ kind: 'clear', scope: null });
  assert.equal((await f.store.read()).collectionRequests.request.phase, 'discarded');
  const selection = { status: 'ready', requestIds: ['request'], facts: [] };
  assert.equal((await f.service.collectSelection(selection)).status, 'blocked');
  await f.store.transact(state => { state.governance.jobs[job.id].phase = 'complete'; });
  const state = await f.store.read();
  const receipt = await f.service.collect(source('late-source'), 'old automatic fact', { epoch: state.authorization.epoch, collectionRevision: 1 });
  assert.equal(receipt.errorCode, 'MEMORY_SOURCE_REVOKED');
  assert.equal(Object.keys((await f.store.read()).operations).length, 1);
});

test('invalid persisted governance is rejected without replacing the last valid state', async t => {
  const f = await setup(t);
  const job = await f.barrier.begin({ kind: 'forget', scope: null, memoryUri: uri });
  const before = await readFile(join(f.directory, 'state.json'), 'utf8');
  await assert.rejects(f.store.transact(state => { state.governance.jobs[job.id].sourceKeys = ['plaintext']; }), /INVALID_MEMORY_GOVERNANCE/);
  await assert.rejects(f.store.transact(state => { state.governance.jobs[job.id].memoryUris = ['viking://user/bob/memories/fact.md']; }), /INVALID_MEMORY_GOVERNANCE/);
  assert.equal(await readFile(join(f.directory, 'state.json'), 'utf8'), before);
});


test('pending global governance does not hold another trusted project writer', async t => {
  const f = await setup(t);
  const other = await f.service.save(source('project-only'), 'project preference', 'project-a');
  await f.barrier.begin({ kind: 'clear', scope: null });
  f.mutations.length = 0;
  await f.service.advance(other.id);
  assert.deepEqual(f.mutations, ['create']);
  assert.equal((await f.store.read()).operations[other.id].phase, 'session_created');
});

test('a late append acknowledgement cannot reopen a revoked send phase', async t => {
  const f = await setup(t);
  const old = await f.service.save({ ...source('original'), sessionId: 'fork' }, 'original copied body');
  await f.service.advance(old.id);
  let started, release;
  const sent = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const append = f.transport.append;
  f.transport.append = async op => { await append(op); started(); await gate; };
  const flight = f.service.advance(old.id); await sent;
  await f.barrier.begin({ kind: 'forget', scope: null, memoryUri: uri });
  assert.equal((await f.store.read()).operations[old.id].phase, 'message_unknown');
  release(); await flight;
  const state = await f.store.read();
  assert.equal(state.operations[old.id].phase, 'blocked');
  assert.equal(state.operations[old.id].payload, undefined);
  await f.service.advance(old.id);
  assert.equal(f.mutations.filter(value => value === 'commit').length, 1);
});


test('two processes serialize one governance job and SIGKILL cannot erase the committed barrier', async t => {
  const f = await setup(t);
  const children = [0, 1].map(() => fork(new URL('./governance-writer.mjs', import.meta.url), [f.directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
  const results = await Promise.all(children.map(child => Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'error').then(([error]) => { throw error; }),
    once(child, 'exit').then(() => { throw new Error('child exited before result'); }),
  ])));
  assert.equal(results.filter(result => result.status === 'persisted').length, 1);
  assert.equal(results.filter(result => result.code === 'MEMORY_GOVERNANCE_PENDING').length, 1);
  const exits = children.map(child => once(child, 'exit'));
  for (const child of children) child.kill('SIGKILL');
  assert((await Promise.all(exits)).every(([, signal]) => signal === 'SIGKILL'));
  const reopened = new FileStateStore({ owner: f.owner, directory: f.directory, policyVersion: 'v1' });
  const state = await reopened.read();
  assert.equal(Object.keys(state.governance.jobs).length, 1);
  assert.equal(state.governance.revision, 1);
  const service = new MemoryDelivery({ store: reopened, transport: f.transport, maxPayloadBytes: 8192 });
  assert.equal((await service.save(source('new-after-restart'), 'fact')).errorCode, 'MEMORY_GOVERNANCE_PENDING');
});


test('held unrelated delivery does not spend retry budget or erase its payload', async t => {
  const f = await setup(t);
  const unrelated = await f.service.save(source('unrelated-held'), 'preserve this preference');
  await f.barrier.begin({ kind: 'forget', scope: null, memoryUri: uri });
  f.mutations.length = 0;
  const scheduler = new DeliveryScheduler({ store: f.store, delivery: f.service, pollIntervalMs: 5,
    initialBackoffMs: 1, maxBackoffMs: 1, maxAttemptsPerPhase: 1, maxOperationsPerTick: 10 });
  t.after(() => scheduler.stop());
  scheduler.start(); await new Promise(resolve => setTimeout(resolve, 150)); await scheduler.stop();
  const current = (await f.store.read()).operations[unrelated.id];
  assert.equal(current.phase, 'queued'); assert.equal(current.payload, 'preserve this preference');
  assert.equal(current.deliveryAttempts, undefined); assert.deepEqual(f.mutations, []);
});
