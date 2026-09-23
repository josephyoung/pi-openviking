import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { FileStateStore, MemoryDelivery, MemorySelectiveService, MemoryGovernanceService, MemoryExportService,
  MemoryGovernanceBarrier, CollectionLifecycle } from '../dist/host.js';

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
    transport, selective: new MemorySelectiveService(store, transport, drainWriter,
      async ({ candidateText }) => candidateText.includes('Meeting day') ? 'unrelated' : 'uncertain'), drainWriter,
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
  const moved = (await f.store.read()).governance.jobs[job.id].memoryUris[0];
  assert.equal(f.docs.has(f.uri), false);
  assert.equal(f.docs.get(moved), `\n${f.unrelated}`);
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

test('an unclassified queued writer keeps governance pending until its source is resolved', async t => {
  const f = await setup(t);
  const selective = new MemorySelectiveService(f.store, f.transport, f.drainWriter);
  const job = await selective.begin({ kind: 'forget', memoryUri: f.uri, selectedText: f.old });
  assert.deepEqual(await selective.advance(job.id), {
    status: 'pending', errorCode: 'MEMORY_GOVERNANCE_REVIEW_REQUIRED',
  });
  assert.equal((await f.store.read()).operations[f.other.id].phase, 'queued');
  await new MemoryGovernanceBarrier(f.store).classifyWriter(job.id, f.other.id, 'unrelated');
  assert.equal((await selective.advance(job.id)).status, 'complete');
  assert.equal((await f.store.read()).operations[f.other.id].phase, 'ready');
});

test('a queued semantic paraphrase is revoked before remote delivery', async t => {
  const f = await setup(t);
  const paraphrase = await f.delivery.save({ sessionId: 'chat', entryId: 'paraphrase',
    branchId: 'paraphrase', contentVersion: 'v1' }, 'I enjoy jasmine tea');
  const selective = new MemorySelectiveService(f.store, f.transport, f.drainWriter,
    async ({ candidateText }) => candidateText.includes('jasmine') ? 'target' : 'unrelated');
  const job = await selective.begin({ kind: 'forget', memoryUri: f.uri, selectedText: f.old });
  assert.equal((await selective.advance(job.id)).status, 'complete');
  const state = await f.store.read();
  assert.equal(state.operations[paraphrase.id].phase, 'blocked');
  assert.equal(state.operations[paraphrase.id].payload, undefined);
  assert.equal(state.operations[f.other.id].phase, 'ready');
  assert(!f.docs.get(f.uri).includes('jasmine'));
});

test('an accepted paraphrase in a separate exclusive document is removed before success', async t => {
  const f = await setup(t);
  const source = { sessionId: 'chat', entryId: 'accepted-paraphrase',
    branchId: 'accepted-paraphrase', contentVersion: 'v1' };
  const paraphrase = await f.delivery.save(source, 'I enjoy jasmine tea');
  await f.store.transact(state => { state.operations[paraphrase.id].phase = 'processing'; });
  const drain = async operationId => {
    if (operationId === paraphrase.id) {
      f.docs.set(f.extra, 'User prefers jasmine tea');
      await f.store.transact(state => {
        state.operations[operationId].phase = 'ready'; state.operations[operationId].memoryUris = [f.extra];
      });
    } else await f.drainWriter(operationId);
  };
  const selective = new MemorySelectiveService(f.store, f.transport, drain,
    async ({ candidateText }) => candidateText.includes('jasmine') ? 'target' : 'unrelated');
  const job = await selective.begin({ kind: 'forget', memoryUri: f.uri, selectedText: f.old });
  assert.equal((await selective.advance(job.id)).status, 'complete');
  assert.equal(f.docs.has(f.extra), false);
  assert.equal((await f.store.read()).operations[paraphrase.id].phase, 'blocked');
});

