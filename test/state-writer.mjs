import { FileStateStore } from '../dist/state-store.js';
const store = new FileStateStore({ owner: { accountId: 'test', userId: 'alice' },
  directory: process.argv[2], policyVersion: 'v1' });
if (process.argv[3] === 'crash') {
  await store.transact(state => { state.authorization.epoch = 999; process.kill(process.pid, 'SIGKILL'); });
} else {
  for (let i = 0; i < 10; i++) await store.transact(state => { state.authorization.epoch++; });
}
