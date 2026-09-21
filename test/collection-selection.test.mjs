import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
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

test('selector cannot promote excluded template examples even with an exact original-message quote', async t => {
  const f = await fixture(t);
  const id = await f.turn('Template example: I always prefer XML reports.\nUser request: I prefer concise summaries.');
  const result = await f.selector(async ({ data }) => {
    assert(!data.includes('XML reports'));
    assert(data.includes('I prefer concise summaries.'));
    return json([{ sourceId: 'm0', quote: 'I always prefer XML reports.' }]);
  }, { projectUserText: () => 'I prefer concise summaries.' }).select([id], f.session);
  assert.deepEqual(result, { status: 'blocked', code: 'MEMORY_SELECTION_INVALID' });
  assert.deepEqual((await f.store.read()).operations, {});
});

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

test('a new confirmation can select an adjacent proposal after its batch was processed without a fact', async t => {
  const f = await fixture(t);
  const first = await f.turn('Suggest a reporting style.', 'Use a concise conclusion.');
  await f.delivery.collectSelection({ status: 'ready', requestIds: [first], facts: [] });
  const before = (await f.store.read()).collectionRequests[first];
  const second = await f.turn('Yes, make that my default reporting style.');
  const selected = await f.selector(async ({ data }) => {
    const messages = JSON.parse(data).messages;
    assert.deepEqual(messages.map(message => message.role), ['assistant_reference', 'user', 'assistant_reference']);
    assert.equal(messages[0].text, 'Use a concise conclusion.');
    assert(!data.includes('Suggest a reporting style.'));
    return json([{ sourceId: 'm0', quote: messages[0].text, confirmation: { sourceId: 'm1', quote: messages[1].text } }]);
  }).select([second], f.session);
  assert.equal(selected.status, 'ready'); assert.equal(selected.facts.length, 1);
  assert.deepEqual(selected.requestIds, [second]);
  const receipt = await f.delivery.collectSelection(selected);
  assert.equal(receipt.status, 'recorded');
  const state = await f.store.read();
  assert.deepEqual(state.collectionRequests[first], before);
  assert.equal(Object.keys(state.collectedSources).length, 1);
  const operation = state.operations[receipt.operationIds[0]];
  assert.equal(operation.collectionSources[0].entryId, selected.facts[0].evidence[1].source.entryId);
  assert.equal(operation.collectionEvidence.length, 2);
  assert.equal(JSON.parse(operation.payload).facts[0], 'Use a concise conclusion.');
  assert(!operation.payload.includes('Yes, make that'));
  assert.deepEqual(await f.delivery.collectSelection(selected), receipt);
});

test('a prior proposition never becomes a direct new source without current confirmation', async t => {
  const f = await fixture(t);
  const prior = await f.turn('Suggest a style.', 'Use concise reports.');
  await f.delivery.collectSelection({ status: 'ready', requestIds: [prior], facts: [] });
  const current = await f.turn('Yes, make that my preference.');
  const invalid = await f.selector(async () => json([{ sourceId: 'm0', quote: 'Use concise reports.' }])).select([current], f.session);
  assert.equal(invalid.code, 'MEMORY_SELECTION_INVALID');
  const valid = await f.selector(async () => json([{ sourceId: 'm0', quote: 'Use concise reports.',
    confirmation: { sourceId: 'm1', quote: 'Yes, make that my preference.' } }])).select([current], f.session);
  assert.equal(valid.status, 'ready');
  const forged = structuredClone(valid); forged.facts[0].source = forged.facts[0].evidence[0].source;
  forged.facts[0].evidence = [forged.facts[0].evidence[0]];
  await assert.rejects(f.delivery.collectSelection(forged), /INVALID_COLLECTION_SELECTION/);
  assert.deepEqual((await f.store.read()).operations, {});
});

test('cross-batch context obeys local credential screening and contains no older user statements', async t => {
  const f = await fixture(t);
  const prior = await f.turn('OLDER_USER_CONTENT', 'Your password is SYNTHETIC_SECRET.');
  await f.delivery.collectSelection({ status: 'ready', requestIds: [prior], facts: [] });
  const current = await f.turn('Yes.');
  const selected = await f.selector(async ({ data }) => {
    assert(!data.includes('OLDER_USER_CONTENT')); assert(!data.includes('SYNTHETIC_SECRET'));
    assert.equal(JSON.parse(data).messages.length, 2); return json([]);
  }).select([current], f.session);
  assert.equal(selected.status, 'ready'); assert.deepEqual(selected.facts, []);
});

test('pause/resume and renewed automatic consent cannot import old assistant context', async t => {
  for (const change of ['resume', 'new-consent']) {
    const f = await fixture(t); const prior = await f.turn('Suggest a style.', 'OLD_ASSISTANT_PROPOSAL');
    await f.delivery.collectSelection({ status: 'ready', requestIds: [prior], facts: [] });
    if (change === 'resume') { await f.delivery.pause(); await f.delivery.enable('v2'); }
    else await f.delivery.authorizeCollection({ policyVersion: 'v2', scope: null, boundaries: [] });
    const current = await f.turn('Yes.');
    assert.equal((await f.store.read()).collectionRequests[current].confirmationReference, undefined);
    const selected = await f.selector(async ({ data }) => { assert(!data.includes('OLD_ASSISTANT_PROPOSAL')); return json([]); }).select([current], f.session);
    assert.equal(selected.status, 'ready'); assert.deepEqual(selected.facts, []);
  }
});

