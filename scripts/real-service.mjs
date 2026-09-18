// Explicit opt-in integration run. Config must identify a disposable account.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FileStateStore } from '../dist/state-store.js';
import { MemoryDelivery } from '../dist/delivery.js';
import { OwnerMemoryClient } from '../dist/openviking-client.js';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert(config.owner.accountId.startsWith('extension-test-'));
const root = dirname(process.argv[2]);
const store = new FileStateStore({ owner: config.owner, directory: join(root, 'state'), policyVersion: 'test-v1' });
const transport = new OwnerMemoryClient({ ...config, timeoutMs: 15000 });
const service = new MemoryDelivery({ store, transport, maxPayloadBytes: 8192 });
const source = { sessionId: 'explicit-memory-test', entryId: 'preference-1', branchId: 'root', contentVersion: '1' };
assert.equal((await service.save(source, '不得发送的未授权测试内容')).phase, 'blocked');
await service.enable('test-v1');
const operation = await service.save(source, '请记住我的稳定偏好：所有技术方案都要写清目标和非目标，默认用简体中文。');
const start = Date.now();
let phase;
for (let i = 0; i < 100; i++) {
  // Recreate the actual adapter for every step, forcing durable state recovery.
  await new MemoryDelivery({ store: new FileStateStore({ owner: config.owner,
    directory: join(root, 'state'), policyVersion: 'test-v1' }), transport, maxPayloadBytes: 8192 }).advance(operation.id);
  const current = (await store.read()).operations[operation.id];
  if (current.phase !== phase) {
    phase = current.phase;
    console.log(JSON.stringify({ phase, elapsedMs: Date.now() - start, errorCode: current.errorCode }));
  }
  if (phase === 'ready') {
    const memories = await transport.recall('技术方案的语言和格式偏好', 5);
    assert(memories.some(memory => memory.text.includes('目标和非目标')));
    assert(memories.some(memory => memory.text.includes('简体中文')));
    const evidence = { ready: true, operationId: operation.id, source, phase, taskId: current.taskId,
      memoryCount: current.memoryUris.length, elapsedMs: Date.now() - start, owner: config.owner };
    await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(evidence));
    break;
  }
  assert(!['failed', 'blocked', 'blocked_by_pause'].includes(phase), current.errorCode);
  await new Promise(resolve => setTimeout(resolve, 2000));
}
assert.equal(phase, 'ready');
