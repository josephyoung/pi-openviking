import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CollectionLifecycle, FileStateStore, MemoryDelivery } from '../dist/host.js';

async function fixture(t, maxPayloadBytes = 8192, texts = ['I prefer concise reports.', 'I use metric units.']) {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const options = { owner, directory: join(root, 'state'), policyVersion: 'v1' };
  const store = new FileStateStore(options);
  const calls = [];
  const transport = { owner, async createSession() { calls.push('create'); }, async append() { calls.push('append'); },
    async commit() { calls.push('commit'); return { taskId: 'task' }; },
    async inspect() { return { status: 'ready', archiveId: 'archive', memoryUris: ['memory'] }; } };
  const recreate = () => new MemoryDelivery({ store: new FileStateStore(options), transport, maxPayloadBytes });
  const delivery = recreate();
  await delivery.enable('v1');
  await delivery.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] });
  const lifecycle = new CollectionLifecycle(store);
  const session = SessionManager.inMemory('/private/tmp');
  const selection = { status: 'ready', requestIds: [], facts: [] };
  for (const text of texts) {
    const request = await lifecycle.begin(session);
    const id = session.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Understood.' }], stopReason: 'stop', timestamp: Date.now() });
    await lifecycle.settle(request, session);
    const entry = session.getEntry(id);
    const source = { sessionId: session.getSessionId(), entryId: id, entryTimestamp: entry.timestamp,
      branchId: session.getLeafId(), contentVersion: createHash('sha256').update(JSON.stringify(entry.message)).digest('hex') };
    selection.requestIds.push(request);
    selection.facts.push({ source, text, evidence: [{ source, quote: text }] });
  }
  return { root, options, store, transport, delivery, recreate, calls, selection };
}
const subset = (selection, index) => ({ status: 'ready', requestIds: [selection.requestIds[index]], facts: [selection.facts[index]] });

test('selection and independent fact outbox operations survive reopening together', async t => {
  const f = await fixture(t);
  const receipt = await f.delivery.collectSelection(f.selection);
  assert.equal(receipt.status, 'recorded'); assert.equal(receipt.operationIds.length, 2);
  const state = await new FileStateStore(f.options).read();
  assert(Object.values(state.collectionRequests).every(request => request.phase === 'processed'));
  assert.equal(Object.keys(state.collectedSources).length, 2);
  const operations = receipt.operationIds.map(id => state.operations[id]);
  assert(operations.every(operation => operation.collectionSources.length === 1));
  assert(operations.every(operation => operation.collectionEvidence.every(item => !('quote' in item) && /^[a-f0-9]{64}$/.test(item.quoteDigest))));
  assert.deepEqual(new Set(operations.flatMap(operation => JSON.parse(operation.payload).facts)),
    new Set(f.selection.facts.map(fact => fact.text)));
  assert.deepEqual(f.calls, []);
  const reordered = { ...f.selection, requestIds: [...f.selection.requestIds].reverse(), facts: [...f.selection.facts].reverse() };
  assert.deepEqual(await f.recreate().collectSelection(reordered), receipt);
  for (const operation of operations) for (let i = 0; i < 4; i++) await f.recreate().advance(operation.id);
  assert.deepEqual(f.calls, ['create', 'append', 'commit', 'create', 'append', 'commit']);
  const delivered = await f.store.read();
  assert(operations.every(operation => delivered.operations[operation.id].payload === undefined));
  assert.deepEqual(await f.recreate().collectSelection(f.selection), receipt);
});

test('concurrent handoffs persist each fact only once', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.recreate().collectSelection(f.selection)));
  assert.equal(new Set(results.map(result => result.operationIds.join(','))).size, 1);
  assert.equal(Object.keys((await f.store.read()).operations).length, 2);
});

test('a replay after pause returns the old blocked receipt without restoring its payload', async t => {
  const f = await fixture(t);
  const receipt = await f.delivery.collectSelection(f.selection);
  await f.delivery.pause(); await f.delivery.enable('v2');
  assert.deepEqual(await f.recreate().collectSelection(f.selection), receipt);
  const state = await f.store.read();
  assert(receipt.operationIds.every(id => state.operations[id].phase === 'blocked_by_pause'
    && state.operations[id].payload === undefined));
  assert.equal(Object.keys(state.operations).length, 2);
});

