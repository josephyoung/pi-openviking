import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenVikingExtension, FileStateStore, MemoryDelivery, MemoryGovernanceBarrier } from '../dist/host.js';

async function setup(t, policy = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const stateStore = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const result = { requests: 0, isolated: true };
  const client = { owner, async recall() { result.requests++; return [{ uri: 'viking://user/alice/memories/fact.md', text: 'Use Chinese.', score: 0.9 }]; } };
  const handlers = new Map(), tools = new Map();
  const context = { model: { id: 'fixture-model', provider: 'fixture', api: 'openai-completions' } };
  const pi = { on: (name, handler) => handlers.set(name, name === 'context'
    ? event => handler(event, context) : handler), registerTool: tool => tools.set(tool.name, tool) };
  const options = { owner, client, stateStore, assertToolIsolation: async () => { if (!result.isolated) throw new Error('no worker'); },
    policy: { maxPayloadBytes: 8192, recallTimeoutMs: 50, recallTokenBudget: 1000, recallLimit: 5, minimumScore: 0.5,
      countTokens: text => text.length, ...policy }, wakeDelivery() {} };
  const factory = createOpenVikingExtension(options);
  factory(pi);
  const service = new MemoryDelivery({ store: stateStore, transport: client, maxPayloadBytes: 8192 });
  return { options, factory, pi, handlers, tools, stateStore, service, result, client, context };
}
const messages = [{ role: 'user', content: 'Design a feature.', timestamp: Date.now() }];

test('factory rejects owner mismatch and duplicate registration; no fallback credentials', async t => {
  const f = await setup(t);
  assert.throws(() => f.factory(f.pi), /DUPLICATE_MEMORY_EXTENSION/);
  assert.throws(() => createOpenVikingExtension({ ...f.options, owner: { accountId: 'test', userId: 'bob' } }), /MEMORY_OWNER_MISMATCH/);
});

test('disabled context never sends a query and removes previous reference blocks', async t => {
  const f = await setup(t);
  f.handlers.get('before_agent_start')({ prompt: 'query' });
  const input = [...messages, { role: 'custom', customType: 'openviking-reference-data', content: 'old', timestamp: 0 }];
  assert.deepEqual((await f.handlers.get('context')({ messages: input })).messages, messages);
  assert.equal(f.result.requests, 0);
});

test('recall stays a non-persisted quoted custom message, is cached per request and bounded by actual counting', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  f.handlers.get('before_agent_start')({ prompt: 'query' });
  const first = await f.handlers.get('context')({ messages });
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[1].role, 'custom');
  assert.equal(first.messages[1].display, false);
  assert.equal(JSON.parse(first.messages[1].content).type, 'quoted_memory_data');
  assert.equal(messages.length, 1);
  await f.handlers.get('context')({ messages: first.messages });
  assert.equal(f.result.requests, 1);
  f.handlers.get('before_agent_start')({ prompt: 'different query' });
  await f.handlers.get('context')({ messages });
  assert.equal(f.result.requests, 2);
  const narrow = await setup(t, { recallTokenBudget: 1 });
  await narrow.service.enable('v1');
  narrow.handlers.get('before_agent_start')({ prompt: 'query' });
  assert.equal((await narrow.handlers.get('context')({ messages })).messages.length, 1);
});

test('retrieval has a hard wait limit and a failed worker prevents memory access', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  f.handlers.get('before_agent_start')({ prompt: 'query' });
  f.client.recall = async () => new Promise(() => {});
  const start = Date.now();
  assert.equal((await f.handlers.get('context')({ messages })).messages.length, 1);
  assert(Date.now() - start < 500);
  f.result.isolated = false;
  f.handlers.get('before_agent_start')({ prompt: 'query' });
  assert.equal((await f.handlers.get('context')({ messages })).messages.length, 1);
});

test('pause during retrieval invalidates the response and later cached context', async t => {
  const f = await setup(t, { recallTimeoutMs: 1000 });
  await f.service.enable('v1');
  f.handlers.get('before_agent_start')({ prompt: 'query' });
  f.client.recall = async () => { await f.service.pause(); return [{ uri: 'private', text: 'old fact', score: 0.9 }]; };
  assert.deepEqual((await f.handlers.get('context')({ messages })).messages, messages);
});

test('a disabled save intent cannot automatically execute after enabling; a new user confirmation can', async t => {
  const f = await setup(t);
  let timestamp = '2000-01-01T00:00:00.000Z';
  const ctx = { sessionManager: { getSessionId: () => 'chat', getBranch: () => [{ id: 'entry', type: 'message', timestamp,
    message: { role: 'user', content: 'remember this fact' } }] } };
  const save = () => f.tools.get('memory_save').execute('call-id', { content: 'fact' }, undefined, undefined, ctx);
  assert.equal((await save()).details.errorCode, 'MEMORY_DISABLED');
  await f.service.enable('v1');
  assert.equal((await save()).details.errorCode, 'MEMORY_CONFIRM_AGAIN');
  timestamp = new Date(Date.now() + 1).toISOString();
  assert.equal((await save()).details.status, 'queued');
  assert.equal(Object.keys((await f.stateStore.read()).operations).length, 1);
});

