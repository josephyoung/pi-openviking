import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import standard, { bindStandardHost } from '../dist/standard.js';
import { FileStateStore, MemoryDelivery } from '../dist/host.js';

test('standard entry binds tools and explicit management consent to the same worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-standard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const store = new FileStateStore({ owner, directory: root, policyVersion: 'v1' });
  const client = { owner, async recall() { return []; } };
  let isolated = true, confirmed = false, hasUI = true;
  const worker = { workspace: root, async assertIsolated() { if (!isolated) throw new Error('Unavailable'); }, async execute() { throw new Error('Unexpected execution'); } };
  const options = { owner, stateStore: store, client, async assertToolIsolation() { throw new Error('Must use the bound worker'); },
    policy: { maxPayloadBytes: 4096, recallTimeoutMs: 100, recallTokenBudget: 500, recallLimit: 3, minimumScore: 0.5, countTokens: s => s.length }, wakeDelivery() {} };
  bindStandardHost(options, worker);
  const tools = [], commands = new Map(), notifications = [];
  await standard({ registerTool: tool => tools.push(tool.name), on() {}, registerCommand: (name, command) => commands.set(name, command) });
  assert.equal(tools.length, 8);
  const context = { get hasUI() { return hasUI; }, ui: { async confirm() { return confirmed; }, notify: message => notifications.push(message) } };
  const run = action => commands.get('memory').handler(action, context);
  await run('enable');
  assert.equal((await store.read()).authorization.enabled, false);
  confirmed = true; hasUI = false;
  await run('enable');
  assert.equal((await store.read()).authorization.enabled, false);
  hasUI = true; isolated = false;
  await run('enable');
  assert.equal((await store.read()).authorization.enabled, false);
  isolated = true;
  await run('enable');
  assert.equal((await store.read()).authorization.enabled, true);
  assert.equal((await store.read()).authorization.automaticCollection, false);
  const delivery = new MemoryDelivery({ store, transport: client, maxPayloadBytes: 4096 });
  const operation = await delivery.save({ sessionId: 'chat', entryId: 'entry', branchId: 'root', contentVersion: '1' }, 'SYNTHETIC_PENDING_BODY');
  await run('status');
  assert(!notifications.at(-1).includes('SYNTHETIC_PENDING_BODY'));
  assert(notifications.at(-1).includes(operation.id));
  await run('pause');
  const state = await store.read();
  assert.equal(state.authorization.enabled, false);
  assert.equal(state.operations[operation.id].phase, 'blocked_by_pause');
});

test('automatic consent is separate, requires configured collection and records fresh boundaries on resume', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-standard-auto-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { default: autoEntry, bindStandardHost: bind } = await import('../dist/standard.js?automatic-consent');
  const owner = { accountId: 'test', userId: 'alice' };
  const store = new FileStateStore({ owner, directory: root, policyVersion: 'v1' });
  const worker = { workspace: root, async assertIsolated() {}, async execute() {} };
  let leaf = 'first', confirmed = true, wakes = 0; const confirmations = [];
  const registry = { async register() {}, async boundaries() { return [{ sessionId: 'current', entryId: leaf, branchId: leaf }]; } };
  const client = { owner, async recall() { return []; } };
  bind({ owner, client, stateStore: store, async assertToolIsolation() {},
    policy: { maxPayloadBytes: 8192, recallTimeoutMs: 100, recallTokenBudget: 500, recallLimit: 3, minimumScore: 0, countTokens: t => t.length },
    collection: { sessions: registry, lifecycleTimeoutMs: 100, wake() { wakes++; } }, wakeDelivery() {} }, worker);
  const commands = new Map(), notifications = [];
  await autoEntry({ registerTool() {}, on() {}, registerCommand: (name, command) => commands.set(name, command) });
  const context = { hasUI: true, sessionManager: {}, ui: { async confirm(title) { confirmations.push(title); return confirmed; }, notify: text => notifications.push(text) } };
  const run = action => commands.get('memory').handler(action, context);
  await run('auto-enable'); assert.equal((await store.read()).authorization.automaticCollection, false);
  await run('enable'); assert.equal((await store.read()).authorization.automaticCollection, false);
  confirmed = false; await run('auto-enable'); assert.equal((await store.read()).authorization.automaticCollection, false);
  confirmed = true; await run('auto-enable');
  const original = (await store.read()).authorization.collectionConsent;
  assert.equal(original.boundaries[0].entryId, 'first'); assert.equal(wakes, 1);
  assert(confirmations.includes('单独授权自动采集')); assert(confirmations.includes('启用长期记忆'));
  await run('pause'); leaf = 'after-paused-history'; await run('enable');
  const resumed = (await store.read()).authorization;
  assert.equal(resumed.automaticCollection, true);
  assert(resumed.collectionConsent.revision > original.revision);
  assert.equal(resumed.collectionConsent.boundaries[0].entryId, leaf);
  assert(notifications.at(-1).includes('仅采集恢复后的新请求'));
  await run('auto-disable');
  assert.equal((await store.read()).authorization.automaticCollection, false);
  assert.equal((await store.read()).authorization.enabled, true);
});

test('new collection rules stay unapproved on resume and can be separately approved from the standard command', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-standard-policy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { default: entry, bindStandardHost: bind } = await import('../dist/standard.js?policy-update');
  const owner = { accountId: 'test', userId: 'alice' }, store = new FileStateStore({ owner, directory: root, policyVersion: 'v1' });
  const client = { owner, async recall() { return []; } };
  const delivery = new MemoryDelivery({ store, transport: client, maxPayloadBytes: 8192 });
  await delivery.enable('v1'); await delivery.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] }); await delivery.pause();
  bind({ owner, client, stateStore: store, async assertToolIsolation() {}, wakeDelivery() {},
    policy: { maxPayloadBytes: 8192, recallTimeoutMs: 100, recallTokenBudget: 100, recallLimit: 1, minimumScore: 0, countTokens: t => t.length },
    collection: { policyVersion: 'v2', lifecycleTimeoutMs: 1000,
      sessions: { async register() {}, async boundaries() { return []; } }, wake() {} } },
    { workspace: root, async assertIsolated() {}, async execute() {} });
  const commands = new Map(), notifications = [], prompts = [];
  await entry({ on() {}, registerTool() {}, registerCommand: (name, command) => commands.set(name, command) });
  const ctx = { hasUI: true, sessionManager: {}, ui: { async confirm(title) { prompts.push(title); return true; }, notify: text => notifications.push(text) } };
  const run = action => commands.get('memory').handler(action, ctx);
  await run('enable'); assert.equal((await store.read()).authorization.collectionConsent.policyVersion, 'v1');
  assert(notifications.at(-1).includes('新增规则需单独重新授权'));
  await run('status'); assert(notifications.at(-1).includes('新增规则需通过 /memory auto-enable'));
  await run('auto-enable'); assert.equal((await store.read()).authorization.collectionConsent.policyVersion, 'v2');
  assert.deepEqual(prompts, ['启用长期记忆', '单独授权自动采集']);
});
