import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenVikingExtension, FileStateStore, MemoryDelivery } from '../dist/host.js';

async function setup(t, policy = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const stateStore = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const result = { requests: 0, isolated: true };
  const client = { owner, async recall() { result.requests++; return [{ uri: 'viking://user/alice/memories/fact.md', text: 'Use Chinese.', score: 0.9 }]; } };
  const handlers = new Map(), tools = new Map();
  const pi = { on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool) };
  const options = { owner, client, stateStore, assertToolIsolation: async () => { if (!result.isolated) throw new Error('no worker'); },
    policy: { maxPayloadBytes: 8192, recallTimeoutMs: 50, recallTokenBudget: 1000, recallLimit: 5, minimumScore: 0.5,
      countTokens: text => text.length, ...policy }, wakeDelivery() {} };
  const factory = createOpenVikingExtension(options);
  factory(pi);
  const service = new MemoryDelivery({ store: stateStore, transport: client, maxPayloadBytes: 8192 });
  return { options, factory, pi, handlers, tools, stateStore, service, result, client };
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
