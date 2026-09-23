import { fork } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStateStore, MemoryDelivery, MemoryGovernanceBarrier, MemoryClearCoordinator } from '../dist/host.js';
const source = entryId => ({ sessionId: 'chat', entryId, branchId: entryId, contentVersion: 'v1' });
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-clear-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const options = { owner, directory, policyVersion: 'v1' };
  const store = new FileStateStore(options);
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  const own = await delivery.save(source('own'), 'synthetic private text');
  const other = await delivery.save(source('other'), 'another project text', 'project-b');
  const job = await new MemoryGovernanceBarrier(store).begin({ kind: 'clear', scope: null });
  const calls = [], remote = { settled: true, failSource: false, failClear: false };
  const transport = { owner, scope: null,
    async writerSettled(op) { calls.push(['inspect', op.id]); return remote.settled; },
    async removeSource(op) { calls.push(['source', op.id]); if (remote.failSource) throw new Error('offline'); },
    async clearMemoryScope() { calls.push(['clear']); if (remote.failClear) throw new Error('lost response'); },
  };
  return { options, store, delivery, own, other, job, calls, remote, transport,
    coordinator: new MemoryClearCoordinator(store, transport) };
}

test('clear proves all old writers settled before source or memory mutation and preserves another project', async t => {
  const f = await setup(t); f.remote.settled = false;
  assert.equal((await f.coordinator.advance(f.job.id)).status, 'pending');
  assert.deepEqual(f.calls, [['inspect', f.own.id]]);
  assert.equal((await f.delivery.save(source('during'), 'fact')).errorCode, 'MEMORY_GOVERNANCE_PENDING');
  f.remote.settled = true;
  assert.equal((await f.coordinator.advance(f.job.id)).status, 'complete');
  const state = await f.store.read();
  assert.equal(state.governance.jobs[f.job.id].phase, 'complete');
  assert.equal(state.operations[f.own.id].payload, undefined);
  assert.equal(state.operations[f.own.id].memoryUris, undefined);
  assert.equal(state.operations[f.other.id].payload, 'another project text');
  assert.equal(state.operations[f.other.id].phase, 'queued');
  assert.equal((await f.delivery.save(source('new'), 'synthetic private text')).phase, 'queued');
  const count = f.calls.length;
  await f.coordinator.advance(f.job.id);
  assert.equal(f.calls.length, count);
});

test('source failure persists applying and recovery does not depend on already removed archives', async t => {
  const f = await setup(t); f.remote.failSource = true;
  const result = await f.coordinator.advance(f.job.id);
  assert.equal(result.status, 'pending');
  assert.equal(result.errorCode, 'MEMORY_GOVERNANCE_RETRY_REQUIRED');
  assert.equal((await f.store.read()).governance.jobs[f.job.id].phase, 'applying');
  assert(!f.calls.some(([kind]) => kind === 'clear'));
  const reopened = new FileStateStore(f.options);
  f.remote.failSource = false;
  f.transport.writerSettled = async () => { throw new Error('the old archive is already gone'); };
  assert.equal((await new MemoryClearCoordinator(reopened, f.transport).advance(f.job.id)).status, 'complete');
  assert.equal((await reopened.read()).governance.jobs[f.job.id].errorCode, undefined);
});

test('ambiguous remote clear never opens the scope and is reconciled by a later attempt', async t => {
  const f = await setup(t); f.remote.failClear = true;
  assert.equal((await f.coordinator.advance(f.job.id)).status, 'pending');
  assert.equal((await f.store.read()).governance.jobs[f.job.id].phase, 'applying');
  assert.equal((await f.delivery.save(source('blocked'), 'fact')).phase, 'blocked');
  f.remote.failClear = false;
  assert.equal((await f.coordinator.advance(f.job.id)).status, 'complete');
});

test('concurrent cleaners serialize remote mutations; the second cannot clear new writes', async t => {
  const f = await setup(t);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = new Promise(resolve => { started = resolve; });
  let clearCalls = 0;
  f.transport.clearMemoryScope = async () => { clearCalls++; started(); await gate; };
  const first = f.coordinator.advance(f.job.id); await sent;
  const second = new MemoryClearCoordinator(new FileStateStore(f.options), f.transport).advance(f.job.id);
  assert.equal((await f.delivery.save(source('too-early'), 'fact')).phase, 'blocked');
  release();
  assert.equal((await first).status, 'complete');
  assert.equal((await f.delivery.save(source('new-after-clear'), 'fact')).phase, 'queued');
  assert.equal((await second).status, 'complete'); assert.equal(clearCalls, 1);
});

test('foreign owner, wrong project and non-clear job fail before remote work', async t => {
  const f = await setup(t);
  assert.throws(() => new MemoryClearCoordinator(f.store, { ...f.transport, owner: { accountId: 'test', userId: 'bob' } }), /OWNER_MISMATCH/);
  await assert.rejects(new MemoryClearCoordinator(f.store, { ...f.transport, scope: 'project-b' }).advance(f.job.id), /TARGET_MISMATCH/);
  await assert.rejects(f.coordinator.advance('../job'), /INVALID_MEMORY_GOVERNANCE/);
  assert.deepEqual(f.calls, []);
});


test('SIGKILL during applying releases kernel lock and a new process can recover the same job', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const child = fork(new URL('./governance-clear-worker.mjs', import.meta.url), [f.options.directory, f.job.id],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const [message] = await once(child, 'message');
  assert.equal(message.phase, 'remote-clear-in-flight');
  assert.equal((await f.store.read()).governance.jobs[f.job.id].phase, 'applying');
  const exit = once(child, 'exit'); child.kill('SIGKILL');
  assert.equal((await exit)[1], 'SIGKILL');
  f.transport.writerSettled = async () => { throw new Error('must not require removed source again'); };
  const reopened = new FileStateStore(f.options);
  assert.equal((await new MemoryClearCoordinator(reopened, f.transport).advance(f.job.id)).status, 'complete');
  assert.deepEqual(f.calls.map(([kind]) => kind), ['source', 'clear']);
});
