import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { FileStateStore, MemoryDelivery, MemorySelectiveService, MemoryExportService, CollectionLifecycle } from '../dist/host.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-selective-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  const old = '- Favorite tea: jasmine';
  const unrelated = '- Meeting day: Tuesday';
  const uri = 'viking://user/alice/memories/preferences/shared.md';
  const extra = 'viking://user/alice/memories/preferences/extra.md';
  const docs = new Map([[uri, `${old}\n${unrelated}`]]);
  const source = entryId => ({ sessionId: 'chat', entryId, branchId: entryId, contentVersion: 'v1' });
  const target = await delivery.save(source('target'), old);
  await store.transact(state => { state.operations[target.id].phase = 'ready'; state.operations[target.id].memoryUris = [uri]; });
  const other = await delivery.save(source('unrelated'), unrelated);
  let settled = true, failAfterReplace = false;
  const removedSources = [];
  const transport = { owner, scope: null,
    async writerSettled() { return settled; },
    async removeSource(operation) { removedSources.push(operation.id); },
    async listMemoryDocuments() { return [...docs.keys()].sort(); },
    async memoryDocumentSize(target) { return Buffer.byteLength(docs.get(target)); },
    async readMemory(target) { if (!docs.has(target)) throw new Error('missing'); return docs.get(target); },
    async readMemoryLimited(target, maxBytes) {
      const content = await this.readMemory(target);
      if (Buffer.byteLength(content) > maxBytes) throw new Error('MEMORY_EXPORT_TOO_LARGE');
      return content;
    },
    async replaceMemory(target, content) { docs.set(target, content); if (failAfterReplace) { failAfterReplace = false; throw new Error('lost reply'); } },
    async removeMemory(target) { docs.delete(target); },
  };
  const drainWriter = async operationId => {
    await store.transact(state => {
      const operation = state.operations[operationId];
      if (operation.phase === 'queued') {
        operation.phase = 'ready'; operation.memoryUris = [uri]; delete operation.payload;
      }
    });
  };
  return { owner, directory, store, delivery, docs, old, unrelated, uri, extra, target, other, removedSources,
    transport, selective: new MemorySelectiveService(store, transport, drainWriter), drainWriter,
    setSettled(value) { settled = value; }, setFailAfterReplace() { failAfterReplace = true; } };
}

test('correction drains old writers, preserves unrelated text, blocks old forks and allows fresh explicit saves', async t => {
  const f = await setup(t);
  const job = await f.selective.begin({ kind: 'correct', memoryUri: f.uri,
    selectedText: f.old, replacementText: '- Favorite tea: oolong' });
  f.setSettled(false);
  assert.equal((await f.selective.advance(job.id)).status, 'pending');
  assert.equal((await f.store.read()).governance.jobs[job.id].phase, 'draining');
  // An already accepted pre-barrier writer can create another copy before settling.
  f.docs.set(f.extra, f.old);
  f.setSettled(true);
  assert.equal((await f.selective.advance(job.id)).status, 'complete');
  assert.equal(f.docs.get(f.uri), '- Favorite tea: oolong\n- Meeting day: Tuesday');
  assert.equal(f.docs.get(f.extra), '- Favorite tea: oolong');
  assert.deepEqual(f.removedSources, [f.target.id]);
  const state = await f.store.read();
  assert.equal(state.governance.jobs[job.id].selectivePlan, undefined);
  assert.equal(state.operations[f.target.id].payload, undefined);
  assert.deepEqual(state.operations[f.target.id].memoryUris, [f.uri]);
  const exported = await new MemoryExportService(f.store, f.transport).page({ limit: 10 });
  const shared = exported.items.find(item => item.uri === f.uri);
  assert.equal(shared.sources[0].status, 'revoked');
  assert(shared.sources.some(source => source.status === 'current' && source.entryId === 'unrelated'));
  assert.equal(shared.revisions[0].kind, 'correct');
  assert.equal(state.operations[f.other.id].phase, 'ready');
  assert.equal(state.operations[f.other.id].payload, undefined);
  assert.equal((await f.delivery.save({ ...f.target.source, sessionId: 'fork' }, f.old)).errorCode, 'MEMORY_SOURCE_REVOKED');
  assert.equal((await f.delivery.save({ ...f.target.source, entryId: 'fresh', branchId: 'fresh' }, f.old)).phase, 'queued');
});

test('forget while paused preserves shared document and reconciles a lost replacement reply', async t => {
  const f = await setup(t);
  await f.delivery.pause();
  const job = await f.selective.begin({ kind: 'forget', memoryUri: f.uri, selectedText: f.old });
  f.setFailAfterReplace();
  assert.equal((await f.selective.advance(job.id)).status, 'pending');
  assert.equal((await f.store.read()).governance.jobs[job.id].phase, 'applying');
  const recovered = new MemorySelectiveService(new FileStateStore({ owner: f.owner,
    directory: f.directory, policyVersion: 'v1' }), f.transport);
  assert.equal((await recovered.advance(job.id)).status, 'complete');
  assert.equal(f.docs.get(f.uri), `\n${f.unrelated}`);
  assert(!JSON.stringify([...f.docs.values()]).includes(f.old));
});

