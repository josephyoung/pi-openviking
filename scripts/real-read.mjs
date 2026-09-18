import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OwnerMemoryClient, FileStateStore } from '../dist/host.js';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert(config.owner.accountId.startsWith('extension-test-'));
const client = new OwnerMemoryClient({ ...config, timeoutMs: 15000 });
await client.verifyIdentity();
const store = new FileStateStore({ owner: config.owner, directory: join(dirname(process.argv[2]), 'state'), policyVersion: 'test-v1' });
const operation = Object.values((await store.read()).operations).find(item => item.phase === 'ready');
assert(operation, 'Run the actual save integration first');
const content = await client.readMemory(operation.memoryUris[0]);
assert(content.includes('目标和非目标'));
const otherUser = config.owner.userId === 'alice' ? 'bob' : 'alice';
await assert.rejects(client.readMemory(`viking://user/${otherUser}/memories/fact.md`), /MEMORY_SCOPE_MISMATCH/);
const wrong = new OwnerMemoryClient({ ...config, owner: { ...config.owner, userId: otherUser }, timeoutMs: 15000 });
await assert.rejects(wrong.verifyIdentity(), /MEMORY_CREDENTIAL_OWNER_MISMATCH/);
console.log(JSON.stringify({ realOwnerVerified: true, savedContentReadable: true,
  foreignReferenceRejected: true, wrongCredentialBindingRejected: true }));
