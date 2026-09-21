import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CollectionSessionRegistry, CollectionLifecycle, FileStateStore, MemoryDelivery, createOpenVikingExtension } from '../dist/host.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'alice'); await mkdir(sessions, { mode: 0o700 });
  const options = { owner: { accountId: 'test', userId: 'alice' }, directory: join(root, 'state'), policyVersion: 'v1' };
  const store = new FileStateStore(options);
  const registry = () => new CollectionSessionRegistry({ store: new FileStateStore(options), sessionRoot: sessions });
  const session = SessionManager.create(root, sessions);
  const transport = { owner: store.owner, async recall() { return []; } };
  const delivery = new MemoryDelivery({ store, transport, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  await delivery.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] });
  return { root, sessions, store, registry, session, transport, delivery };
}
function messages(session, text = 'I prefer short reports.') {
  const user = session.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
  const assistant = session.appendMessage({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Understood.' }], timestamp: Date.now() });
  return [user, assistant];
}

test('persisted source references reopen original pi entries without copying conversation text', async t => {
  const f = await fixture(t); await f.registry().register(f.session);
  assert.deepEqual(await f.registry().boundaries(), [{ sessionId: f.session.getSessionId(), entryId: null, branchId: null }]);
  const ids = messages(f.session, 'SYNTHETIC_ORIGINAL_CONVERSATION');
  const reopened = await f.registry().resolveSession(f.session.getSessionId());
  assert.deepEqual(reopened.getBranch().map(entry => entry.id), ids);
  assert.equal(reopened.getEntry(ids[0]).message.content, 'SYNTHETIC_ORIGINAL_CONVERSATION');
  assert(!(await readFile(join(f.root, 'state/state.json'), 'utf8')).includes('SYNTHETIC_ORIGINAL_CONVERSATION'));
  assert.equal((await f.registry().boundaries())[0].entryId, ids.at(-1));
});

test('foreign owner roots and final or directory symlinks cannot become collection sources', async t => {
  const f = await fixture(t); const other = join(f.root, 'bob'); await mkdir(other, { mode: 0o700 });
  const foreign = SessionManager.create(f.root, other); messages(foreign);
  await assert.rejects(f.registry().register(foreign), /FOREIGN_COLLECTION_SESSION/);
  const link = join(f.sessions, 'borrowed.jsonl'); await symlink(foreign.getSessionFile(), link);
  const alias = { getSessionId: () => foreign.getSessionId(), getSessionFile: () => link };
  await assert.rejects(f.registry().register(alias), /INVALID_COLLECTION_SESSION_FILE/);
  const directory = join(f.sessions, 'borrowed-dir'); await symlink(other, directory);
  await assert.rejects(f.registry().register({ ...alias, getSessionFile: () => join(directory, foreign.getSessionFile().split('/').at(-1)) }), /FOREIGN_COLLECTION_SESSION/);
  assert.equal((await f.store.read()).collectionSessionFiles, undefined);
});

test('replacing a source with another pi session or corrupt content fails without repairing it', async t => {
  const f = await fixture(t); messages(f.session); await f.registry().register(f.session);
  const second = SessionManager.create(f.root, f.sessions); messages(second);
  await copyFile(second.getSessionFile(), f.session.getSessionFile());
  await assert.rejects(f.registry().resolveSession(f.session.getSessionId()), /MEMORY_SOURCE_UNAVAILABLE/);
  await writeFile(f.session.getSessionFile(), 'CORRUPT_SOURCE');
  await assert.rejects(f.registry().resolveSession(f.session.getSessionId()), /MEMORY_SOURCE_UNAVAILABLE/);
  assert.equal(await readFile(f.session.getSessionFile(), 'utf8'), 'CORRUPT_SOURCE');
});

test('a missing source with completed request metadata cannot masquerade as an empty boundary', async t => {
  const f = await fixture(t); await f.registry().register(f.session);
  const lifecycle = new CollectionLifecycle(f.store); const id = await lifecycle.begin(f.session);
  messages(f.session); await lifecycle.settle(id, f.session);
  await rm(f.session.getSessionFile());
  await assert.rejects(f.registry().boundaries(), /ENOENT/);
});

test('grant boundaries cover all registered sessions and reflect later persisted leaves', async t => {
  const f = await fixture(t); const second = SessionManager.create(f.root, f.sessions);
  await f.registry().register(f.session); await f.registry().register(second);
  const firstLeaf = messages(f.session).at(-1); const secondLeaf = messages(second, 'I use metric units.').at(-1);
  const boundaries = await f.registry().boundaries();
  assert.deepEqual(new Set(boundaries.map(boundary => boundary.entryId)), new Set([firstLeaf, secondLeaf]));
  await f.delivery.authorizeCollection({ policyVersion: 'v2', scope: null, boundaries });
  assert.deepEqual((await f.store.read()).authorization.collectionConsent.boundaries, boundaries);
});

function host(f, collection) {
  const handlers = new Map();
  createOpenVikingExtension({ owner: f.store.owner, client: f.transport, stateStore: f.store,
    async assertToolIsolation() {}, policy: { maxPayloadBytes: 8192, recallTimeoutMs: 100, recallTokenBudget: 1000,
      recallLimit: 5, minimumScore: 0, countTokens: text => text.length }, collection, wakeDelivery() {} })({
    on: (name, callback) => handlers.set(name, callback), registerTool() {} });
  return handlers;
}

test('extension hooks persist source binding then wake only after completed durable settlement', async t => {
  const f = await fixture(t); let wakes = 0;
  const handlers = host(f, { sessions: f.registry(), lifecycleTimeoutMs: 1000, wake() { wakes++; } });
  const context = { sessionManager: f.session };
  await handlers.get('before_agent_start')({ prompt: 'query' }, context); messages(f.session);
  handlers.get('ui_prompt_start')(); await handlers.get('agent_settled')({}, context);
  assert.equal(wakes, 0);
  handlers.get('ui_prompt_end')(); await handlers.get('agent_settled')({}, context);
  assert.equal(wakes, 1);
  assert.equal(Object.values((await f.store.read()).collectionRequests)[0].phase, 'settled');
  assert.equal((await f.registry().resolveSession(f.session.getSessionId())).getSessionId(), f.session.getSessionId());
});

test('a timed out foreground source registration cannot later start a request', async t => {
  const f = await fixture(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const errors = [];
  const handlers = host(f, { sessions: { async register() { await gate; }, async boundaries() { return []; } }, lifecycleTimeoutMs: 25, wake() {}, onError(code) { errors.push(code); } });
  await Promise.race([handlers.get('before_agent_start')({ prompt: 'query' }, { sessionManager: f.session }), delay(1000).then(() => assert.fail('foreground hook hung'))]);
  release(); await delay(30);
  assert.equal(Object.keys((await f.store.read()).collectionRequests ?? {}).length, 0);
  assert.deepEqual(errors, ['MEMORY_COLLECTION_LIFECYCLE_UNAVAILABLE']);
});

test('empty and old-version sources remain byte-for-byte unchanged on recovery failure', async t => {
  const f = await fixture(t); messages(f.session); await f.registry().register(f.session);
  const original = await readFile(f.session.getSessionFile(), 'utf8');
  for (const text of ['', original.replace('"version":3', '"version":1')]) {
    await writeFile(f.session.getSessionFile(), text);
    await assert.rejects(f.registry().resolveSession(f.session.getSessionId()), /MEMORY_SOURCE_UNAVAILABLE/);
    assert.equal(await readFile(f.session.getSessionFile(), 'utf8'), text);
  }
});

test('live branch movement is reflected in consent boundaries without retaining the session strongly', async t => {
  const f = await fixture(t); const registry = f.registry();
  const [first] = messages(f.session); messages(f.session, 'Another request.');
  await registry.register(f.session); f.session.branch(first);
  assert.equal((await registry.boundaries())[0].entryId, first);
});
