import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CollectionFactSelector, CollectionLifecycle, FileStateStore, MemoryDelivery } from '../dist/host.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  const session = SessionManager.inMemory('/private/tmp');
  const lifecycle = new CollectionLifecycle(store);
  await delivery.enable('v1');
  await delivery.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] });
  const turn = async (user, assistant = 'Understood.') => {
    const id = await lifecycle.begin(session);
    session.appendMessage({ role: 'user', content: user, timestamp: Date.now() });
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: assistant }], stopReason: 'stop', timestamp: Date.now() });
    await lifecycle.settle(id, session);
    return id;
  };
  const selector = (complete, extra = {}) => new CollectionFactSelector({ store, maxInputBytes: 8192,
    maxFacts: 5, timeoutMs: 1000, complete, ...extra });
  return { store, delivery, session, turn, selector };
}
const json = facts => JSON.stringify({ facts });

test('user facts retain exact source evidence; duplicates and irrelevant optional fields do not create extra facts', async t => {
  const f = await fixture(t);
  const id = await f.turn('I prefer concise reports.');
  const result = await f.selector(async ({ data }) => {
    const messages = JSON.parse(data).messages;
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant_reference');
    assert(!data.includes(f.session.getSessionId()));
    return json([{ sourceId: 'm0', quote: messages[0].text, extra: 'ignored' }, { sourceId: 'm0', quote: messages[0].text }]);
  }).select([id, id], f.session);
  assert.equal(result.status, 'ready');
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].text, 'I prefer concise reports.');
  assert.equal(result.facts[0].evidence.length, 1);
  assert.deepEqual((await f.store.read()).operations, {});
});

test('confirmed assistant proposals need the immediately following user and use that confirmation as their source', async t => {
  const f = await fixture(t);
  const first = await f.turn('Suggest a reporting style.', 'Use a concise conclusion.');
  const second = await f.turn('Yes, use that as my default reporting preference.');
  // Deliberately reverse caller order. Stable persisted entry order wins.
  const result = await f.selector(async () => json([{ sourceId: 'm1', quote: 'Use a concise conclusion.',
    confirmation: { sourceId: 'm2', quote: 'Yes, use that as my default reporting preference.' } }])).select([second, first], f.session);
  assert.equal(result.status, 'ready');
  assert.equal(result.facts[0].evidence.length, 2);
  assert.equal(result.facts[0].source.entryId, result.facts[0].evidence[1].source.entryId);
  assert.deepEqual(result.requestIds, [first, second]);
});

for (const [name, reply] of [
  ['invented text', json([{ sourceId: 'm0', quote: 'A fabricated preference.' }])],
  ['unknown source', json([{ sourceId: 'm99', quote: 'I prefer concise reports.' }])],
  ['assistant without confirmation', json([{ sourceId: 'm1', quote: 'Understood.' }])],
  ['confirmation preceding proposal', json([{ sourceId: 'm1', quote: 'Understood.', confirmation: { sourceId: 'm0', quote: 'I prefer concise reports.' } }])],
  ['user request misrepresented as a confirmed proposal', json([{ sourceId: 'm0', quote: 'I prefer concise reports.', confirmation: { sourceId: 'm1', quote: 'Understood.' } }])],
  ['malformed output', 'PRIVATE_DIAGNOSTIC_NOT_JSON'],
]) {
  test(`${name} cannot yield an accepted candidate`, async t => {
    const f = await fixture(t); const id = await f.turn('I prefer concise reports.');
    assert.deepEqual(await f.selector(async () => reply).select([id], f.session),
      { status: 'blocked', code: 'MEMORY_SELECTION_INVALID' });
  });
}

test('omitting a middle request cannot make a later yes confirm an earlier rejected proposal', async t => {
  const f = await fixture(t);
  const first = await f.turn('Suggest a style.', 'Use concise reports.');
  await f.turn('No, I reject that suggestion.', 'Should we discuss something else?');
  const last = await f.turn('Yes.');
  const result = await f.selector(async () => json([{ sourceId: 'm1', quote: 'Use concise reports.',
    confirmation: { sourceId: 'm2', quote: 'Yes.' } }])).select([first, last], f.session);
  assert.deepEqual(result, { status: 'blocked', code: 'MEMORY_SELECTION_INVALID' });
});

test('no remaining user candidates means no model call; secrets never reach the selector', async t => {
  const f = await fixture(t); const id = await f.turn('password=SYNTHETIC_SECRET');
  const result = await f.selector(async () => { assert.fail('Model must not be called'); }).select([id], f.session);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.facts, []);
});

test('pause during inference invalidates a late result, even after memory resumes', async t => {
  const f = await fixture(t); const id = await f.turn('I prefer concise reports.');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pending = f.selector(async () => { entered(); await gate; return json([{ sourceId: 'm0', quote: 'I prefer concise reports.' }]); }).select([id], f.session);
  await started; await f.delivery.pause(); await f.delivery.enable('v2'); release();
  assert.deepEqual(await pending, { status: 'blocked', code: 'MEMORY_COLLECTION_NOT_AUTHORIZED' });
});

test('timeout bounds an uncooperative model and aborts its signal without exposing error details', async t => {
  const f = await fixture(t); const id = await f.turn('I prefer concise reports.');
  let modelSignal;
  const result = await f.selector(async ({ signal }) => { modelSignal = signal; return new Promise(() => {}); },
    { timeoutMs: 500 }).select([id], f.session);
  assert.deepEqual(result, { status: 'blocked', code: 'MEMORY_SELECTION_ABORTED' });
  assert(modelSignal, 'The uncooperative model must actually be called');
  assert(modelSignal.aborted);
  assert.deepEqual(await f.selector(async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); }).select([id], f.session),
    { status: 'blocked', code: 'MEMORY_SELECTION_FAILED' });
});

test('already aborted work and cross-branch batches cannot call a model', async t => {
  const f = await fixture(t); const first = await f.turn('I prefer concise reports.');
  const selector = f.selector(async () => { assert.fail('Model must not be called'); });
  assert.deepEqual(await selector.select([first], f.session, AbortSignal.abort()),
    { status: 'blocked', code: 'MEMORY_SELECTION_ABORTED' });
  f.session.resetLeaf();
  const other = await f.turn('I prefer detailed reports.');
  assert.deepEqual(await selector.select([first, other], f.session),
    { status: 'blocked', code: 'MEMORY_SOURCE_UNAVAILABLE' });
});


test('a single JSON code fence is a recoverable presentation wrapper, not a new source', async t => {
  const f = await fixture(t); const id = await f.turn('I prefer concise reports.');
  const result = await f.selector(async () => '```json\n' + json([{ sourceId: 'm0', quote: 'I prefer concise reports.' }]) + '\n```').select([id], f.session);
  assert.equal(result.status, 'ready');
  assert.equal(result.facts[0].text, 'I prefer concise reports.');
});
