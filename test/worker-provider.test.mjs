import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkerProvider, protectedWorkerModule } from '../dist/worker-provider.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-worker-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = join(root, 'install'); await mkdir(install);
  return { root, install };
}

test('only a canonical file inside the protected installation can supply worker tools', async t => {
  const { root, install } = await fixture(t);
  const inside = join(install, 'tools.mjs'); await writeFile(inside, '');
  assert.equal(await protectedWorkerModule(install, inside), await (await import('node:fs/promises')).realpath(inside));
  const outside = join(root, 'workspace.mjs'); await writeFile(outside, '');
  await symlink(outside, join(install, 'escape.mjs'));
  await assert.rejects(protectedWorkerModule(install, outside), /OUTSIDE_INSTALLATION/);
  await assert.rejects(protectedWorkerModule(install, join(install, 'escape.mjs')), /OUTSIDE_INSTALLATION/);
  await assert.rejects(protectedWorkerModule(install, 'relative.mjs'), /PATH_INVALID/);
  await assert.rejects(protectedWorkerModule(install, install), /OUTSIDE_INSTALLATION/);
});

test('host provider receives only workspace and preserves updates, cancellation and shell operations', async t => {
  const { install } = await fixture(t);
  const file = join(install, 'tools.mjs');
  await writeFile(file, `export function createWorkerTools(options) {
    if (Object.keys(options).join(',') !== 'workspace') throw new Error('unexpected host context');
    return { async execute(name, parameters, signal, update) {
      signal.throwIfAborted(); update({ name }); return { workspace: options.workspace, name, parameters };
    } };
  }`);
  const provider = await loadWorkerProvider(file, '/synthetic/workspace');
  const controller = new AbortController(); const updates = [];
  const result = await provider.execute('user_bash', { command: 'pwd' }, controller.signal, value => updates.push(value));
  assert.deepEqual(result, { workspace: '/synthetic/workspace', name: 'user_bash', parameters: { command: 'pwd' } });
  assert.deepEqual(updates, [{ name: 'user_bash' }]);
  controller.abort();
  await assert.rejects(provider.execute('read', {}, controller.signal, () => {}), /abort/i);
});

test('an invalid or failed host provider never falls back to native tools', async t => {
  const { install } = await fixture(t);
  for (const [name, source] of [
    ['missing', 'export const unused = true;'],
    ['malformed', 'export const createWorkerTools = () => ({ execute: true });'],
    ['broken', 'export function createWorkerTools() { throw new Error("provider unavailable"); }'],
  ]) {
    const file = join(install, name + '.mjs'); await writeFile(file, source);
    await assert.rejects(loadWorkerProvider(file, '/synthetic/workspace'));
  }
});
