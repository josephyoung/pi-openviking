import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CollectionLifecycle, FileStateStore, MemoryDelivery, createOpenVikingExtension } from '../dist/host.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const transport = { owner };
  const delivery = new MemoryDelivery({ store, transport, maxPayloadBytes: 8192 });
  const recreate = () => new CollectionLifecycle(new FileStateStore({ owner, directory, policyVersion: 'v1' }));
  const pi = SessionManager.inMemory('/private/tmp');
  return { store, delivery, pi, recreate, directory, owner, transport };
}
const user = (pi, content = 'I prefer concise reports.') => pi.appendMessage({ role: 'user', content, timestamp: Date.now() });
const assistant = (pi, stopReason = 'stop') => pi.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'SYNTHETIC_ASSISTANT_BODY' }], stopReason, timestamp: Date.now() });
async function grant(f) {
  await f.delivery.enable('v1');
  await f.delivery.authorizeCollection({ policyVersion: 'v1', scope: null,
    boundaries: [{ sessionId: f.pi.getSessionId(), entryId: f.pi.getLeafId(), branchId: f.pi.getLeafId() }] });
}

test('separate consent is required and a short completed request records only new entry references', async t => {
  const f = await setup(t);
  user(f.pi, 'OLD_PRIVATE_BODY');
  assistant(f.pi);
  assert.equal(await f.recreate().begin(f.pi), undefined);
  await f.delivery.enable('v1');
  assert.equal(await f.recreate().begin(f.pi), undefined);
  await grant(f);
  const lifecycle = f.recreate();
  const id = await lifecycle.begin(f.pi);
  const input = user(f.pi, 'NEW_PRIVATE_BODY');
  const output = assistant(f.pi);
  const receipt = await f.recreate().settle(id, f.pi);
  assert.equal(receipt.phase, 'settled');
  assert.deepEqual(receipt.sourceEntries, [input, output]);
  const disk = await readFile(join(f.directory, 'state.json'), 'utf8');
  assert(!/PRIVATE_BODY|SYNTHETIC_ASSISTANT_BODY/.test(disk));
  assert.deepEqual((await f.store.read()).operations, {});
});

test('retries and queued continuations keep the original boundary until final settlement', async t => {
  const f = await setup(t); await grant(f);
  const lifecycle = f.recreate();
  const id = await lifecycle.begin(f.pi);
  const first = user(f.pi);
  assistant(f.pi, 'error');
  assert.equal(await lifecycle.begin(f.pi, id), id);
  const continuation = user(f.pi, 'Please add a short conclusion.');
  const end = assistant(f.pi);
  const result = await lifecycle.settle(id, f.pi);
  assert.equal(result.phase, 'settled');
  assert(result.sourceEntries.includes(first));
  assert(result.sourceEntries.includes(continuation));
  assert.equal(result.settledEntryId, end);
  assert.deepEqual(await f.recreate().settle(id, f.pi), result);
});

for (const stop of ['aborted', 'error', 'toolUse', 'length']) {
  test(`final ${stop} cannot authorize collection of a partial request`, async t => {
    const f = await setup(t); await grant(f);
    const id = await f.recreate().begin(f.pi);
    user(f.pi); assistant(f.pi, stop);
    const receipt = await f.recreate().settle(id, f.pi);
    assert.equal(receipt.phase, 'discarded');
    assert.deepEqual(receipt.sourceEntries, []);
  });
}

test('UI wait and an unsettled process restart do not masquerade as completed requests', async t => {
  const f = await setup(t); await grant(f);
  const old = await f.recreate().begin(f.pi);
  user(f.pi); assistant(f.pi);
  assert.equal((await f.recreate().settle(old, f.pi, true)).phase, 'running');
  // A fresh run has no in-process continuation token, even in the same session.
  const current = await f.recreate().begin(f.pi);
  assert.notEqual(current, old);
  assert.equal((await f.store.read()).collectionRequests[old].phase, 'discarded');
  const fresh = user(f.pi); const end = assistant(f.pi);
  assert.deepEqual((await f.recreate().settle(current, f.pi)).sourceEntries, [fresh, end]);
});

test('pause across another runtime blocks both unfinished and settled requests permanently', async t => {
  const f = await setup(t); await grant(f);
  const settled = await f.recreate().begin(f.pi);
  user(f.pi); assistant(f.pi);
  await f.recreate().settle(settled, f.pi);
  const running = await f.recreate().begin(f.pi);
  user(f.pi);
  await f.delivery.pause();
  await f.delivery.enable('v2');
  assistant(f.pi);
  assert.equal((await f.recreate().settle(running, f.pi)).phase, 'blocked_by_pause');
  assert.equal((await f.recreate().settle(settled, f.pi)).phase, 'blocked_by_pause');
});

test('tree divergence rejects the old anchor and a fork starts after its shared ancestors', async t => {
  const f = await setup(t); await grant(f);
  const ancestor = user(f.pi); assistant(f.pi);
  const id = await f.recreate().begin(f.pi);
  f.pi.branch(ancestor);
  user(f.pi); assistant(f.pi);
  assert.equal((await f.recreate().settle(id, f.pi)).phase, 'discarded');
  f.pi.createBranchedSession(f.pi.getLeafId());
  assert.equal(await f.recreate().settle(id, f.pi), undefined);
  const fork = await f.recreate().begin(f.pi);
  const fresh = user(f.pi); const end = assistant(f.pi);
  assert.deepEqual((await f.recreate().settle(fork, f.pi)).sourceEntries, [fresh, end]);
});

test('extension records settlement only on agent_settled, after intermediate tool rounds', async t => {
  const f = await setup(t); await grant(f);
  const handlers = new Map();
  createOpenVikingExtension({ owner: f.owner, client: f.transport, stateStore: f.store,
    assertToolIsolation: async () => {}, wakeDelivery() {},
    collection: { sessions: { async register() {}, async boundaries() { return []; } }, lifecycleTimeoutMs: 2000, wake() {} },
    policy: { maxPayloadBytes: 8192, recallTimeoutMs: 50, recallTokenBudget: 1000, recallLimit: 5,
      minimumScore: 0.5, countTokens: text => text.length } })({
      on: (name, handler) => handlers.set(name, handler), registerTool() {},
    });
  const ctx = { sessionManager: f.pi };
  await handlers.get('before_agent_start')({ prompt: 'query' }, ctx);
  user(f.pi); assistant(f.pi, 'toolUse');
  assert(!handlers.has('turn_end'));
  assert(!handlers.has('agent_end'));
  const request = Object.values((await f.store.read()).collectionRequests)[0];
  assert.equal(request.phase, 'running');
  assistant(f.pi);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal((await f.store.read()).collectionRequests[request.id].phase, 'settled');
});