test('failed target extraction without URI lineage requires confirmed scope clear', async t => {
  const f = await setup(t);
  const paraphrase = await f.delivery.save({ sessionId: 'chat', entryId: 'failed-paraphrase',
    branchId: 'failed-paraphrase', contentVersion: 'v1' }, 'I enjoy jasmine tea');
  await f.store.transact(state => { state.operations[paraphrase.id].phase = 'processing'; });
  const drain = async operationId => {
    if (operationId === paraphrase.id) {
      await f.store.transact(state => {
        state.operations[operationId].phase = 'failed';
        state.operations[operationId].errorCode = 'MEMORY_EXTRACTION_FAILED';
      });
    } else await f.drainWriter(operationId);
  };
  const selective = new MemorySelectiveService(f.store, f.transport, drain,
    async ({ candidateText }) => candidateText.includes('jasmine') ? 'target' : 'unrelated');
  const job = await selective.begin({ kind: 'forget', memoryUri: f.uri, selectedText: f.old });
  assert.deepEqual(await selective.advance(job.id), {
    status: 'pending', errorCode: 'MEMORY_GOVERNANCE_CLEAR_REQUIRED',
  });
  assert.equal((await f.store.read()).governance.jobs[job.id].phase, 'draining');
  assert(f.docs.get(f.uri).includes(f.old));
});

test('older failed extraction with erased payload also prevents an unverifiable selective success', async t => {
  const f = await setup(t);
  const older = await f.delivery.save({ sessionId: 'chat', entryId: 'older-failed',
    branchId: 'older-failed', contentVersion: 'v1' }, 'potential old derivative');
  await f.store.transact(state => {
    state.operations[older.id].phase = 'failed';
    state.operations[older.id].errorCode = 'MEMORY_EXTRACTION_FAILED';
    delete state.operations[older.id].payload;
  });
  const job = await f.selective.begin({ kind: 'forget', memoryUri: f.uri, selectedText: f.old });
  assert.deepEqual(await f.selective.advance(job.id), {
    status: 'pending', errorCode: 'MEMORY_GOVERNANCE_CLEAR_REQUIRED',
  });
});

test('an accepted paraphrase merged into the selected document stays pending for review', async t => {
  const f = await setup(t);
  const paraphrase = await f.delivery.save({ sessionId: 'chat', entryId: 'merged-paraphrase',
    branchId: 'merged-paraphrase', contentVersion: 'v1' }, 'I enjoy jasmine tea');
  await f.store.transact(state => { state.operations[paraphrase.id].phase = 'processing'; });
  const drain = async operationId => {
    if (operationId === paraphrase.id) {
      f.docs.set(f.uri, `${f.docs.get(f.uri)}\nUser prefers jasmine tea`);
      await f.store.transact(state => {
        state.operations[operationId].phase = 'ready'; state.operations[operationId].memoryUris = [f.uri];
      });
    } else await f.drainWriter(operationId);
  };
  const selective = new MemorySelectiveService(f.store, f.transport, drain,
    async ({ candidateText }) => candidateText.includes('jasmine') ? 'target' : 'unrelated');
  const job = await selective.begin({ kind: 'forget', memoryUri: f.uri, selectedText: f.old });
  assert.deepEqual(await selective.advance(job.id), {
    status: 'pending', errorCode: 'MEMORY_GOVERNANCE_REVIEW_REQUIRED',
  });
  const state = await f.store.read();
  assert.equal(state.governance.jobs[job.id].phase, 'applying');
  assert.equal(state.operations[paraphrase.id].phase, 'ready');
  assert.equal(state.operations[paraphrase.id].payload, 'I enjoy jasmine tea');
  const management = new MemoryGovernanceService(f.store, f.transport, f.delivery);
  assert.equal((await management.pending()).jobId, job.id);
  const review = await management.review(job.id);
  assert.equal(review.stage, 'merged');
  assert.deepEqual(review.candidates.map(item => item.operationId), [paraphrase.id]);
  assert(review.candidates[0].documentText.includes('User prefers jasmine tea'));
  assert.equal((await management.resolveMergedWriter(job.id, paraphrase.id,
    'User prefers jasmine tea')).status, 'complete');
  assert.equal(await management.pending(), undefined);
  assert.equal(f.docs.get(f.uri), `\n${f.unrelated}\n`);
  const completed = await f.store.read();
  assert.equal(completed.operations[paraphrase.id].payload, undefined);
  assert.equal(completed.governance.jobs[job.id].mergedResolutions, undefined);
});