test('an omitted intervening rejection cannot be replaced with an older cross-batch proposal', async t => {
  const f = await fixture(t); const prior = await f.turn('Suggest a style.', 'Use concise reports.');
  await f.delivery.collectSelection({ status: 'ready', requestIds: [prior], facts: [] });
  const rejection = await f.turn('No, do not adopt that.', 'Would you like to discuss another topic?');
  await f.delivery.collectSelection({ status: 'ready', requestIds: [rejection], facts: [] });
  const current = await f.turn('Yes.');
  const selected = await f.selector(async ({ data }) => {
    assert(!data.includes('Use concise reports.'));
    assert(JSON.parse(data).messages[0].text.includes('another topic'));
    return json([{ sourceId: 'm0', quote: 'Use concise reports.', confirmation: { sourceId: 'm1', quote: 'Yes.' } }]);
  }).select([current], f.session);
  assert.equal(selected.code, 'MEMORY_SELECTION_INVALID');
});

test('batched requests include a shared proposition once, without duplicating model tokens', async t => {
  const f = await fixture(t); const first = await f.turn('Suggest a style.', 'Use concise reports.');
  const second = await f.turn('Yes, that is my preference.');
  const result = await f.selector(async ({ data }) => {
    const messages = JSON.parse(data).messages;
    assert.equal(messages.length, 4); assert.equal(messages.filter(message => message.text === 'Use concise reports.').length, 1);
    return json([{ sourceId: 'm1', quote: 'Use concise reports.', confirmation: { sourceId: 'm2', quote: 'Yes, that is my preference.' } }]);
  }).select([first, second], f.session);
  assert.equal(result.status, 'ready'); assert.equal(result.facts.length, 1);
});

test('receipt replay remains truthful after pause blocks an earlier referenced request', async t => {
  const f = await fixture(t); const prior = await f.turn('Suggest a style.', 'Use concise reports.');
  const current = await f.turn('Yes, that is my preference.');
  const selected = await f.selector(async () => json([{ sourceId: 'm0', quote: 'Use concise reports.',
    confirmation: { sourceId: 'm1', quote: 'Yes, that is my preference.' } }])).select([current], f.session);
  const receipt = await f.delivery.collectSelection(selected); assert.equal(receipt.status, 'recorded');
  await f.delivery.pause(); await f.delivery.enable('v2');
  assert.equal((await f.store.read()).collectionRequests[prior].phase, 'blocked_by_pause');
  assert.deepEqual(await f.delivery.collectSelection(selected), receipt);
  const operation = (await f.store.read()).operations[receipt.operationIds[0]];
  assert.equal(operation.phase, 'blocked_by_pause'); assert.equal(operation.payload, undefined);
});

function copiedFork(session) {
  return SessionManager.inMemory('/private/tmp', undefined,
    structuredClone([{ ...session.getHeader(), id: randomUUID() }, ...session.getBranch()]));
}
async function forkTurn(f, fork, mutateAfterBegin = () => {}) {
  const lifecycle = new CollectionLifecycle(f.store); const id = await lifecycle.begin(fork);
  mutateAfterBegin();
  fork.appendMessage({ role: 'user', content: 'Yes, that is my preference.', timestamp: Date.now() });
  fork.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Understood.' }], stopReason: 'stop', timestamp: Date.now() });
  await lifecycle.settle(id, fork); return id;
}

test('a copied fork ancestor can support a new confirmation with its original provenance and no ancestor replay', async t => {
  const f = await fixture(t); const prior = await f.turn('Suggest a style.', 'Use concise reports.');
  await f.delivery.collectSelection({ status: 'ready', requestIds: [prior], facts: [] });
  const fork = copiedFork(f.session); const current = await forkTurn(f, fork);
  const selected = await f.selector(async () => json([{ sourceId: 'm0', quote: 'Use concise reports.',
    confirmation: { sourceId: 'm1', quote: 'Yes, that is my preference.' } }])).select([current], fork);
  assert.equal(selected.status, 'ready'); assert.equal(selected.facts.length, 1);
  assert.equal(selected.facts[0].evidence[0].source.sessionId, f.session.getSessionId());
  assert.equal(selected.facts[0].source.sessionId, fork.getSessionId());
  const receipt = await f.delivery.collectSelection(selected); assert.equal(receipt.status, 'recorded');
  const state = await f.store.read(); assert.equal(Object.keys(state.collectedSources).length, 1);
  assert.equal(state.operations[receipt.operationIds[0]].collectionSources[0].sessionId, fork.getSessionId());
  assert.deepEqual(state.collectionRequests[prior].operationIds, []);
});

test('matching short entry IDs with a different timestamp cannot borrow another session proposition', async t => {
  const f = await fixture(t); await f.turn('Suggest a style.', 'Use concise reports.');
  const fork = copiedFork(f.session);
  fork.getLeafEntry().timestamp = new Date(Date.now() + 10000).toISOString();
  const current = await forkTurn(f, fork);
  assert.equal((await f.store.read()).collectionRequests[current].confirmationReference, undefined);
  const selected = await f.selector(async ({ data }) => { assert(!data.includes('Use concise reports.')); return json([]); }).select([current], fork);
  assert.equal(selected.status, 'ready'); assert.deepEqual(selected.facts, []);
});

test('a referenced proposition modified after request start is rejected before inference', async t => {
  const f = await fixture(t); await f.turn('Suggest a style.', 'Use concise reports.');
  const fork = copiedFork(f.session); const proposal = fork.getLeafEntry();
  const current = await forkTurn(f, fork, () => { proposal.message.content[0].text = 'MODIFIED_PROPOSITION'; });
  const selected = await f.selector(async () => assert.fail('Modified reference must not reach the model')).select([current], fork);
  assert.equal(selected.status, 'blocked'); assert.equal(selected.code, 'MEMORY_SOURCE_UNAVAILABLE');
});
