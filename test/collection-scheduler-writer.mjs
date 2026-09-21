import { readFile } from 'node:fs/promises';
import { CollectionScheduler, FileStateStore, MemoryDelivery } from '../dist/host.js';
const { storeOptions, id } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const store = new FileStateStore(storeOptions);
const request = (await store.read()).collectionRequests[id];
const entries = request.sourceEntries.map(id => ({ id }));
const session = { getSessionId: () => request.sessionId, getEntries: () => entries, getBranch: () => entries };
const scheduler = new CollectionScheduler({ store,
  delivery: new MemoryDelivery({ store, transport: { owner: store.owner }, maxPayloadBytes: 8192 }),
  selector: { async select() { process.send('claimed'); return new Promise(() => {}); } },
  resolveSession: async () => session, pollIntervalMs: 10, mergeWindowMs: 0, maxWaitMs: 100,
  workTimeoutMs: 1000, leaseMs: 1200, initialBackoffMs: 10, maxBackoffMs: 20, maxAttempts: 2,
  maxRequestsPerBatch: 10, wakeDelivery() {} });
scheduler.start();
setInterval(() => {}, 1000);
