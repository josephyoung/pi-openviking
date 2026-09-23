import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStateStore, MemoryDelivery, MemoryGovernanceBarrier, MemoryExportService } from '../dist/host.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  const ownUri = 'viking://user/alice/memories/preferences/one.md';
  const secondUri = 'viking://user/alice/memories/preferences/two.md';
  const projectUri = 'viking://user/alice/peers/project-a/memories/one.md';
  const own = await delivery.save({ sessionId: 'chat-one', entryId: 'entry-one', branchId: 'entry-one', contentVersion: 'v1' }, 'own text');
  const project = await delivery.save({ sessionId: 'chat-project', entryId: 'entry-project', branchId: 'entry-project', contentVersion: 'v1' }, 'project text', 'project-a');
  await store.transact(state => {
    state.operations[own.id].phase = 'ready'; state.operations[own.id].memoryUris = [ownUri];
    state.operations[project.id].phase = 'ready'; state.operations[project.id].memoryUris = [projectUri];
  });
  const transport = { owner, scope: null, async listMemoryDocuments() { return [ownUri, secondUri]; },
    async memoryDocumentSize(uri) { return Buffer.byteLength(uri === ownUri ? 'own text' : 'untracked owned text'); },
    async readMemoryLimited(uri, maxBytes) {
      const content = uri === ownUri ? 'own text' : 'untracked owned text';
      if (Buffer.byteLength(content) > maxBytes) throw new Error('MEMORY_EXPORT_TOO_LARGE');
      return content;
    } };
  return { store, owner, transport, ownUri, secondUri, projectUri };
}

test('export pages current scope with source metadata and no foreign project', async t => {
  const f = await setup(t);
  const exportService = new MemoryExportService(f.store, f.transport);
  const first = await exportService.page({ limit: 1 });
  assert.deepEqual(first.items, [{ uri: f.ownUri, content: 'own text', sources: [
    { kind: 'explicit', status: 'current', sessionId: 'chat-one', entryId: 'entry-one', createdAt: first.items[0].sources[0].createdAt },
  ], revisions: [] }]);
  assert(first.nextCursor);
  const second = await exportService.page({ limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second, { items: [{ uri: f.secondUri, content: 'untracked owned text', sources: [], revisions: [] }], nextCursor: undefined });
  assert(!JSON.stringify([first, second]).includes(f.projectUri));
});

test('export rejects owner, scope, malformed cursor, foreign URI, and changed state', async t => {
  const f = await setup(t);
  assert.throws(() => new MemoryExportService(f.store, { ...f.transport, owner: { accountId: 'account', userId: 'bob' } }), /OWNER_MISMATCH/);
  const exportService = new MemoryExportService(f.store, f.transport);
  await assert.rejects(exportService.page({ limit: 0 }), /INVALID_MEMORY_EXPORT_LIMIT/);
  await assert.rejects(exportService.page({ limit: 1, cursor: '../foreign' }), /INVALID_MEMORY_EXPORT_CURSOR/);
  const cursor = (await exportService.page({ limit: 1 })).nextCursor;
  const foreign = new MemoryExportService(f.store, { ...f.transport, scope: 'project-a',
    async listMemoryDocuments() { return [f.projectUri]; } });
  await assert.rejects(foreign.page({ limit: 1, cursor }), /INVALID_MEMORY_EXPORT_CURSOR/);
  await f.store.transact(state => { state.authorization.automaticCollection = false; });
  await assert.rejects(exportService.page({ limit: 1, cursor }), /INVALID_MEMORY_EXPORT_CURSOR/);
  await assert.rejects(new MemoryExportService(f.store, { ...f.transport,
    async listMemoryDocuments() { return [f.ownUri, 'viking://user/bob/memories/private.md']; } }).page({ limit: 2 }), /INVALID_MEMORY_RESPONSE/);
});

test('pending governance suppresses export, including paused management', async t => {
  const f = await setup(t);
  const exportService = new MemoryExportService(f.store, f.transport);
  await new MemoryDelivery({ store: f.store, transport: { owner: f.owner }, maxPayloadBytes: 8192 }).pause();
  assert.equal((await exportService.page({ limit: 10 })).items.length, 2);
  await new MemoryGovernanceBarrier(f.store).begin({ kind: 'clear', scope: null });
  await assert.rejects(exportService.page({ limit: 10 }), /MEMORY_GOVERNANCE_PENDING/);
});

test('export enforces byte budgets before reading and returns a cursor for the next fitting document', async t => {
  const f = await setup(t);
  const reads = [];
  const transport = { ...f.transport,
    async readMemoryLimited(uri, maxBytes) { reads.push([uri, maxBytes]); return f.transport.readMemoryLimited(uri, maxBytes); } };
  const service = new MemoryExportService(f.store, transport, 100, 100);
  const first = await service.page({ limit: 2, maxBytes: 10 });
  assert.deepEqual(first.items.map(item => item.uri), [f.ownUri]);
  assert(first.nextCursor);
  assert.deepEqual(reads, [[f.ownUri, 10]]);
  await assert.rejects(service.page({ limit: 1, cursor: first.nextCursor, maxBytes: 10 }), /MEMORY_EXPORT_TOO_LARGE/);
  assert.deepEqual(reads, [[f.ownUri, 10]]);
  await assert.rejects(new MemoryExportService(f.store, { ...f.transport,
    async memoryDocumentSize() { return 1; }, async readMemoryLimited(_uri, maxBytes) {
      assert.equal(maxBytes, 100); throw new Error('MEMORY_EXPORT_TOO_LARGE');
    } }, 100, 100)
    .page({ limit: 1 }), /MEMORY_EXPORT_TOO_LARGE/);
});
