import { lstat, realpath, readdir } from 'node:fs/promises';
import { dirname, relative, isAbsolute } from 'node:path';
import type { Stats } from 'node:fs';
import { NativeToolWorker, type WorkerOptions } from './tool-worker.js';

export interface ProtectedPaths {
  workspace: string;
  agentDir: string;
  stateDir: string;
  installationDir: string;
  hostUid: number;
  workerUid: number;
  workerGid: number;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('../') && path !== '..' && !isAbsolute(path));
}
function permissions(stat: Stats, options: ProtectedPaths): number {
  if (stat.uid === options.workerUid) return (stat.mode >> 6) & 7;
  if (stat.gid === options.workerGid) return (stat.mode >> 3) & 7;
  return stat.mode & 7;
}

async function protectedAncestors(path: string, options: ProtectedPaths, readable: boolean): Promise<void> {
  let current = path;
  let child: Stats | undefined;
  for (;;) {
    const stat = await lstat(current);
    const access = permissions(stat, options);
    // A sticky shared ancestor may be writable, but the worker must own neither
    // it nor the protected child entry. Without sticky semantics, replacement
    // remains possible even when the protected child itself is read-only.
    const stickyProtection = child && (stat.mode & 0o1000) && stat.uid !== options.workerUid && child.uid !== options.workerUid;
    if (stat.uid === options.workerUid || ((access & 2) && !stickyProtection)) throw new Error('WORKER_CAN_REPLACE_PROTECTED_PATH');
    if (readable && (!(access & 1) || (current === path && !(access & 4)))) throw new Error('WORKER_CANNOT_LOAD_INSTALLATION');
    const parent = dirname(current);
    if (parent === current) return;
    child = stat;
    current = parent;
  }
}

async function verifyInstallationTree(root: string, options: ProtectedPaths): Promise<void> {
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length) {
    const path = await realpath(pending.pop()!);
    if (!contains(root, path)) throw new Error('INSTALLATION_LINK_ESCAPES_ROOT');
    if (visited.has(path)) continue;
    visited.add(path);
    const stat = await lstat(path);
    const access = permissions(stat, options);
    if (stat.uid === options.workerUid || (access & 2)) throw new Error('WORKER_CAN_REPLACE_PROTECTED_PATH');
    if (stat.isDirectory()) {
      for (const entry of await readdir(path)) pending.push(`${path}/${entry}`);
    } else if (!stat.isFile()) throw new Error('UNSUPPORTED_INSTALLATION_ENTRY');
  }
}

/** Canonical paths returned here must be used throughout the subsequent bootstrap. */
export async function validateProtectedPaths(options: ProtectedPaths): Promise<ProtectedPaths> {
  if (![options.hostUid, options.workerUid, options.workerGid].every(id => Number.isSafeInteger(id) && id > 0)
      || options.hostUid === options.workerUid) throw new Error('INVALID_MEMORY_IDENTITIES');
  const keys = ['workspace', 'agentDir', 'stateDir', 'installationDir'] as const;
  const paths = { ...options };
  for (const key of keys) {
    if (!isAbsolute(paths[key])) throw new Error('MEMORY_PATH_MUST_BE_ABSOLUTE');
    paths[key] = await realpath(paths[key]);
    if (!(await lstat(paths[key])).isDirectory()) throw new Error('MEMORY_PATH_NOT_DIRECTORY');
  }
  for (const key of ['agentDir', 'stateDir', 'installationDir'] as const) {
    if (contains(paths.workspace, paths[key]) || contains(paths[key], paths.workspace)) throw new Error('MEMORY_WORKSPACE_OVERLAP');
    await protectedAncestors(paths[key], paths, key === 'installationDir');
  }
  for (const key of ['agentDir', 'stateDir'] as const) {
    if (contains(paths.installationDir, paths[key]) || contains(paths[key], paths.installationDir)) throw new Error('MEMORY_INSTALLATION_STATE_OVERLAP');
    const stat = await lstat(paths[key]);
    if (stat.uid !== paths.hostUid || (stat.mode & 0o077) !== 0) throw new Error('MEMORY_PRIVATE_DIRECTORY_REQUIRED');
  }
  if ((permissions(await lstat(paths.workspace), paths) & 7) !== 7) throw new Error('WORKER_CANNOT_USE_WORKSPACE');
  await verifyInstallationTree(paths.installationDir, paths);
  return paths;
}

/** Single-host CLI bootstrap. Multi-user hosts must provision each worker explicitly. */
export async function bootstrapProtectedWorker(options: ProtectedPaths & Omit<WorkerOptions,
  'workspace' | 'hostUid' | 'workerUid' | 'workerGid'> & { hostGid: number }): Promise<{ worker: NativeToolWorker; paths: ProtectedPaths; piPackageContext: string }> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0
      || !Number.isSafeInteger(options.hostGid) || options.hostGid <= 0) throw new Error('PRIVILEGED_LINUX_BOOTSTRAP_REQUIRED');
  const paths = await validateProtectedPaths(options);
  const piPackageContext = await realpath(options.piPackageContext);
  if (!contains(paths.installationDir, piPackageContext) || !(await lstat(piPackageContext)).isFile()) {
    throw new Error('PI_CONTEXT_OUTSIDE_PROTECTED_INSTALLATION');
  }
  const privilegeGuard = await realpath(options.privilegeGuard);
  await protectedAncestors(privilegeGuard, paths, true);
  await protectedAncestors(await realpath(process.execPath), paths, true);
  const worker = new NativeToolWorker({ ...options, ...paths, piPackageContext, privilegeGuard });
  try {
    process.setgid!(options.hostGid);
    process.setuid!(paths.hostUid);
    await worker.assertIsolated();
    return { worker, paths, piPackageContext };
  } catch (error) { worker.close(); throw error; }
}
