import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, MemoryDelivery, DeliveryScheduler } from '../dist/host.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(10); }
  assert.fail('Background condition not reached');
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-scheduler-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const calls = [];
  const transport = { owner,
    async createSession() { calls.push('create'); }, async append() { calls.push('append'); },
    async commit() { calls.push('commit'); return { taskId: 'task' }; },
    async inspect() { return { status: 'ready', archiveId: 'archive', memoryUris: ['memory'] }; },
    async sessionExists() { return false; }, async hasSource() { return false; }, async findCommit() { return null; } };
  const delivery = new MemoryDelivery({ store, transport, maxPayloadBytes: 4096 });
  await delivery.enable('v1');
  const operation = await delivery.save({ sessionId: 'chat', entryId: 'entry', branchId: 'root', contentVersion: '1' }, 'fact');
  const options = { store, delivery, pollIntervalMs: 5, initialBackoffMs: 10, maxBackoffMs: 40,
    maxAttemptsPerPhase: 3, maxOperationsPerTick: 2 };
  return { store, delivery, transport, calls, operation, options };
}

test('startup drains durable work without a viewer or a new save request', async t => {
  const f = await setup(t);
  const scheduler = new DeliveryScheduler(f.options);
  t.after(() => scheduler.stop(100));
  scheduler.start(); scheduler.start();
  await until(async () => (await f.store.read()).operations[f.operation.id].phase === 'ready');
  assert.deepEqual(f.calls, ['create', 'append', 'commit']);
});

test('unknown outcomes back off and terminate visibly without repeating the mutation', async t => {
  const f = await setup(t);
  f.transport.append = async () => { f.calls.push('append'); throw new Error('lost'); };
  const status = [];
  const scheduler = new DeliveryScheduler({ ...f.options, onStatus: value => status.push(value) });
  t.after(() => scheduler.stop(100));
  scheduler.start();
  await until(async () => (await f.store.read()).operations[f.operation.id].phase === 'blocked');
  const operation = (await f.store.read()).operations[f.operation.id];
  assert.deepEqual(f.calls, ['create', 'append']);
  assert.equal(operation.errorCode, 'MEMORY_RECONCILIATION_LIMIT');
  assert.equal(operation.payload, undefined);
  assert(status.some(value => value.phase === 'blocked'));
  assert(status.every(value => !('payload' in value) && !('owner' in value)));
});

test('restart preserves backoff and attempt counts; stopping prevents new delivery', async t => {
  const f = await setup(t);
  await f.store.transact(state => {
    const operation = state.operations[f.operation.id];
    operation.nextAttemptAt = Date.now() + 150;
    operation.deliveryAttempts = 2;
  });
  const scheduler = new DeliveryScheduler(f.options);
  scheduler.start();
  await sleep(40);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.store.read()).operations[f.operation.id].deliveryAttempts, 2);
  await scheduler.stop(100);
  await sleep(160);
  assert.deepEqual(f.calls, []);
  const restarted = new DeliveryScheduler(f.options);
  t.after(() => restarted.stop(100));
  restarted.start();
  await until(async () => (await f.store.read()).operations[f.operation.id].phase === 'ready');
});

test('owner mismatch is rejected and observer exceptions cannot kill delivery', async t => {
  const f = await setup(t);
  assert.throws(() => new DeliveryScheduler({ ...f.options, delivery: { owner: { accountId: 'test', userId: 'bob' }, advance() {} } }), /OWNER_MISMATCH/);
  const scheduler = new DeliveryScheduler({ ...f.options, onStatus() { throw new Error('observer'); } });
  t.after(() => scheduler.stop(100));
  scheduler.start();
  await until(async () => (await f.store.read()).operations[f.operation.id].phase === 'ready');
});
