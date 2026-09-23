import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, MemoryDelivery, DeliveryScheduler } from '../dist/host.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await sleep(10); }
  assert.fail('Background condition not reached');
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-scheduler-'));
  const schedulers = [];
  t.after(async () => {
    await Promise.all(schedulers.map(scheduler => scheduler.stop()));
    await rm(directory, { recursive: true, force: true });
  });
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
  const createScheduler = configuration => {
    const scheduler = new DeliveryScheduler(configuration);
    schedulers.push(scheduler);
    return scheduler;
  };
  return { store, delivery, transport, calls, operation, options, createScheduler };
}

test('startup drains durable work without a viewer or a new save request', async t => {
  const f = await setup(t);
  const scheduler = f.createScheduler(f.options);
  scheduler.start(); scheduler.start();
  await until(async () => (await f.store.read()).operations[f.operation.id].phase === 'ready');
  assert.deepEqual(f.calls, ['create', 'append', 'commit']);
});

test('unknown outcomes back off and terminate visibly without repeating the mutation', async t => {
  const f = await setup(t);
  f.transport.append = async () => { f.calls.push('append'); throw new Error('lost'); };
  const status = [];
  const scheduler = f.createScheduler({ ...f.options, onStatus: value => status.push(value) });
  scheduler.start();
  await until(async () => (await f.store.read()).operations[f.operation.id].phase === 'blocked');
  const operation = (await f.store.read()).operations[f.operation.id];
  assert.deepEqual(f.calls, ['create', 'append']);
  assert.equal(operation.errorCode, 'MEMORY_RECONCILIATION_LIMIT');
  assert.equal(operation.payload, undefined);
  await until(() => status.some(value => value.phase === 'blocked'));
  assert(status.every(value => !('payload' in value) && !('owner' in value)));
});

test('restart reconciles an exhausted completed commit by reading its receipt only', async t => {
  const f = await setup(t);
  await f.store.transact(state => {
    const operation = state.operations[f.operation.id];
    operation.phase = 'blocked';
    operation.errorCode = 'MEMORY_RECONCILIATION_LIMIT';
    operation.reconciliationPhase = 'processing';
    operation.taskId = 'task';
    operation.deliveryAttempts = 90;
    delete operation.payload;
  });
  let inspected = 0;
  f.transport.inspect = async () => {
    inspected++;
    return { status: 'ready', archiveId: 'archive', memoryUris: ['memory'] };
  };
  f.createScheduler(f.options).start();
  await until(async () => (await f.store.read()).operations[f.operation.id].phase === 'ready');
  assert.equal(inspected, 1);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.store.read()).operations[f.operation.id].errorCode, undefined);
});

test('restart preserves backoff and attempt counts; stopping prevents new delivery', async t => {
  const f = await setup(t);
  await f.store.transact(state => {
    const operation = state.operations[f.operation.id];
    operation.nextAttemptAt = Date.now() + 60_000;
    operation.deliveryAttempts = 2;
  });
  const scheduler = f.createScheduler(f.options);
  scheduler.start();
  await sleep(40);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.store.read()).operations[f.operation.id].deliveryAttempts, 2);
  await scheduler.stop(100);
  await f.store.transact(state => { state.operations[f.operation.id].nextAttemptAt = 0; });
  await sleep(20);
  assert.deepEqual(f.calls, []);
  const restarted = f.createScheduler(f.options);
  restarted.start();
  await until(async () => (await f.store.read()).operations[f.operation.id].phase === 'ready');
});

test('owner mismatch is rejected and observer exceptions cannot kill delivery', async t => {
  const f = await setup(t);
  assert.throws(() => f.createScheduler({ ...f.options, delivery: { owner: { accountId: 'test', userId: 'bob' }, advance() {} } }), /OWNER_MISMATCH/);
  const scheduler = f.createScheduler({ ...f.options, onStatus() { throw new Error('observer'); } });
  scheduler.start();
  await until(async () => (await f.store.read()).operations[f.operation.id].phase === 'ready');
});

test('bounded stop reports unfinished persistence and an unbounded stop waits for its durable receipt', async t => {
  const f = await setup(t);
  let remoteResponded = false;
  let writingReceipt = false;
  let releaseWrite;
  const heldWrite = new Promise(resolve => { releaseWrite = resolve; });
  const store = {
    owner: f.store.owner,
    read: () => f.store.read(),
    async transact(mutation) {
      if (remoteResponded) { writingReceipt = true; await heldWrite; }
      return f.store.transact(mutation);
    },
  };
  f.transport.createSession = async () => { f.calls.push('create'); remoteResponded = true; };
  const delivery = new MemoryDelivery({ store, transport: f.transport, maxPayloadBytes: 4096 });
  const scheduler = f.createScheduler({ ...f.options, store, delivery });
  try {
    scheduler.start();
    await until(() => writingReceipt);
    assert.equal((await f.store.read()).operations[f.operation.id].phase, 'session_unknown');
    assert.equal(await scheduler.stop(0), false);
    let drained = false;
    const drain = scheduler.stop().then(result => { drained = true; return result; });
    await sleep(20);
    assert.equal(drained, false);
    releaseWrite();
    assert.equal(await drain, true);
    assert.equal((await f.store.read()).operations[f.operation.id].phase, 'session_created');
    assert.deepEqual(f.calls, ['create']);
    assert.equal(await scheduler.stop(0), true);
  } finally {
    releaseWrite();
    await scheduler.stop();
  }
});
