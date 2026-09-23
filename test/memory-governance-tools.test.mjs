import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenVikingExtension, FileStateStore, MemoryDelivery,
  MemoryGovernanceService, MemoryGovernanceScheduler } from '../dist/host.js';

test('model and management tools use host governance; clear requires real UI confirmation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-governance-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'account', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const calls = [];
  let isolated = true;
  const governance = {
    async correct(...args) { calls.push(['correct', ...args]); return { jobId: 'correct-id', status: 'pending' }; },
    async forget(...args) { calls.push(['forget', ...args]); return { jobId: 'forget-id', status: 'complete' }; },
    async clear() { calls.push(['clear']); return { jobId: 'clear-id', status: 'pending' }; },
    async exportPage(limit, cursor) { calls.push(['export', limit, cursor]); return { items: [{ uri: 'own', content: 'synthetic', sources: [], revisions: [] }] }; },
    async status(id) { return { jobId: id, status: 'pending' }; },
    wake() { calls.push(['wake']); },
  };
  const tools = new Map();
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
  const service = new MemoryGovernanceService(store, client);
  const receipt = await service.clear();
  assert.equal(receipt.status, 'pending');
  assert.equal((await service.status(receipt.jobId)).status, 'pending');
  settled = true;
  const reopened = new MemoryGovernanceService(new FileStateStore({ owner, directory, policyVersion: 'v1' }), client);
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
