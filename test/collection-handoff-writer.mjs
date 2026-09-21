import { readFile } from 'node:fs/promises';
import { FileStateStore, MemoryDelivery } from '../dist/host.js';
const { options, selection } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const persistent = new FileStateStore(options);
const store = process.argv[3] === 'before-commit' ? {
  owner: persistent.owner, read: () => persistent.read(),
  transact: mutation => persistent.transact(state => { mutation(state); process.kill(process.pid, 'SIGKILL'); }),
} : persistent;
const delivery = new MemoryDelivery({ store, transport: { owner: store.owner }, maxPayloadBytes: 8192 });
await delivery.collectSelection(selection);
process.kill(process.pid, 'SIGKILL');
