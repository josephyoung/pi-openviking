import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, rm, symlink, writeFile, chown } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateProtectedPaths } from '../dist/bootstrap.js';

async function fixture(t) {
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', 'pi-memory-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chown(root, process.getuid(), process.getgid());
  await chmod(root, 0o710);
  const paths = { hostUid: process.getuid(), workerUid: process.getuid() === 65534 ? 65533 : 65534,
    workerGid: process.getgid(), workspace: join(root, 'workspace'), agentDir: join(root, 'agent'),
    stateDir: join(root, 'state'), installationDir: join(root, 'install') };
  for (const key of ['workspace', 'agentDir', 'stateDir', 'installationDir']) {
    await mkdir(paths[key], { mode: 0o700 });
    await chown(paths[key], process.getuid(), process.getgid());
  }
  await chmod(paths.workspace, 0o770); await chmod(paths.installationDir, 0o750);
  return { root, paths };
}

test('protected roots are separate and canonicalized', async t => {
  const { root, paths } = await fixture(t);
  const alias = join(root, 'alias'); await symlink(paths.stateDir, alias);
  const result = await validateProtectedPaths({ ...paths, stateDir: alias });
  assert.equal(result.stateDir, paths.stateDir);
});

test('workspace aliases cannot hide a private-root overlap', async t => {
  const { root, paths } = await fixture(t);
  const alias = join(root, 'alias'); await symlink(paths.workspace, alias);
  await assert.rejects(validateProtectedPaths({ ...paths, stateDir: alias }), /WORKSPACE_OVERLAP/);
  const installedState = join(paths.installationDir, 'state');
  await mkdir(installedState, { mode: 0o700 });
  await assert.rejects(validateProtectedPaths({ ...paths, stateDir: installedState }), /INSTALLATION_STATE_OVERLAP/);
});

test('worker-writable installation or replaceable ancestor is refused', async t => {
  const { root, paths } = await fixture(t);
  await chmod(paths.installationDir, 0o770);
  await assert.rejects(validateProtectedPaths(paths), /REPLACE_PROTECTED/);
  await chmod(paths.installationDir, 0o750); await chmod(root, 0o770);
  await assert.rejects(validateProtectedPaths(paths), /REPLACE_PROTECTED/);
});

test('private roots with group access and a non-writable workspace are refused', async t => {
  const { paths } = await fixture(t);
  await chmod(paths.stateDir, 0o750);
  await assert.rejects(validateProtectedPaths(paths), /PRIVATE_DIRECTORY_REQUIRED/);
  await chmod(paths.stateDir, 0o700); await chmod(paths.workspace, 0o750);
  await assert.rejects(validateProtectedPaths(paths), /CANNOT_USE_WORKSPACE/);
});


test('nested writable code and dependency links outside the installation are refused', async t => {
  const { paths } = await fixture(t);
  const code = join(paths.installationDir, 'code.js');
  await writeFile(code, 'export default 1'); await chmod(code, 0o660);
  await assert.rejects(validateProtectedPaths(paths), /REPLACE_PROTECTED/);
  await chmod(code, 0o640);
  await symlink(paths.workspace, join(paths.installationDir, 'dependency'));
  await assert.rejects(validateProtectedPaths(paths), /INSTALLATION_LINK_ESCAPES_ROOT/);
});
