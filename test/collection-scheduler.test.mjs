import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CollectionScheduler, CollectionFactSelector, CollectionLifecycle, FileStateStore, MemoryDelivery, MemoryGovernanceBarrier } from '../dist/host.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 5000;
  while (!await check()) { if (Date.now() > end) assert.fail('Timed out waiting for scheduler evidence'); await delay(10); }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-collection-scheduler-'));
  const owner = { accountId: 'test', userId: 'alice' };
  const storeOptions = { owner, directory: join(root, 'state'), policyVersion: 'v1' };
  const store = new FileStateStore(storeOptions);
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  await delivery.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] });
  const lifecycle = new CollectionLifecycle(store);
  const session = SessionManager.inMemory('/private/tmp');
  const facts = new Map();
  async function add(text = 'I prefer concise reports.') {
    const id = await lifecycle.begin(session);
    const entryId = session.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Understood.' }], stopReason: 'stop', timestamp: Date.now() });
    await lifecycle.settle(id, session);
    const entry = session.getEntry(entryId);
    const source = { sessionId: session.getSessionId(), entryId, entryTimestamp: entry.timestamp,
      branchId: session.getLeafId(), contentVersion: createHash('sha256').update(JSON.stringify(entry.message)).digest('hex') };
    facts.set(id, { text, source, evidence: [{ source, quote: text }] });
    return id;
  }
  const calls = []; let wakes = 0;
  const select = async ids => { calls.push([...ids]); return { status: 'ready', requestIds: ids, facts: ids.map(id => facts.get(id)) }; };
  const options = { store, delivery, selector: { select }, resolveSession: async () => session,
    pollIntervalMs: 10, mergeWindowMs: 0, maxWaitMs: 20000, workTimeoutMs: 2000, leaseMs: 5000,
    initialBackoffMs: 10, maxBackoffMs: 20, maxAttempts: 2, maxRequestsPerBatch: 10, wakeDelivery() { wakes++; } };
  const schedulers = [];
  const start = (overrides = {}) => { const scheduler = new CollectionScheduler({ ...options, ...overrides }); schedulers.push(scheduler); scheduler.start(); return scheduler; };
  t.after(async () => { await Promise.all(schedulers.map(scheduler => scheduler.stop())); await rm(root, { recursive: true, force: true }); });
  return { root, storeOptions, store, delivery, lifecycle, session, facts, add, calls, select, options, start, wakes: () => wakes };
}
const processed = async (f, ids) => { const s = await f.store.read(); return ids.every(id => s.collectionRequests[id].phase === 'processed'); };

test('the actual input/selector/handoff pipeline coalesces two completed requests in the background', async t => {
  const f = await fixture(t); const ids = [await f.add(), await f.add('I use metric units.')];
  let models = 0;
  const selector = new CollectionFactSelector({ store: f.store, maxInputBytes: 8192, maxFacts: 10, timeoutMs: 3000,
    async complete({ data }) { models++; return JSON.stringify({ facts: JSON.parse(data).messages.filter(m => m.role === 'user').map(m => ({ sourceId: m.sourceId, quote: m.text })) }); } });
  const scheduler = f.start({ selector, workTimeoutMs: 4000, leaseMs: 6000 });
  await until(() => processed(f, ids)); await scheduler.stop();
  const state = await f.store.read();
  assert.equal(models, 1); assert.equal(Object.keys(state.operations).length, 2); assert.equal(f.wakes(), 1);
  assert(Object.values(state.operations).every(operation => operation.collectionSources.length === 1));
  assert(ids.every(id => !state.collectionRequests[id].selectionLease));
});

test('merge window holds new work, while oldest max wait overrides continuous newer activity', async t => {
  const f = await fixture(t); const first = await f.add();
  const scheduler = f.start({ mergeWindowMs: 10000 });
  await delay(100); assert.equal(f.calls.length, 0);
  const second = await f.add('I use metric units.');
  await f.store.transact(s => { s.collectionRequests[first].updatedAt = new Date(Date.now() - 21000).toISOString(); });
  scheduler.wake(); await until(() => processed(f, [first, second]));
  assert.equal(f.calls.length, 1); assert.deepEqual(new Set(f.calls[0]), new Set([first, second]));
});

test('two owner schedulers share a durable claim and cannot start a second model invocation', async t => {
  const f = await fixture(t); const id = await f.add();
  let release; const gate = new Promise(resolve => { release = resolve; }); let entered = 0;
  const selector = { async select(ids) { entered++; await gate; return f.select(ids); } };
  f.start({ selector }); f.start({ store: new FileStateStore(f.storeOptions), selector });
  await until(() => entered === 1); await delay(100);
  assert.equal(entered, 1); assert.equal((await f.store.read()).collectionRequests[id].selectionAttempts, 1);
  release(); await until(() => processed(f, [id]));
  assert.equal(Object.keys((await f.store.read()).operations).length, 1);
});

