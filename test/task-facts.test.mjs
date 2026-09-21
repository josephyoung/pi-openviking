import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CollectionInputBuilder, CollectionLifecycle, CollectionFactSelector, FileStateStore, MemoryDelivery } from '../dist/host.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-task-facts-')); t.after(() => rm(root, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const store = new FileStateStore({ owner, directory: root, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1'); await delivery.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] });
  const session = SessionManager.inMemory('/private/tmp'); const lifecycle = new CollectionLifecycle(store);
  const task = async (options = {}) => {
    const id = await lifecycle.begin(session);
    session.appendMessage({ role: 'user', content: options.user ?? 'Create the requested work item.', timestamp: Date.now() });
    if (!options.missingCall) session.appendMessage({ role: 'assistant', stopReason: 'toolUse', timestamp: Date.now(),
      content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'toolCall', id: 'call', name: options.callName ?? 'create_work_item', arguments: { secret: 'PRIVATE_ARGUMENT' } }] });
    const result = { role: 'toolResult', toolCallId: 'call', toolName: options.resultName ?? 'create_work_item',
      timestamp: Date.now(), isError: options.isError ?? false, content: [{ type: 'text', text: 'PRIVATE_RAW_TOOL_BODY' }],
      details: { itemId: 'TASK-42', completed: true, createdBy: owner.userId, secret: 'PRIVATE_RESULT_CREDENTIAL' } };
    const sourceId = session.appendMessage(result); if (options.duplicate) session.appendMessage(result);
    session.appendMessage({ role: 'assistant', stopReason: options.stopReason ?? 'stop', content: [{ type: 'text', text: 'Done.' }], timestamp: Date.now() });
    await lifecycle.settle(id, session); return { id, sourceId };
  };
  const input = (taskFacts, extra = {}) => new CollectionInputBuilder({ store, maxInputBytes: 8192, taskFacts, ...extra });
  const selector = (taskFacts, complete, extra = {}) => new CollectionFactSelector({ store, maxInputBytes: 8192, maxFacts: 5, timeoutMs: 1000, taskFacts, complete, ...extra });
  return { root, owner, store, delivery, session, task, input, selector };
}
const policy = (project, version = 'v1') => ({ policyVersion: version, tools: new Map([['create_work_item', project]]) });
const safe = (result, context) => result.details.completed === true && result.details.createdBy === context.owner.userId
  && /^TASK-[0-9]+$/.test(result.details.itemId) ? `Work item ${result.details.itemId} was created.` : undefined;

test('only a matching successful allowlisted tool is projected; raw data never reaches selection or outbox', async t => {
  const f = await fixture(t); const { id, sourceId } = await f.task(); let projected = 0;
  const selected = await f.selector(policy((result, context) => {
    projected++; assert.deepEqual(context.owner, f.owner); assert.equal(context.scope, null);
    const text = safe(result, context); result.details.secret = 'MUTATED_COPY'; return text;
  }), async ({ data }) => {
    assert(!/PRIVATE_|MUTATED_COPY/.test(data));
    const fact = JSON.parse(data).messages.find(message => message.role === 'task_fact'); assert(fact);
    return JSON.stringify({ facts: [{ sourceId: fact.sourceId, quote: fact.text }] });
  }).select([id], f.session);
  assert.equal(selected.status, 'ready'); assert.equal(projected, 1);
  assert.equal(f.session.getEntry(sourceId).message.details.secret, 'PRIVATE_RESULT_CREDENTIAL');
  assert.deepEqual(selected.facts[0].projection, { toolName: 'create_work_item', policyVersion: 'v1' });
  const receipt = await f.delivery.collectSelection(selected); assert.equal(receipt.status, 'recorded');
  const operation = (await f.store.read()).operations[receipt.operationIds[0]];
  assert.equal(operation.collectionSources[0].entryId, sourceId);
  assert.deepEqual(operation.collectionEvidence[0].projection, selected.facts[0].projection);
  assert.deepEqual(JSON.parse(operation.payload).facts, ['Work item TASK-42 was created.']);
  assert(!(await readFile(join(f.root, 'state.json'), 'utf8')).includes('PRIVATE_'));
  await f.delivery.pause(); await f.delivery.enable('v2');
  assert.deepEqual(await f.delivery.collectSelection(selected), receipt);
  assert.equal((await f.store.read()).operations[operation.id].payload, undefined);
});

for (const [name, options] of [
  ['non-allowlisted tool', { resultName: 'bash', callName: 'bash' }],
  ['failed tool', { isError: true }], ['missing original call', { missingCall: true }],
  ['mismatched call', { callName: 'different_tool' }], ['duplicate result', { duplicate: true }],
  ['aborted request', { stopReason: 'aborted' }],
]) test(`${name} cannot invoke the projection adapter`, async t => {
  const f = await fixture(t); const { id } = await f.task(options);
  const input = await f.input(policy(() => assert.fail('Adapter must not run'))).build(id, f.session);
  if (input.status === 'ready') assert(!input.messages.some(message => message.role === 'task_fact'));
});

test('default tool exclusion and policy revision mismatch do not call projectors', async t => {
  const f = await fixture(t); const { id } = await f.task();
  const none = await f.input().build(id, f.session); assert(!none.messages.some(message => message.role === 'task_fact'));
  const mismatch = await f.input(policy(() => assert.fail('Wrong policy must not run'), 'v2')).build(id, f.session);
  assert(!mismatch.messages.some(message => message.role === 'task_fact'));
});

test('resuming the main switch cannot silently authorize a new task-fact policy', async t => {
  const f = await fixture(t); await f.delivery.pause(); await f.delivery.enable('v2');
  assert.equal((await f.store.read()).authorization.collectionConsent.policyVersion, 'v1');
  const before = await f.task();
  const blocked = await f.input(policy(() => assert.fail('New policy lacks a separate grant'), 'v2')).build(before.id, f.session);
  assert(!blocked.messages.some(message => message.role === 'task_fact'));
  await f.delivery.authorizeCollection({ policyVersion: 'v2', scope: null, boundaries: [] });
  const after = await f.task();
  const allowed = await f.input(policy(safe, 'v2')).build(after.id, f.session);
  assert(allowed.messages.some(message => message.role === 'task_fact'));
});

for (const secret of ['password=SYNTHETIC_SECRET', '实际密码是SYNTHETIC_SECRET', 'HOST_SECRET_SNAPSHOT']) {
  test('projected credentials are excluded by the same local scanner and host snapshot', async t => {
    const f = await fixture(t); const { id, sourceId } = await f.task();
    const input = await f.input(policy(() => secret), { sensitiveValues: () => ['HOST_SECRET_SNAPSHOT'] }).build(id, f.session);
    assert.equal(input.status, 'ready'); assert(input.excludedEntries.includes(sourceId));
    assert(!JSON.stringify(input).includes(secret));
  });
}

test('invalid/throwing projectors produce a fixed failure without leaking their diagnostics', async t => {
  const f = await fixture(t); const { id } = await f.task();
  for (const project of [() => ({ text: 'bad-shape' }), () => { throw new Error('PRIVATE_PROJECTOR_DIAGNOSTIC'); }]) {
    assert.deepEqual(await f.input(policy(project)).build(id, f.session), { status: 'blocked', code: 'MEMORY_COLLECTION_SCAN_FAILED' });
  }
});

test('allowlist is copied at construction and cannot grow through later caller mutation', async t => {
  const f = await fixture(t); const { id } = await f.task();
  const original = { policyVersion: 'v1', tools: new Map() }; const builder = f.input(original);
  original.tools.set('create_work_item', () => assert.fail('Late inserted policy must not run'));
  const input = await builder.build(id, f.session); assert(!input.messages.some(message => message.role === 'task_fact'));
});

test('pause while projecting rejects the late candidate, and projection output obeys the input budget', async t => {
  const f = await fixture(t); const { id } = await f.task();
  let entered, release; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const pending = f.input(policy(async () => { entered(); await gate; return 'Work item TASK-42 was created.'; })).build(id, f.session);
  await started; await f.delivery.pause(); release();
  assert.equal((await pending).code, 'MEMORY_COLLECTION_NOT_AUTHORIZED');
  await f.delivery.enable('v1'); const current = await f.task();
  assert.equal((await f.input(policy(() => 'x'.repeat(1000)), { maxInputBytes: 128 }).build(current.id, f.session)).code, 'MEMORY_COLLECTION_INPUT_LIMIT');
});

test('approved task facts remain selectable without exposing a credential-containing user message', async t => {
  const f = await fixture(t); const { id } = await f.task({ user: 'password=PRIVATE_USER_CREDENTIAL' });
  let calls = 0;
  const selected = await f.selector(policy(safe), async ({ data }) => {
    calls++; assert(!data.includes('PRIVATE_USER_CREDENTIAL'));
    const messages = JSON.parse(data).messages; assert(!messages.some(message => message.role === 'user'));
    const fact = messages.find(message => message.role === 'task_fact');
    return JSON.stringify({ facts: [{ sourceId: fact.sourceId, quote: fact.text }] });
  }).select([id], f.session);
  assert.equal(selected.status, 'ready'); assert.equal(calls, 1); assert.equal(selected.facts.length, 1);
});

test('task facts cannot acquire a model-supplied confirmation structure or forged policy version', async t => {
  const f = await fixture(t); const { id } = await f.task();
  const malformed = await f.selector(policy(safe), async ({ data }) => {
    const messages = JSON.parse(data).messages; const fact = messages.find(message => message.role === 'task_fact');
    return JSON.stringify({ facts: [{ sourceId: fact.sourceId, quote: fact.text, confirmation: { sourceId: 'm0', quote: messages[0].text } }] });
  }).select([id], f.session);
  assert.equal(malformed.code, 'MEMORY_SELECTION_INVALID');
  const selected = await f.selector(policy(safe), async ({ data }) => {
    const fact = JSON.parse(data).messages.find(message => message.role === 'task_fact');
    return JSON.stringify({ facts: [{ sourceId: fact.sourceId, quote: fact.text }] });
  }).select([id], f.session);
  selected.facts[0].projection.policyVersion = 'unapproved';
  assert.equal((await f.delivery.collectSelection(selected)).errorCode, 'MEMORY_COLLECTION_NOT_AUTHORIZED');
  assert.deepEqual((await f.store.read()).operations, {});
});
