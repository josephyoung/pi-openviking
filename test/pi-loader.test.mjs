import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createOpenVikingExtension, FileStateStore } from '../dist/host.js';
import { bindStandardHost } from '../dist/standard.js';

test('real pi 0.82.1 loads both published entry files and preserves single registration after reload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  const owner = { accountId: 'test', userId: 'alice' };
  const options = { owner, stateStore: new FileStateStore({ owner, directory: join(root, 'state'), policyVersion: 'v1' }),
    client: { owner, async recall() { throw new Error('No network during registration'); } },
    async assertToolIsolation() { throw new Error('Loader-only test is not an isolated host'); },
    policy: { maxPayloadBytes: 4096, recallTimeoutMs: 100, recallTokenBudget: 500, recallLimit: 3,
      minimumScore: 0.5, countTokens: text => text.length }, wakeDelivery() {} };
  const common = { cwd, agentDir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true };
  bindStandardHost(options);
  for (const loader of [
    new DefaultResourceLoader({ ...common, additionalExtensionPaths: [resolve('dist/standard.js')] }),
    new DefaultResourceLoader({ ...common, extensionFactories: [{ name: 'openviking', factory: createOpenVikingExtension(options) }] }),
  ]) {
    for (let i = 0; i < 2; i++) {
      await loader.reload();
      const result = loader.getExtensions();
      assert.deepEqual(result.errors, []);
      assert.equal(result.extensions.length, 1);
      assert.deepEqual([...result.extensions[0].tools.keys()], ['memory_save']);
      assert(result.extensions[0].handlers.has('context'));
    }
  }
});
