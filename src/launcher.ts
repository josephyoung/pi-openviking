import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapProtectedWorker } from './bootstrap.js';
import type { MemoryExtensionOptions } from './host.js';
import type { DeliveryScheduler } from './scheduler.js';
import type { CollectionScheduler } from './collection-scheduler.js';

export type BootstrapOptions = Parameters<typeof bootstrapProtectedWorker>[0];
export interface LauncherProfile extends BootstrapOptions {
  /** Installed, trusted ESM module. Loaded only after dropping root privileges. */
  hostModule: string;
  shutdownTimeoutMs: number;
  trustedSkillPaths?: string[];
}
export interface StandardHost {
  memory: MemoryExtensionOptions;
  scheduler: DeliveryScheduler;
  collectionScheduler?: CollectionScheduler;
}

/** The launcher is a chat entry, not a package/configuration administration shell. */
export function protectedPiArguments(args: readonly string[]): string[] {
  const forbidden = /^(?:--(?:extension|approve|skill|prompt-template|theme|session-dir|export)|-[eak])(?:=|$)/;
  if (args.some(arg => forbidden.test(arg)) || ['install', 'remove', 'update', 'list', 'config'].includes(args[0] ?? '')) {
    throw new Error('UNTRUSTED_PI_LAUNCH_ARGUMENT');
  }
  // Put enforced flags before --, if present, so they cannot become prompt text.
  return ['--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-builtin-tools', ...args];
}

export async function runProtectedPi(profile: LauncherProfile, args: readonly string[]): Promise<void> {
  const cliArgs = protectedPiArguments(args);
  if (!Number.isSafeInteger(profile.shutdownTimeoutMs) || profile.shutdownTimeoutMs < 0) throw new Error('INVALID_MEMORY_SHUTDOWN_TIMEOUT');
  const installation = await realpath(profile.installationDir);
  const hostModule = await realpath(profile.hostModule);
  const moduleRelative = relative(installation, hostModule);
  if (!moduleRelative || moduleRelative === '..' || moduleRelative.startsWith('../') || isAbsolute(moduleRelative)) {
    throw new Error('HOST_MODULE_OUTSIDE_PROTECTED_INSTALLATION');
  }
  const trustedSkills: string[] = [];
  for (const skill of profile.trustedSkillPaths ?? []) {
    const canonical = await realpath(skill);
    const path = relative(installation, canonical);
    if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error('SKILL_OUTSIDE_PROTECTED_INSTALLATION');
    trustedSkills.push('--skill', canonical);
  }
  cliArgs.unshift(...trustedSkills);
  const { worker, paths, piPackageContext } = await bootstrapProtectedWorker(profile);
  let host: StandardHost | undefined;
  try {
    process.chdir(paths.workspace);
    process.env.PI_CODING_AGENT_DIR = paths.agentDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = resolve(paths.agentDir, 'sessions');
    const module = await import(pathToFileURL(hostModule).href);
    if (typeof module.createHost !== 'function') throw new Error('INVALID_MEMORY_HOST_MODULE');
    host = await module.createHost({ paths, assertToolIsolation: () => worker.assertIsolated() });
    if (!host?.memory || !host.scheduler) throw new Error('INVALID_MEMORY_HOST_MODULE');
    const { bindStandardHost, default: standard } = await import('./standard.js');
    bindStandardHost(host.memory, worker);
    host.scheduler.start();
    host.collectionScheduler?.start();
    // Resolve the same peer installation as the worker. No private pi imports.
    const { readFile } = await import('node:fs/promises');
    const piRoot = resolve(dirname(piPackageContext), 'node_modules/@earendil-works/pi-coding-agent');
    const manifest = JSON.parse(await readFile(resolve(piRoot, 'package.json'), 'utf8'));
    const pi = await import(pathToFileURL(resolve(piRoot, manifest.exports['.'].import)).href);
    await pi.main(cliArgs, { extensionFactories: [{ name: 'openviking', factory: standard }] });
  } finally {
    try {
      try { await host?.collectionScheduler?.stop(); }
      finally {
        if (host && !await host.scheduler.stop(profile.shutdownTimeoutMs)) {
          throw new Error('MEMORY_SHUTDOWN_INCOMPLETE');
        }
      }
    } finally { worker.close(); }
  }
}