test('pause before handoff and partially consumed batches cannot advance remaining sources', async t => {
  const f = await fixture(t);
  await f.delivery.collectSelection(subset(f.selection, 0));
  assert.equal((await f.delivery.collectSelection(f.selection)).status, 'blocked');
  assert.equal((await f.store.read()).collectionRequests[f.selection.requestIds[1]].phase, 'settled');
  await f.delivery.pause(); await f.delivery.enable('v2');
  assert.equal((await f.delivery.collectSelection(subset(f.selection, 1))).status, 'blocked');
  assert.equal(Object.keys((await f.store.read()).operations).length, 1);
});

test('no-fact decisions persist without an empty remote extraction', async t => {
  const f = await fixture(t); f.selection.facts = [];
  const receipt = await f.delivery.collectSelection(f.selection);
  assert.deepEqual(receipt, { status: 'recorded', operationIds: [] });
  assert.deepEqual(await f.recreate().collectSelection(f.selection), receipt);
  const state = await f.store.read();
  assert(Object.values(state.collectionRequests).every(request => request.phase === 'processed'));
  assert.deepEqual(state.operations, {});
});

test('changed decisions and foreign sources cannot overwrite completed provenance', async t => {
  const f = await fixture(t);
  await f.delivery.collectSelection(f.selection);
  const changed = structuredClone(f.selection); changed.facts = [];
  assert.equal((await f.delivery.collectSelection(changed)).errorCode, 'MEMORY_COLLECTION_BATCH_CONFLICT');
  const foreign = structuredClone(f.selection); foreign.facts[0].source.entryId = 'foreign';
  await assert.rejects(f.delivery.collectSelection(foreign), /INVALID_COLLECTION_SELECTION/);
  assert.equal(Object.keys((await f.store.read()).operations).length, 2);
});

test('oversized coalesced facts do not persist partial progress', async t => {
  const f = await fixture(t, 20);
  assert.equal((await f.delivery.collectSelection(f.selection)).errorCode, 'MEMORY_COLLECTION_INPUT_LIMIT');
  const state = await f.store.read();
  assert(Object.values(state.collectionRequests).every(request => request.phase === 'settled'));
  assert.deepEqual(state.operations, {}); assert.equal(state.collectedSources, undefined);
});

async function killedChild(f, mode) {
  const input = join(f.root, 'selection.json');
  await writeFile(input, JSON.stringify({ options: f.options, selection: f.selection }), { mode: 0o600 });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['test/collection-handoff-writer.mjs', input, mode], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('close', (_code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(errors || 'Child did not reach crash point')));
  });
}

for (const crash of ['before-commit', 'after-commit']) {
  test(`SIGKILL ${crash} leaves either the entire old state or the entire durable handoff`, async t => {
    const f = await fixture(t);
    await killedChild(f, crash);
    const state = await f.store.read();
    const committed = crash === 'after-commit';
    assert.equal(Object.keys(state.operations).length, committed ? 2 : 0);
    assert(Object.values(state.collectionRequests).every(request => request.phase === (committed ? 'processed' : 'settled')));
    const receipt = await f.recreate().collectSelection(f.selection);
    assert.equal(receipt.operationIds.length, 2);
    assert.equal(Object.keys((await f.store.read()).operations).length, 2);
    assert.equal(Object.keys((await f.store.read()).collectedSources).length, 2);
  });
}


test('multiple facts in one source have independent receipts and remote sessions', async t => {
  const f = await fixture(t, 8192, ['I prefer concise reports. I use metric units.']);
  const source = f.selection.facts[0].source;
  f.selection.facts = ['I prefer concise reports.', 'I use metric units.'].map(text => ({ source, text, evidence: [{ source, quote: text }] }));
  const receipt = await f.delivery.collectSelection(f.selection);
  const state = await f.store.read();
  assert.equal(Object.keys(state.collectedSources).length, 2);
  assert.equal(receipt.operationIds.length, 2);
  assert(receipt.operationIds.every(id => JSON.parse(state.operations[id].payload).facts.length === 1));
  const repeated = await fixture(t, 8192, ['I use metric units.', 'I use metric units.']);
  const duplicateReceipt = await repeated.delivery.collectSelection(repeated.selection);
  const duplicateState = await repeated.store.read();
  assert.equal(Object.keys(duplicateState.collectedSources).length, 2);
  assert.equal(duplicateReceipt.operationIds.length, 2);
  assert(duplicateReceipt.operationIds.every(id =>
    JSON.parse(duplicateState.operations[id].payload).facts[0] === 'I use metric units.'));
});
