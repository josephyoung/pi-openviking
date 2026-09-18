import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerOperationName } from './tool-worker.js';

export interface WorkerToolProvider {
  execute(name: WorkerOperationName, parameters: Record<string, unknown>, signal: AbortSignal,
    onUpdate: (value: unknown) => void): Promise<unknown>;
  close?(): void;
}

/** Administrator-selected installation code, never a workspace/model argument. */
export async function protectedWorkerModule(installationDir: string, modulePath: string): Promise<string> {
  if (!isAbsolute(modulePath)) throw new Error('WORKER_PROVIDER_PATH_INVALID');
  const root = await realpath(installationDir);
  const target = await realpath(modulePath);
  const suffix = relative(root, target);
  if (!suffix || suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)
      || !(await lstat(target)).isFile()) throw new Error('WORKER_PROVIDER_OUTSIDE_INSTALLATION');
  return target;
}

/** Called inside the unprivileged no_new_privs worker, after bootstrap validation. */
export async function loadWorkerProvider(modulePath: string, workspace: string): Promise<WorkerToolProvider> {
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.createWorkerTools !== 'function') throw new Error('INVALID_WORKER_PROVIDER');
  const provider = await module.createWorkerTools({ workspace });
  if (!provider || typeof provider.execute !== 'function'
    || (provider.close !== undefined && typeof provider.close !== 'function')) throw new Error('INVALID_WORKER_PROVIDER');
  return provider;
}
