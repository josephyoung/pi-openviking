import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, chown, writeFile, readFile, symlink, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapProtectedWorker, validateProtectedPaths } from '../dist/bootstrap.js';
import { createIsolatedToolDefinitions, createIsolatedBashOperations } from '../dist/worker-tools.js';
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
const [hostUid, workerUid, groupId] = process.argv.slice(2, 5).map(Number);
const toolProviderModule = process.argv[5];
assert([hostUid, workerUid, groupId].every(id => Number.isSafeInteger(id) && id > 0));
const root = await mkdtemp('/tmp/pi-memory-worker-');
const workspace = join(root, 'workspace'), protectedDir = join(root, 'private');
await chmod(root, 0o711); await chown(root, hostUid, groupId);
await mkdir(workspace, { mode: 0o770 }); await chown(workspace, workerUid, groupId); await chmod(workspace, 0o770);
await mkdir(protectedDir, { mode: 0o700 }); await chown(protectedDir, hostUid, groupId);
const credential = join(protectedDir, 'credential');
await writeFile(credential, 'SYNTHETIC_PRIVATE_VALUE', { mode: 0o600 }); await chown(credential, hostUid, groupId);
await symlink(protectedDir, join(workspace, 'private-link'));
const unsafeInstall = join(root, 'unsafe-install');
await mkdir(unsafeInstall, { mode: 0o755 });
const workerOwnedCode = join(unsafeInstall, 'readonly.js');
await writeFile(workerOwnedCode, 'export default 1', { mode: 0o444 });
await chown(workerOwnedCode, workerUid, groupId);
await assert.rejects(validateProtectedPaths({ workspace, agentDir: protectedDir, stateDir: protectedDir,
  installationDir: unsafeInstall, hostUid, workerUid, workerGid: groupId }), /REPLACE_PROTECTED/);
await rm(unsafeInstall, { recursive: true });
process.env.MEMORY_SYNTHETIC_KEY = 'SYNTHETIC_PRIVATE_VALUE';
const bootstrapOptions = { workspace, agentDir: protectedDir, stateDir: protectedDir,
  installationDir: '/app', hostGid: groupId, piPackageContext: fileURLToPath(new URL('../package.json', import.meta.url)), privilegeGuard: '/usr/bin/setpriv',
  hostUid, workerUid, workerGid: groupId, path: process.env.PATH,
  toolProviderModule,
  startupTimeoutMs: 10000, operationTimeoutMs: 5000, maxConcurrentOperations: 4, maxResultBytes: 1024 * 1024 };
const alternateInstallation = join(root, 'alternate-installation');
await mkdir(alternateInstallation, { mode: 0o755 });
await assert.rejects(bootstrapProtectedWorker({ ...bootstrapOptions, installationDir: alternateInstallation }), /EXTENSION_OUTSIDE/);
await rm(alternateInstallation, { recursive: true });
const outsideContext = join(workspace, 'package.json');
await writeFile(outsideContext, '{}');
await assert.rejects(bootstrapProtectedWorker({ ...bootstrapOptions, piPackageContext: outsideContext }), /PI_CONTEXT_OUTSIDE/);
await assert.rejects(bootstrapProtectedWorker({ ...bootstrapOptions, toolProviderModule: outsideContext }), /WORKER_PROVIDER_OUTSIDE/);
assert.equal(process.getuid(), 0);
const { worker } = await bootstrapProtectedWorker(bootstrapOptions);
try {
  await worker.assertIsolated();
  const definitions = createIsolatedToolDefinitions(worker);
  const proxyRead = definitions.find(tool => tool.name === 'read');
  const proxyWrite = definitions.find(tool => tool.name === 'write');
  await proxyWrite.execute('proxy-write', { path: 'proxy.txt', content: 'PROXY_OK' }, undefined, undefined, { cwd: workspace });
  const proxyResult = await proxyRead.execute('proxy-read', { path: 'proxy.txt' }, undefined, undefined, { cwd: workspace });
  assert(proxyResult.content.some(item => item.text?.includes('PROXY_OK')));
  await assert.rejects(proxyRead.execute('proxy-denied', { path: credential }, undefined, undefined, { cwd: workspace }), /TOOL_FAILED/);
  let shellOutput = '';
  const shell = await createIsolatedBashOperations(worker).exec('test -z "$MEMORY_SYNTHETIC_KEY" && echo INTERACTIVE_SAFE; exit 7', workspace,
    { env: { MEMORY_SYNTHETIC_KEY: 'must-not-cross-ipc' }, onData: data => { shellOutput += data; } });
  assert.equal(shell.exitCode, 7);
  assert(shellOutput.includes('INTERACTIVE_SAFE'));
  await worker.execute('write', { path: 'allowed.txt', content: 'WORKSPACE_OK' });
  const read = await worker.execute('read', { path: 'allowed.txt' });
  assert(read.content.some(item => item.text?.includes('WORKSPACE_OK')));
  if (toolProviderModule) assert.equal(read.details.workerProvider, true);
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
  const running = worker.execute('bash', { command: 'sleep 1; printf failed > cancelled-native.txt' }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, /CANCELLED/);
  const interactiveAbort = new AbortController();
  const interactive = createIsolatedBashOperations(worker).exec('sleep 1; printf failed > cancelled-interactive.txt', workspace,
    { signal: interactiveAbort.signal, onData() {} });
  setTimeout(() => interactiveAbort.abort(), 100);
  await assert.rejects(interactive, /CANCELLED/);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await assert.rejects(access(join(workspace, 'cancelled-native.txt')), { code: 'ENOENT' });
  await assert.rejects(access(join(workspace, 'cancelled-interactive.txt')), { code: 'ENOENT' });
  console.log(JSON.stringify({ nativeWorker: true, protectedBootstrap: true, customWorkerProvider: Boolean(toolProviderModule), outsideWorkerProviderRejected: true, outsidePiContextRejected: true, workerOwnedReadonlyCodeRejected: true, noNewPrivileges: true, toolProxies: true, interactiveShell: true, hostUid, workerUid,
    privateReadWriteEditDenied: true, symlinkDenied: true, credentialAbsentFromEnvironment: true,
    workspaceReadWrite: true, streamingUpdates: true, cancellation: true, finalLauncherVerified: false }));
} finally {
  worker.close();
  delete process.env.MEMORY_SYNTHETIC_KEY;
  await rm(root, { recursive: true });
}
