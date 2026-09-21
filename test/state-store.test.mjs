import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { FileStateStore } from '../dist/state-store.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, 'private'), owner: { accountId: 'test', userId: 'alice' }, policyVersion: 'v1' };
}
function child(directory, mode) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['test/state-writer.mjs', directory, mode], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    proc.stderr.on('data', data => { errors += data; });
    proc.on('error', reject);
    proc.on('close', (code, signal) => code === 0 || signal === 'SIGKILL' ? resolve() : reject(new Error(errors)));
  });
}

test('default consent is disabled and a different owner cannot adopt existing state', async t => {
  const options = await fixture(t);
  const store = new FileStateStore(options);
  assert.equal((await store.read()).authorization.enabled, false);
  await store.transact(state => { state.authorization.enabled = true; });
  const bob = new FileStateStore({ ...options, owner: { accountId: 'test', userId: 'bob' } });
  await assert.rejects(bob.read(), /INVALID_MEMORY_STATE/);
  assert.equal((await stat(join(options.directory, 'state.json'))).mode & 0o777, 0o600);
});

test('eight processes serialize durable updates; a killed writer releases the lock without partial state', async t => {
  const options = await fixture(t);
  const store = new FileStateStore(options);
  await store.transact(() => {});
  await Promise.all(Array.from({ length: 8 }, () => child(options.directory, 'increment')));
  assert.equal((await store.read()).authorization.epoch, 80);
  await child(options.directory, 'crash');
  await child(options.directory, 'increment');
  assert.equal((await store.read()).authorization.epoch, 90);
});

test('same-process writers do not exhaust the libuv pool', async t => {
  const options = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, () => new FileStateStore(options).transact(state => { state.authorization.epoch++; })));
  assert.equal((await new FileStateStore(options).read()).authorization.epoch, 20);
});

test('rejects symlink state and asynchronous mutations', async t => {
  const options = await fixture(t);
  const store = new FileStateStore(options);
  await assert.rejects(store.transact(async state => { state.authorization.enabled = true; }), /ASYNC_MEMORY_TRANSACTION/);
  assert.equal((await store.read()).authorization.enabled, false);
  const target = join(options.root, 'external');
  await writeFile(target, '{}');
  await symlink(target, join(options.directory, 'state.json'));
  await assert.rejects(store.read(), /MEMORY_STATE_UNREADABLE/);
});

test('automatic consent without its durable policy boundary is rejected without repairing state', async t => {
  const options = await fixture(t);
  const store = new FileStateStore(options);
  await store.transact(() => {});
  const state = await store.read();
  state.authorization.automaticCollection = true;
  const invalid = JSON.stringify(state);
  const file = join(options.directory, 'state.json');
  await writeFile(file, invalid);
  await assert.rejects(store.read(), /INVALID_COLLECTION_CONSENT/);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(file, 'utf8'), invalid);
});

test('a corrupt source receipt cannot silently permit re-collection', async t => {
  const options = await fixture(t);
  const store = new FileStateStore(options);
  await store.transact(() => {});
  const state = await store.read();
  state.collectedSources = { ['a'.repeat(64)]: { operationId: 'b'.repeat(64), payloadDigest: 'c'.repeat(64) } };
  const invalid = JSON.stringify(state);
  const file = join(options.directory, 'state.json');
  await writeFile(file, invalid);
  await assert.rejects(store.read(), /INVALID_COLLECTION_LEDGER/);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(file, 'utf8'), invalid);
});

test('a malformed settled request cannot invent completed source references', async t => {
  const options = await fixture(t);
  const store = new FileStateStore(options);
  await store.transact(() => {});
  const state = await store.read();
  state.collectionRequests = { request: { id: 'request', sessionId: 'chat', baselineEntryId: null,
    scope: null, authorizationEpoch: 1, collectionRevision: 1, phase: 'settled',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceEntries: [] } };
  const invalid = JSON.stringify(state);
  const file = join(options.directory, 'state.json');
  await writeFile(file, invalid);
  await assert.rejects(store.read(), /INVALID_COLLECTION_REQUEST/);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(file, 'utf8'), invalid);
});


test('processed selection cannot refer to a missing automatic outbox operation', async t => {
  const options = await fixture(t);
  const store = new FileStateStore(options);
  await store.transact(() => {});
  const state = await store.read();
  state.collectionRequests = { request: { id: 'request', sessionId: 'chat', baselineEntryId: null,
    settledEntryId: 'last', scope: null, authorizationEpoch: 1, collectionRevision: 1, phase: 'processed',
    selectionDigest: 'a'.repeat(64), operationIds: ['b'.repeat(64)],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceEntries: ['user', 'last'] } };
  const invalid = JSON.stringify(state);
  const file = join(options.directory, 'state.json');
  await writeFile(file, invalid);
  await assert.rejects(store.read(), /INVALID_COLLECTION_RECEIPT/);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(file, 'utf8'), invalid);
});
