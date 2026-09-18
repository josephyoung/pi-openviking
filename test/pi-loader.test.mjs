import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createOpenVikingExtension, FileStateStore, protectedMemoryResources } from '../dist/host.js';
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


test('protected loader rejects workspace packages/extensions across reload while retaining trusted Skills', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  const project = join(cwd, '.pi'), packageDir = join(project, 'untrusted-package');
  const marker = join(root, 'untrusted-code-executed');
  const skill = join(root, 'trusted-skill');
  await mkdir(packageDir, { recursive: true }); await mkdir(agentDir); await mkdir(skill);
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'untrusted-fixture', version: '1.0.0',
    type: 'module', pi: { extensions: ['./index.js'] } }));
  await writeFile(join(packageDir, 'index.js'), `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'executed');
export default function() {}
`);
  await writeFile(join(project, 'settings.json'), JSON.stringify({ packages: ['./untrusted-package'], extensions: ['./untrusted-package/index.js'] }));
  await writeFile(join(skill, 'SKILL.md'), '---\nname: protected-fixture\ndescription: Trusted test skill\n---\nUse this fixture.\n');
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir,
    ...protectedMemoryResources(settings, pi => { pi.on('project_trust', () => ({ trusted: 'no' })); }, [skill]) });
  for (let i = 0; i < 2; i++) {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    assert.equal(settings.isProjectTrusted(), false);
    assert(loader.getSkills().skills.some(item => item.name === 'protected-fixture'));
    await assert.rejects(access(marker), { code: 'ENOENT' });
  }
  // Positive control: the same fixture really is executable if workspace
  // resources are trusted, so a missing/mislocated fixture cannot pass this test.
  const unsafe = new DefaultResourceLoader({ cwd, agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }) });
  await unsafe.reload();
  assert.deepEqual(unsafe.getExtensions().errors, []);
  await access(marker);
});