test('pausing an active selection removes its claim and late results cannot create writes', async t => {
  const f = await fixture(t); const id = await f.add(); let entered = false;
  let release; const gate = new Promise(resolve => { release = resolve; });
  const scheduler = f.start({ selector: { async select(ids) { entered = true; await gate; return f.select(ids); } } });
  await until(() => entered); await f.delivery.pause(); await f.delivery.enable('v2'); release();
  await until(() => f.calls.length === 1); await scheduler.stop();
  const state = await f.store.read();
  assert.equal(state.collectionRequests[id].phase, 'blocked_by_pause');
  assert.equal(state.collectionRequests[id].selectionLease, undefined); assert.deepEqual(state.operations, {});
});

test('expired lease replacement fences the previous process even when its result arrives late', async t => {
  const f = await fixture(t); const id = await f.add(); let entered = false;
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = f.start({ selector: { async select(ids) { entered = true; await gate; return f.select(ids); } } });
  await until(() => entered);
  const staleToken = (await f.store.read()).collectionRequests[id].selectionLease.id;
  await f.store.transact(s => { s.collectionRequests[id].selectionLease.expiresAt = Date.now() - 1; });
  const second = f.start(); await until(() => processed(f, [id])); release(); await first.stop(); await second.stop();
  const state = await f.store.read(); assert.equal(Object.keys(state.operations).length, 1);
  assert.equal(state.collectionRequests[id].selectionAttempts, 2);
  assert.equal((await f.delivery.collectSelection({ status: 'ready', requestIds: [id], facts: [] }, staleToken)).status, 'blocked');
});

test('non-cooperative inference times out, retries are bounded and late results never enqueue', async t => {
  const f = await fixture(t); const id = await f.add(); const releases = [];
  const scheduler = f.start({ workTimeoutMs: 250, leaseMs: 1000,
    selector: { select(ids) { return new Promise(resolve => releases.push(() => resolve({ status: 'ready', requestIds: ids, facts: [f.facts.get(id)] }))); } } });
  await until(() => releases.length > 0);
  await until(async () => (await f.store.read()).collectionRequests[id].phase === 'selection_failed');
  await scheduler.stop(); releases.forEach(release => release()); await delay(30);
  const state = await f.store.read(); assert.deepEqual(state.operations, {});
  assert.equal(state.collectionRequests[id].selectionAttempts, 2); assert.match(state.collectionRequests[id].selectionErrorCode, /^MEMORY_/);
});

test('missing persisted session becomes an observable bounded failure without model calls', async t => {
  const f = await fixture(t); const id = await f.add();
  const scheduler = f.start({ async resolveSession() { throw new Error('private path must not escape'); } });
  await until(async () => (await f.store.read()).collectionRequests[id].phase === 'selection_failed'); await scheduler.stop();
  assert.equal(f.calls.length, 0); assert.equal((await f.store.read()).collectionRequests[id].selectionErrorCode, 'MEMORY_SOURCE_UNAVAILABLE');
});

test('source loading timeout and shutdown do not wait for an uncooperative host callback', async t => {
  const f = await fixture(t); await f.add(); let entered = false;
  const scheduler = f.start({ async resolveSession() { entered = true; return new Promise(() => {}); } });
  await until(() => entered);
  await Promise.race([scheduler.stop(), delay(1000).then(() => { throw new Error('shutdown hung'); })]);
  assert.deepEqual((await f.store.read()).operations, {});
});

test('SIGKILL after selection claim recovers from the same owner state with no viewer', async t => {
  const f = await fixture(t); const id = await f.add();
  const input = join(f.root, 'child.json');
  await writeFile(input, JSON.stringify({ storeOptions: f.storeOptions, id }), { mode: 0o600 });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['test/collection-scheduler-writer.mjs', input], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child claim timeout')); }, 5000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => { if (message === 'claimed') child.kill('SIGKILL'); });
    child.on('error', reject);
    child.on('close', (_code, signal) => { clearTimeout(timeout); signal === 'SIGKILL' ? resolve() : reject(new Error(stderr)); });
  });
  const dead = (await f.store.read()).collectionRequests[id]; assert.equal(dead.phase, 'settled'); assert.equal(dead.selectionAttempts, 1);
  const scheduler = f.start({ store: new FileStateStore(f.storeOptions) });
  await until(() => processed(f, [id])); await scheduler.stop();
  assert.equal((await f.store.read()).collectionRequests[id].selectionAttempts, 2);
  assert.equal(Object.keys((await f.store.read()).operations).length, 1);
});

