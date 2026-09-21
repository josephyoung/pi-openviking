import { FileStateStore, MemoryGovernanceBarrier } from '../dist/host.js';
const store = new FileStateStore({ owner: { accountId: 'test', userId: 'alice' }, directory: process.argv[2], policyVersion: 'v1' });
try {
  const job = await new MemoryGovernanceBarrier(store).begin({ kind: 'forget', scope: null,
    memoryUri: 'viking://user/alice/memories/preferences/fact.md' });
  process.send({ status: 'persisted', id: job.id });
} catch (error) { process.send({ status: 'rejected', code: error.message }); }
setInterval(() => {}, 1000);