test('forgetting one of two facts from the same source keeps the other source current', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-fact-split-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  await delivery.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] });
  const session = SessionManager.inMemory('/private/tmp');
  const lifecycle = new CollectionLifecycle(store);
  const requestId = await lifecycle.begin(session);
  const old = 'I like jasmine tea.';
  const unrelated = 'My meetings are Tuesday.';
  const entryId = session.appendMessage({ role: 'user', content: `${old} Jasmine tea is my favorite. ${unrelated}`, timestamp: Date.now() });
  session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Understood.' }], stopReason: 'stop', timestamp: Date.now() });
  await lifecycle.settle(requestId, session);
  const entry = session.getEntry(entryId);
  const source = { sessionId: session.getSessionId(), entryId, entryTimestamp: entry.timestamp,
    branchId: session.getLeafId(), contentVersion: createHash('sha256').update(JSON.stringify(entry.message)).digest('hex') };
  const fact = text => ({ text, source, evidence: [{ source, quote: text }] });
  const receipt = await delivery.collectSelection({ status: 'ready', requestIds: [requestId],
    facts: [fact(old), fact(unrelated)] });
  assert.equal(receipt.status, 'recorded');
  assert.equal(receipt.operationIds.length, 2);
  const teaUri = 'viking://user/alice/memories/preferences/tea.md';
  const meetingUri = 'viking://user/alice/memories/preferences/meetings.md';
  let teaId, meetingId;
  await store.transact(state => {
    for (const id of receipt.operationIds) {
      const operation = state.operations[id];
      const tea = JSON.parse(operation.payload).facts[0] === old;
      operation.phase = 'ready'; operation.memoryUris = [tea ? teaUri : meetingUri]; delete operation.payload;
      if (tea) teaId = id; else meetingId = id;
    }
  });
  const docs = new Map([[teaUri, 'Favorite tea: jasmine'], [meetingUri, 'Meeting day: Tuesday']]);
  const removed = [];
  await store.transact(state => {
    const prior = state.collectionRequests[requestId];
    state.collectionRequests['fork-request'] = { ...prior, id: 'fork-request', phase: 'settled',
      operationIds: undefined, selectionDigest: undefined };
  });
  const selective = new MemorySelectiveService(store, { owner, scope: null,
    async writerSettled() { return true; }, async removeSource(operation) { removed.push(operation.id); },
    async listMemoryDocuments() { return [...docs.keys()].sort(); },
    async readMemory(uri) { return docs.get(uri); },
    async replaceMemory(uri, content) { docs.set(uri, content); },
    async removeMemory(uri) { docs.delete(uri); },
  });
  await store.transact(state => { state.operations[meetingId].memoryUris = [teaUri]; });
  docs.set(teaUri, 'Favorite tea: jasmine\nMeeting day: Tuesday'); docs.delete(meetingUri);
  await assert.rejects(selective.begin({ kind: 'forget', memoryUri: teaUri,
    selectedText: 'Favorite tea: jasmine' }), /MEMORY_TARGET_AMBIGUOUS/);
  assert.equal((await store.read()).governance, undefined);
  await store.transact(state => { state.operations[meetingId].memoryUris = [meetingUri]; });
  docs.set(teaUri, 'Favorite tea: jasmine'); docs.set(meetingUri, 'Meeting day: Tuesday');
  const job = await selective.begin({ kind: 'forget', memoryUri: teaUri, selectedText: 'Favorite tea: jasmine' });
  assert.deepEqual(job.operationIds, [teaId]);
  assert.deepEqual(job.collectionRequestIds, ['fork-request']);
  const stale = await delivery.collectSelection({ status: 'ready', requestIds: ['fork-request'],
    facts: [fact(old), fact(unrelated)] });
  assert.deepEqual(stale, { status: 'recorded', operationIds: [meetingId] });
  assert.equal((await selective.advance(job.id)).status, 'complete');
  const state = await store.read();
  assert.deepEqual(removed, [teaId]);
  assert.equal(state.operations[teaId].phase, 'blocked');
  assert.equal(state.operations[meetingId].phase, 'ready');
  assert.equal(docs.get(meetingUri), 'Meeting day: Tuesday');
  assert.equal(docs.has(teaUri), false);
  assert.deepEqual(state.operations[teaId].memoryUris, []);
  assert.deepEqual(state.governance.jobs[job.id].memoryUris, []);
  await store.transact(current => {
    const prior = current.collectionRequests[requestId];
    current.collectionRequests['late-fork'] = { ...prior, id: 'late-fork', phase: 'settled',
      operationIds: undefined, selectionDigest: undefined };
  });
  const replay = await delivery.collectSelection({ status: 'ready', requestIds: ['late-fork'],
    facts: [fact('Jasmine tea is my favorite.')] });
  assert.deepEqual(replay, { status: 'recorded', operationIds: [] });
  assert.equal(Object.keys((await store.read()).operations).length, 2);
});