test('ambiguous or foreign targets reject before registration or mutation', async t => {
  const f = await setup(t);
  f.docs.set(f.extra, f.old);
  await assert.rejects(f.selective.begin({ kind: 'forget', memoryUri: f.uri, selectedText: f.old }), /MEMORY_TARGET_AMBIGUOUS/);
  await assert.rejects(f.selective.begin({ kind: 'correct', memoryUri: 'viking://user/bob/memories/private.md',
    selectedText: f.old, replacementText: 'new' }), /MEMORY_SCOPE_MISMATCH/);
  assert.equal((await f.store.read()).governance, undefined);
  assert.throws(() => new MemorySelectiveService(f.store, { ...f.transport,
    owner: { accountId: 'account', userId: 'bob' } }), /OWNER_MISMATCH/);
});

test('only the registered coordinator can drain an unrelated queued writer under the barrier', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-drain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const uri = 'viking://user/alice/memories/fact.md';
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, maxPayloadBytes: 8192, transport: { owner,
    async createSession() {}, async sessionExists() { return true; },
    async append() {}, async hasSource() { return true; },
    async commit() { return { taskId: 'task' }; }, async findCommit() { return { taskId: 'task' }; },
    async inspect() { return { status: 'ready', archiveId: 'archive', memoryUris: [uri] }; },
  } });
  await delivery.enable('v1');
  const source = entryId => ({ sessionId: 'chat', entryId, branchId: entryId, contentVersion: 'v1' });
  const target = await delivery.save(source('target'), '- old');
  await store.transact(state => { state.operations[target.id].phase = 'ready'; state.operations[target.id].memoryUris = [uri]; });
  const other = await delivery.save(source('other'), '- unrelated');
  const selective = new MemorySelectiveService(store, { owner, scope: null,
    async listMemoryDocuments() { return [uri]; }, async readMemory() { return '- old'; },
    async writerSettled() { return true; }, async removeSource() {},
    async replaceMemory() {}, async removeMemory() {},
  });
  const job = await selective.begin({ kind: 'forget', memoryUri: uri, selectedText: '- old' });
  assert.equal((await store.read()).operations[other.id].payload, '- unrelated');
  await delivery.advance(other.id);
  assert.equal((await store.read()).operations[other.id].phase, 'queued');
  await delivery.advanceGovernance(other.id, '00000000-0000-0000-0000-000000000000');
  assert.equal((await store.read()).operations[other.id].phase, 'queued');
  for (let step = 0; step < 5; step++) await delivery.advanceGovernance(other.id, job.id);
  assert.equal((await store.read()).operations[other.id].phase, 'ready');
});

test('selective governance drains an unrelated pre-barrier collection and filters the old fact', async t => {
  const f = await setup(t);
  await f.delivery.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] });
  const lifecycle = new CollectionLifecycle(f.store);
  const session = SessionManager.inMemory('/private/tmp');
  const requestId = await lifecycle.begin(session);
  const text = `${f.old}\n${f.unrelated}`;
  const entryId = session.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
  session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Understood.' }], stopReason: 'stop', timestamp: Date.now() });
  await lifecycle.settle(requestId, session);
  const entry = session.getEntry(entryId);
  const source = { sessionId: session.getSessionId(), entryId, entryTimestamp: entry.timestamp,
    branchId: session.getLeafId(), contentVersion: createHash('sha256').update(JSON.stringify(entry.message)).digest('hex') };
  const fact = value => ({ text: value, source, evidence: [{ source, quote: value }] });
  const job = await f.selective.begin({ kind: 'forget', memoryUri: f.uri, selectedText: f.old });
  assert.deepEqual(job.collectionRequestIds, [requestId]);
  assert.equal((await f.selective.advance(job.id)).status, 'pending');
  const receipt = await f.delivery.collectSelection({ status: 'ready', requestIds: [requestId],
    facts: [fact(f.old), fact(f.unrelated)] });
  assert.equal(receipt.status, 'recorded');
  assert.equal(receipt.operationIds.length, 1);
  const before = await f.store.read();
  assert(before.operations[receipt.operationIds[0]].payload.includes(f.unrelated));
  assert(!before.operations[receipt.operationIds[0]].payload.includes(f.old));
  assert(before.governance.jobs[job.id].writerOperationIds.includes(receipt.operationIds[0]));
  assert.equal((await f.selective.advance(job.id)).status, 'complete');
  assert.equal((await f.store.read()).operations[receipt.operationIds[0]].phase, 'ready');
  assert.equal(f.docs.get(f.uri), `\n${f.unrelated}`);
});
