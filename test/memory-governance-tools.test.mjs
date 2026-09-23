import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenVikingExtension, FileStateStore, MemoryDelivery,
  MemoryGovernanceBarrier, MemoryGovernanceService, MemoryGovernanceScheduler } from '../dist/host.js';

test('model and management tools use host governance; clear requires real UI confirmation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-governance-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  const calls = [];
  let isolated = true;
  const governance = {
    owner, scope: null,
    async correct(...args) { calls.push(['correct', ...args]); return { jobId: 'correct-id', status: 'pending' }; },
    async forget(...args) { calls.push(['forget', ...args]); return { jobId: 'forget-id', status: 'complete' }; },
    async clear() { calls.push(['clear']); return { jobId: 'clear-id', status: 'pending' }; },
    async exportPage(limit, cursor) { calls.push(['export', limit, cursor]); return { items: [{ uri: 'own', content: 'synthetic', sources: [], revisions: [] }] }; },
    async status(id) { return { jobId: id, status: 'pending' }; },
    wake() { calls.push(['wake']); },
  };
  const tools = new Map();
  assert.throws(() => createOpenVikingExtension({ owner, scope: 'project-a',
    client: { owner, scope: 'project-a' }, stateStore: store,
    governance: { ...governance, scope: 'project-b' }, assertToolIsolation: async () => {},
    policy: { maxPayloadBytes: 8192, recallTimeoutMs: 100, recallTokenBudget: 1000,
      recallLimit: 5, minimumScore: 0, countTokens: () => 1 }, wakeDelivery() {} }),
  /MEMORY_GOVERNANCE_SCOPE_MISMATCH/);
  createOpenVikingExtension({ owner, client: { owner, async recall() { return []; } },
    stateStore: store, governance, assertToolIsolation: async () => { if (!isolated) throw new Error('worker failed'); },
    policy: { maxPayloadBytes: 8192, recallTimeoutMs: 100, recallTokenBudget: 1000,
      recallLimit: 5, minimumScore: 0, countTokens: () => 1 }, wakeDelivery() {} })({
    on() {}, registerTool(tool) { tools.set(tool.name, tool); },
  });
  assert.deepEqual([...tools.keys()], ['memory_save', 'memory_correct', 'memory_forget', 'memory_clear', 'memory_export', 'memory_status']);
  const run = (name, params, ctx = {}) => tools.get(name).execute('call', params, undefined, undefined, ctx);
  const pending = await run('memory_correct', { memoryUri: 'own', selectedText: 'old', replacementText: 'new' });
  assert.equal(pending.details.status, 'pending');
  assert.match(pending.details.message, /不可声称/);
  assert.equal((await run('memory_forget', { memoryUri: 'own', selectedText: 'old' })).details.status, 'complete');
  assert.equal((await run('memory_clear', {}, { ui: { confirm: async () => false } })).details.status, 'cancelled');
  assert(!calls.some(([kind]) => kind === 'clear'));
  assert.equal((await run('memory_clear', {}, { ui: { confirm: async () => true } })).details.status, 'pending');
  assert.deepEqual((await run('memory_export', { limit: 1 })).details.items[0].sources, []);
  await delivery.pause();
  assert.equal((await run('memory_export', { limit: 1 })).details.errorCode, 'MEMORY_DISABLED');
  assert.equal(calls.filter(([kind]) => kind === 'export').length, 1);
  await delivery.enable('v1');
  const exportPage = governance.exportPage;
  governance.exportPage = async (...args) => {
    const page = await exportPage(...args);
    await delivery.pause();
    return page;
  };
  assert.equal((await run('memory_export', { limit: 1 })).details.errorCode, 'MEMORY_DISABLED');
  assert.equal(calls.filter(([kind]) => kind === 'export').length, 2);
  assert.equal((await run('memory_status', { jobId: 'clear-id' })).details.status, 'pending');
  assert.deepEqual(calls.filter(([kind]) => kind === 'clear'), [['clear']]);
  isolated = false;
  assert.equal((await run('memory_forget', { memoryUri: 'own', selectedText: 'old' })).details.errorCode, 'MEMORY_UNAVAILABLE');
  assert.equal(calls.filter(([kind]) => kind === 'forget').length, 1);
});

test('owner scheduler recovers a pending clear without an open viewer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-governance-scheduler-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  await delivery.save({ sessionId: 'chat', entryId: 'entry', branchId: 'entry', contentVersion: 'v1' }, 'synthetic fact');
  let settled = false, clears = 0;
  const client = { owner, scope: null,
    async writerSettled() { return settled; }, async removeSource() {},
    async clearMemoryScope() { clears++; },
    async listMemoryDocuments() { return []; }, async readMemory() { throw new Error('unused'); },
    async replaceMemory() { throw new Error('unused'); }, async removeMemory() { throw new Error('unused'); },
  };
  const service = new MemoryGovernanceService(store, client, delivery);
  const receipt = await service.clear();
  assert.equal(receipt.status, 'pending');
  assert.equal((await service.status(receipt.jobId)).status, 'pending');
  settled = true;
  const reopened = new MemoryGovernanceService(new FileStateStore({ owner, directory, policyVersion: 'v1' }), client, delivery);
  const scheduler = new MemoryGovernanceScheduler(reopened, 10);
  scheduler.start();
  try {
    for (const deadline = Date.now() + 2000; Date.now() < deadline;) {
      if ((await reopened.status(receipt.jobId)).status === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await reopened.status(receipt.jobId)).status, 'complete');
    assert.equal(clears, 1);
  } finally { await scheduler.stop(); }
});

