import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FileStateStore, MemoryDelivery, DeliveryScheduler, OwnerMemoryClient } from '../dist/host.js';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert(config.owner.accountId.startsWith('extension-test-'));
const root = dirname(process.argv[2]);
const store = new FileStateStore({ owner: config.owner, directory: join(root, 'state'), policyVersion: 'test-v1' });
const client = new OwnerMemoryClient({ ...config, timeoutMs: 15000 });
const delivery = new MemoryDelivery({ store, transport: client, maxPayloadBytes: 8192 });
await delivery.enable('test-v1');
const operation = await delivery.save({ sessionId: 'scheduler-test', entryId: 'preference', branchId: 'root', contentVersion: '1' },
  '请记住我的稳定偏好：所有技术方案都要写清目标和非目标，默认用简体中文。');
const start = Date.now();
let phase;
const scheduler = new DeliveryScheduler({ store, delivery, pollIntervalMs: 500, initialBackoffMs: 500,
  maxBackoffMs: 5000, maxAttemptsPerPhase: 90, maxOperationsPerTick: 5,
  onStatus(status) { if (status.phase !== phase) { phase = status.phase; console.log(JSON.stringify({ phase, elapsedMs: Date.now() - start })); } } });
try {
  scheduler.start();
  for (let i = 0; i < 90; i++) {
    const current = (await store.read()).operations[operation.id];
    if (current.phase === 'ready') {
      const found = await client.recall('技术方案的语言和格式偏好', 5);
      assert(found.some(item => item.text.includes('目标和非目标')));
      assert(found.some(item => item.text.includes('简体中文')));
      const evidence = { backgroundDeliveryReady: true, phase: current.phase, taskId: current.taskId,
        operationId: current.id, elapsedMs: Date.now() - start, memoryCount: current.memoryUris.length };
      await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(evidence));
      break;
    }
    assert(!['blocked', 'failed', 'blocked_by_pause'].includes(current.phase), current.errorCode);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal((await store.read()).operations[operation.id].phase, 'ready');
} finally { await scheduler.stop(1000); }