test('sibling branches are selected separately and neither is silently discarded', async t => {
  const f = await fixture(t); const root = f.session.appendCustomEntry('test-root', {});
  const first = await f.add();
  f.session.branch(root);
  const second = await f.add('I use metric units.');
  const scheduler = f.start(); await until(() => processed(f, [first, second])); await scheduler.stop();
  assert.equal(f.calls.length, 2); assert(f.calls.every(ids => ids.length === 1));
  assert.equal(Object.keys((await f.store.read()).operations).length, 2);
});

test('batch size bounds model input work and remaining completed requests are eventually drained', async t => {
  const f = await fixture(t); const ids = [];
  for (const fact of ['I use metric units.', 'I use ISO dates.', 'I prefer short reports.']) ids.push(await f.add(fact));
  const scheduler = f.start({ maxRequestsPerBatch: 1 }); await until(() => processed(f, ids)); await scheduler.stop();
  assert.equal(f.calls.length, 3); assert(f.calls.every(ids => ids.length === 1));
});

test('a timed out handoff cannot later mutate state, even before its lease would expire', async t => {
  const f = await fixture(t); const id = await f.add();
  const selection = await f.select([id]);
  await f.store.transact(s => { s.collectionRequests[id].selectionLease = { id: 'token', expiresAt: Date.now() + 10000 }; });
  let release; const gate = new Promise(resolve => { release = resolve; }); let entered = false;
  const deferred = new MemoryDelivery({ store: { owner: f.store.owner, read: () => f.store.read(),
    async transact(mutate) { entered = true; await gate; return f.store.transact(mutate); } },
    transport: { owner: f.store.owner }, maxPayloadBytes: 8192 });
  const controller = new AbortController();
  const pending = deferred.collectSelection(selection, 'token', controller.signal);
  await until(() => entered); controller.abort(); release();
  assert.equal((await pending).errorCode, 'MEMORY_SELECTION_ABORTED');
  assert.deepEqual((await f.store.read()).operations, {});
});

test('active and expired claims both forbid an unfenced direct handoff', async t => {
  const f = await fixture(t); const id = await f.add(); const selection = await f.select([id]);
  for (const expiresAt of [Date.now() + 10000, Date.now() - 1]) {
    await f.store.transact(s => { s.collectionRequests[id].selectionLease = { id: 'owner-claim', expiresAt }; });
    assert.equal((await f.delivery.collectSelection(selection)).errorCode, 'MEMORY_COLLECTION_CLAIM_EXPIRED');
    assert.equal((await f.delivery.collectSelection(selection, 'wrong-token')).errorCode, 'MEMORY_COLLECTION_CLAIM_EXPIRED');
  }
  assert.deepEqual((await f.store.read()).operations, {});
});

test('malformed durable claims are rejected without replacing the state file', async t => {
  const f = await fixture(t); const id = await f.add(); const original = await f.store.read();
  await assert.rejects(f.store.transact(s => { s.collectionRequests[id].selectionLease = { id: 'claim', expiresAt: NaN }; }), /INVALID_COLLECTION_CLAIM/);
  assert.deepEqual(await f.store.read(), original);
});

test('real filesystem lock contention is abortable and a cancelled transaction never writes later', async t => {
  const f = await fixture(t); await f.add();
  const { open } = await import('node:fs/promises'); const { flock } = await import('fs-ext');
  const descriptor = await open(join(f.storeOptions.directory, 'state.lock'), 'r+');
  const lock = operation => new Promise((resolve, reject) => flock(descriptor.fd, operation, error => error ? reject(error) : resolve()));
  const before = await f.store.read(); let mutated = false;
  await lock('ex');
  try {
    const controller = new AbortController();
    const read = f.store.read(controller.signal); const write = f.store.transact(s => { mutated = true; s.revision += 100; }, controller.signal);
    const cancelled = Promise.all([assert.rejects(read, /abort/i), assert.rejects(write, /abort/i)]);
    await delay(30); controller.abort(); await cancelled;
    assert.equal(mutated, false);
  } finally { await lock('un'); await descriptor.close(); }
  assert.deepEqual(await f.store.read(), before);
});


test('pending governance holds model claims without spending retries, then new work can resume', async t => {
  const f = await fixture(t);
  const old = await f.add();
  const job = await new MemoryGovernanceBarrier(f.store).begin({ kind: 'clear', scope: null });
  const fresh = await f.add('A new preference after the clearing boundary.');
  const scheduler = f.start();
  await delay(150);
  assert.equal(f.calls.length, 0);
  const held = await f.store.read();
  assert.equal(held.collectionRequests[old].phase, 'discarded');
  assert.equal(held.collectionRequests[fresh].selectionAttempts, undefined);
  // Test-only coordinator completion; remote clearing is outside this test.
  await f.store.transact(state => { state.governance.jobs[job.id].phase = 'complete'; });
  scheduler.wake(); await until(() => processed(f, [fresh])); await scheduler.stop();
  assert.deepEqual(f.calls, [[fresh]]);
});
