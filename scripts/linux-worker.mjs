import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, chown, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeToolWorker } from '../dist/tool-worker.js';
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
const [hostUid, workerUid, groupId] = process.argv.slice(2, 5).map(Number);
assert([hostUid, workerUid, groupId].every(id => Number.isSafeInteger(id) && id > 0));
const root = await mkdtemp('/tmp/pi-memory-worker-');
const workspace = join(root, 'workspace'), protectedDir = join(root, 'private');
await chmod(root, 0o711); await chown(root, hostUid, groupId);
await mkdir(workspace, { mode: 0o770 }); await chown(workspace, workerUid, groupId); await chmod(workspace, 0o770);
await mkdir(protectedDir, { mode: 0o700 }); await chown(protectedDir, hostUid, groupId);
const credential = join(protectedDir, 'credential');
await writeFile(credential, 'SYNTHETIC_PRIVATE_VALUE', { mode: 0o600 }); await chown(credential, hostUid, groupId);
await symlink(protectedDir, join(workspace, 'private-link'));
process.env.MEMORY_SYNTHETIC_KEY = 'SYNTHETIC_PRIVATE_VALUE';
const worker = new NativeToolWorker({ workspace, piPackageContext: '/app/package.json',
  hostUid, workerUid, workerGid: groupId, path: process.env.PATH,
  startupTimeoutMs: 10000, operationTimeoutMs: 5000, maxConcurrentOperations: 4, maxResultBytes: 1024 * 1024 });
process.setgid(groupId); process.setuid(hostUid);
try {
  await worker.assertIsolated();
  await worker.execute('write', { path: 'allowed.txt', content: 'WORKSPACE_OK' });
  const read = await worker.execute('read', { path: 'allowed.txt' });
  assert(read.content.some(item => item.text?.includes('WORKSPACE_OK')));
  for (const path of [credential, 'private-link/credential']) {
    await assert.rejects(worker.execute('read', { path }), /TOOL_FAILED/);
    await assert.rejects(worker.execute('write', { path, content: 'changed' }), /TOOL_FAILED/);
    await assert.rejects(worker.execute('edit', { path, edits: [{ oldText: 'SYNTHETIC_PRIVATE_VALUE', newText: 'changed' }] }), /TOOL_FAILED/);
  }
  let updates = 0;
  const bash = await worker.execute('bash', { command: 'test -z "$MEMORY_SYNTHETIC_KEY" && echo NO_INHERITED_KEY' }, undefined, () => { updates++; });
  assert(updates > 0);
  assert(bash.content.some(item => item.text?.includes('NO_INHERITED_KEY')));
  assert.equal(await readFile(credential, 'utf8'), 'SYNTHETIC_PRIVATE_VALUE');
  const controller = new AbortController();
  const running = worker.execute('bash', { command: 'sleep 30' }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, /CANCELLED/);
  console.log(JSON.stringify({ nativeWorker: true, hostUid, workerUid,
    privateReadWriteEditDenied: true, symlinkDenied: true, credentialAbsentFromEnvironment: true,
    workspaceReadWrite: true, streamingUpdates: true, cancellation: true, finalLauncherVerified: false }));
} finally {
  worker.close();
  delete process.env.MEMORY_SYNTHETIC_KEY;
  await rm(root, { recursive: true });
}