test('correcting a multi-fact explicit save restores an unrelated document removed with its source', async t => {
  const f = await setup(t);
  const preferenceUri = 'viking://user/alice/memories/preferences/language.md';
  const preference = '- Replies in Simplified Chinese';
  f.docs.set(preferenceUri, preference);
  await f.store.transact(state => {
    state.operations[f.target.id].memoryUris = [f.uri, preferenceUri];
  });
  let loseReply = true;
  f.transport.removeSource = async operation => {
    f.removedSources.push(operation.id);
    f.docs.delete(f.uri);
    f.docs.delete(preferenceUri);
    if (loseReply) { loseReply = false; throw new Error('lost deletion reply'); }
  };
  const classifier = async ({ candidateText }) => candidateText === preference || candidateText.includes('Meeting day')
    ? 'unrelated' : 'uncertain';
  const selective = new MemorySelectiveService(f.store, f.transport, f.drainWriter, classifier);
  const replacement = '- Favorite tea: oolong';
  const job = await selective.begin({ kind: 'correct', memoryUri: f.uri,
    selectedText: f.old, replacementText: replacement });
  assert.equal((await selective.advance(job.id)).status, 'pending');
  assert.equal((await f.store.read()).governance.jobs[job.id].preservedDocuments[preferenceUri], preference);
  const reopened = new FileStateStore({ owner: f.owner, directory: f.directory, policyVersion: 'v1' });
  assert.equal((await new MemorySelectiveService(reopened, f.transport).advance(job.id)).status, 'complete');
  assert.equal(f.docs.get(f.uri), `${replacement}\n${f.unrelated}`);
  const state = await f.store.read();
  const movedPreference = state.operations[f.target.id].memoryUris[1];
  assert.match(movedPreference, /\/memories\/preserved\/[a-f0-9]{64}\.md$/);
  assert.equal(f.docs.has(preferenceUri), false);
  assert.equal(f.docs.get(movedPreference), preference);
  assert(![...f.docs.values()].some(value => value.includes(f.old)));
  assert.deepEqual(state.governance.jobs[job.id].preservedUris, [movedPreference]);
  assert.equal(state.governance.jobs[job.id].preservedDocuments, undefined);
  const exported = await new MemoryExportService(f.store, f.transport).page({ limit: 10 });
  assert.equal(exported.items.find(item => item.uri === movedPreference).sources[0].status, 'preserved');
});