test('confirmed scope clear supersedes a stuck selective edit without releasing the barrier', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-clear-supersede-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  const uri = 'viking://user/alice/memories/old.md';
  const selective = await new MemoryGovernanceBarrier(store).begin({ kind: 'forget', scope: null,
    memoryUri: uri, selectivePlan: { memoryUri: uri, selectedText: 'old fact', replacementText: '' } });
  let clears = 0, available = false;
  const client = { owner, scope: null, async writerSettled() { return true; }, async removeSource() {},
    async clearMemoryScope() { clears++; if (!available) throw new Error('REMOTE_UNAVAILABLE'); }, async listMemoryDocuments() { return []; },
    async readMemory() { throw new Error('unused'); }, async replaceMemory() {}, async removeMemory() {} };
  const service = new MemoryGovernanceService(store, client, delivery);
  const receipt = await service.clear();
  assert.equal(receipt.status, 'pending');
  assert.notEqual(receipt.jobId, selective.id);
  assert.equal((await service.status(selective.id)).status, 'pending');
  available = true;
  assert.equal((await service.advancePending()).status, 'complete');
  assert.equal((await service.status(selective.id)).status, 'superseded');
  const state = await store.read();
  assert.equal(state.governance.jobs[selective.id].phase, 'complete');
  assert.equal(state.governance.jobs[selective.id].selectivePlan, undefined);
  assert.equal(state.governance.jobs[receipt.jobId].phase, 'complete');
  assert.equal(clears, 2);
});

test('retirement fences new access and retains a recoverable clear until remote success', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-retirement-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  const operation = await delivery.save({ sessionId: 'chat', entryId: 'old', branchId: 'old', contentVersion: 'v1' }, 'old fact');
  const selective = await new MemoryGovernanceBarrier(store).begin({ kind: 'forget', scope: null,
    memoryUri: 'viking://user/alice/memories/old.md',
    selectivePlan: { memoryUri: 'viking://user/alice/memories/old.md', selectedText: 'old fact', replacementText: '' } });
  let available = false;
  const client = { owner, scope: null, async writerSettled() { return true; },
    async writerSettledAny() { return true; },
    async clearOwnerData() { if (!available) throw new Error('REMOTE_UNAVAILABLE'); },
    async removeSource() {}, async clearMemoryScope() {},
    async listMemoryDocuments() { return []; }, async readMemory() { throw new Error('unused'); },
    async replaceMemory() {}, async removeMemory() {},
  };
  const service = new MemoryGovernanceService(store, client, delivery);
  const first = await service.retire();
  assert.equal(first.status, 'pending');
  assert.equal((await store.read()).retirement.phase, 'requested');
  assert.equal((await store.read()).governance.jobs[selective.id].phase, 'draining');
  assert.equal((await service.status(selective.id)).status, 'pending');
  await assert.rejects(delivery.enable('v1'), /MEMORY_RETIRED/);
  available = true;
  const resumed = new MemoryGovernanceService(new FileStateStore({ owner, directory, policyVersion: 'v1' }), client, delivery);
  const last = await resumed.retire();
  assert.equal(last.status, 'complete');
  const state = await store.read();
  assert.equal(state.retirement.phase, 'remote_cleared');
  assert.equal(state.retirement.id, first.jobId);
  assert.equal(state.governance.jobs[selective.id].cancelledByRetirement, true);
  assert.equal((await resumed.status(selective.id)).status, 'superseded');
  assert.equal(state.operations[operation.id].payload, undefined);
  assert.equal((await resumed.retire()).status, 'complete');
});

test('retirement preserves a governance job that completed before cleanup began', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-retirement-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  let available = false;
  const client = { owner, scope: null, async writerSettledAny() { return true; },
    async clearOwnerData() { if (!available) throw new Error('REMOTE_UNAVAILABLE'); },
    async clearMemoryScope() {}, async listMemoryDocuments() { return []; },
    async readMemory() { throw new Error('unused'); }, async replaceMemory() {}, async removeMemory() {},
  };
  const service = new MemoryGovernanceService(store, client, delivery);
  const prior = await service.clear();
  assert.equal(prior.status, 'complete');
  assert.equal((await service.retire()).status, 'pending');
  assert.equal((await service.status(prior.jobId)).status, 'complete');
  available = true;
  assert.equal((await service.retire()).status, 'complete');
  assert.equal((await service.status(prior.jobId)).status, 'complete');
});

test('account retirement drains global and peer writers before owner-wide deletion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-multiscope-retire-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  await delivery.enable('v1');
  const source = entryId => ({ sessionId: entryId, entryId, branchId: entryId, contentVersion: 'v1' });
  await delivery.save(source('global'), 'global fact');
  await delivery.save(source('peer'), 'peer fact', 'project-a');
  let peerSettled = false, clears = 0;
  const checked = [];
  const client = { owner, scope: null, async writerSettledAny(operation) {
    checked.push(operation.scope); return operation.scope !== 'project-a' || peerSettled;
  }, async clearOwnerData() { clears++; }, async writerSettled() { throw new Error('wrong scope'); },
    async removeSource() {}, async clearMemoryScope() {}, async listMemoryDocuments() { return []; },
    async readMemory() { throw new Error('unused'); }, async replaceMemory() {}, async removeMemory() {} };
  const service = new MemoryGovernanceService(store, client, delivery);
  assert.equal((await service.retire()).status, 'pending');
  assert.equal(clears, 0);
  assert.deepEqual(checked, [null, 'project-a']);
  peerSettled = true;
  assert.equal((await service.retire()).status, 'complete');
  assert.equal(clears, 1);
  assert.equal((await store.read()).retirement.phase, 'remote_cleared');
  assert(Object.values((await store.read()).operations).every(operation => operation.phase === 'blocked'));
});
