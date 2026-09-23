import { FileStateStore, MemoryClearCoordinator } from '../dist/host.js';
const owner = { accountId: 'test', userId: 'alice' };
const store = new FileStateStore({ owner, directory: process.argv[2], policyVersion: 'v1' });
const transport = { owner, scope: null, async writerSettled() { return true; }, async removeSource() {},
  async clearMemoryScope() { process.send({ phase: 'remote-clear-in-flight' }); await new Promise(() => {}); } };
setInterval(() => {}, 1000);
await new MemoryClearCoordinator(store, transport).advance(process.argv[3]);