test('model switches recount the same request and cannot reuse another tokenizer budget', async t => {
  const counted = [];
  const f = await setup(t, { countTokens: async (text, { model, signal }) => {
    assert.equal(signal.aborted, false);
    counted.push(model);
    return model.id === 'fixture-model' ? 1 : 1001;
  } });
  await f.service.enable('v1');
  f.handlers.get('before_agent_start')({ prompt: 'query' });
  const first = await f.handlers.get('context')({ messages });
  assert.equal(first.messages.length, 2);
  f.context.model = { ...f.context.model, id: 'another-model' };
  const next = await f.handlers.get('context')({ messages: first.messages });
  assert.deepEqual(next.messages, messages);
  assert.deepEqual(counted.map(model => model.id), ['fixture-model', 'another-model']);
  assert.equal(f.result.requests, 2);
});

test('save receipts distinguish a queued acknowledgement from completed memory, including retries', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const timestamp = new Date(Date.now() + 1).toISOString();
  const ctx = { sessionManager: { getSessionId: () => 'chat', getBranch: () => [{ id: 'entry', type: 'message', timestamp,
    message: { role: 'user', content: 'remember this fact' } }] } };
  const save = () => f.tools.get('memory_save').execute('call-id', { content: 'fact' }, undefined, undefined, ctx);
  const queued = await save();
  const id = queued.details.operationId;
  assert.equal(queued.details.status, 'queued');
  assert.equal(queued.details.remembered, false);
  assert.match(queued.details.message, /仅已提交/);
  for (const phase of ['session_unknown', 'session_created', 'message_unknown', 'message_delivered', 'commit_unknown', 'processing', 'failed', 'blocked', 'blocked_by_pause', 'ready']) {
    await f.stateStore.transact(state => { state.operations[id].phase = phase; });
    const result = await save();
    const visible = JSON.parse(result.content[0].text);
    assert.deepEqual(visible, JSON.parse(JSON.stringify(result.details)));
    assert.equal(visible.status, phase);
    assert.equal(visible.remembered, phase === 'ready');
    assert.match(visible.message, phase === 'ready' ? /已完成处理/ : /不得声称/);
    assert.equal(visible.operationId, id);
    for (const privateKey of ['payload', 'owner', 'source', 'remoteSessionId', 'taskId']) {
      assert.equal(privateKey in visible, false);
    }
  }
  assert.equal(Object.keys((await f.stateStore.read()).operations).length, 1);
});

test('a model change during token counting discards the old result', async t => {
  const f = await setup(t, { countTokens: async () => {
    f.context.model = { ...f.context.model, id: 'changed-during-count' };
    return 1;
  } });
  await f.service.enable('v1');
  f.handlers.get('before_agent_start')({ prompt: 'query' });
  assert.deepEqual((await f.handlers.get('context')({ messages })).messages, messages);
});

test('missing models, tokenizer errors and slow counters degrade without injecting memories', async t => {
  const missing = await setup(t);
  await missing.service.enable('v1');
  missing.handlers.get('before_agent_start')({ prompt: 'query' });
  missing.context.model = undefined;
  assert.deepEqual((await missing.handlers.get('context')({ messages })).messages, messages);
  assert.equal(missing.result.requests, 0);
  for (const countTokens of [async () => { throw new Error('unsupported tokenizer'); }, () => new Promise(() => {})]) {
    const f = await setup(t, { countTokens });
    await f.service.enable('v1');
    f.handlers.get('before_agent_start')({ prompt: 'query' });
    const started = Date.now();
    assert.deepEqual((await f.handlers.get('context')({ messages })).messages, messages);
    assert(Date.now() - started < 500);
  }
});

test('explicit save cannot adopt a new authorization after its source check', async t => {
  const f = await setup(t);
  await f.service.enable('v1');
  const timestamp = new Date(Date.now() + 1).toISOString();
  const original = f.stateStore.read.bind(f.stateStore);
  f.stateStore.read = async () => {
    const snapshot = await original();
    await f.service.pause();
    await f.service.enable('v1');
    return snapshot;
  };
  const result = await f.tools.get('memory_save').execute('call', { content: 'fact' }, undefined, undefined,
    { sessionManager: { getSessionId: () => 'chat', getBranch: () => [{ id: 'entry', type: 'message', timestamp,
      message: { role: 'user', content: 'remember this fact' } }] } });
  assert.equal(result.details.errorCode, 'MEMORY_CONFIRM_AGAIN');
  assert.deepEqual((await original()).operations, {});
});


test('a durable governance barrier invalidates cached recall and does not send another search', async t => {
  const f = await setup(t, { recallTimeoutMs: 1000 });
  await f.service.enable('v1');
  f.handlers.get('before_agent_start')({ prompt: 'query' });
  const first = await f.handlers.get('context')({ messages });
  assert.equal(first.messages.length, 2);
  await new MemoryGovernanceBarrier(f.stateStore).begin({ kind: 'clear', scope: null });
  assert.deepEqual((await f.handlers.get('context')({ messages: first.messages })).messages, messages);
  assert.equal(f.result.requests, 1);
});

test('governance begun during a remote recall invalidates the late result', async t => {
  const f = await setup(t, { recallTimeoutMs: 1000 });
  await f.service.enable('v1');
  f.handlers.get('before_agent_start')({ prompt: 'query' });
  f.client.recall = async () => {
    await new MemoryGovernanceBarrier(f.stateStore).begin({ kind: 'clear', scope: null });
    return [{ uri: 'viking://user/alice/memories/fact.md', text: 'revoked memory', score: 0.9 }];
  };
  assert.deepEqual((await f.handlers.get('context')({ messages })).messages, messages);
});
