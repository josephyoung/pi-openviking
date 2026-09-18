import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const nativeToolNames = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'] as const;
export type NativeToolName = typeof nativeToolNames[number];

export interface WorkerOptions {
  workspace: string;
  /** Protected installation's package.json; never supplied by the model. */
  piPackageContext: string;
  workerUid: number;
  workerGid: number;
  hostUid: number;
  path: string;
  startupTimeoutMs: number;
  operationTimeoutMs: number;
  maxConcurrentOperations: number;
  maxResultBytes: number;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
  onUpdate?(value: unknown): void;
}

/** Bootstrap while privileged; drop host privileges before enabling memory. */
export class NativeToolWorker {
  readonly #child: ChildProcess;
  readonly #options: WorkerOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #ready: Promise<void>;
  #closed = false;

  constructor(options: WorkerOptions) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0
        || ![options.workerUid, options.workerGid, options.hostUid].every(id => Number.isSafeInteger(id) && id > 0)
        || options.workerUid === options.hostUid
        || ![options.startupTimeoutMs, options.operationTimeoutMs, options.maxConcurrentOperations, options.maxResultBytes]
          .every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('INVALID_MEMORY_WORKER_PROFILE');
    }
    this.#options = { ...options };
    // pi publishes an import-only export; CommonJS require.resolve cannot
    // select it. Resolve the fixed peer's declared public ESM entry explicitly.
    const piRoot = join(dirname(options.piPackageContext), 'node_modules/@earendil-works/pi-coding-agent');
    const manifest = JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8'));
    const entry = manifest.exports?.['.']?.import;
    if (manifest.version !== '0.82.1' || typeof entry !== 'string' || !entry.startsWith('./')) {
      throw new Error('UNSUPPORTED_MEMORY_WORKER_PI');
    }
    const piEntry = resolve(piRoot, entry);
    // Clear supplementary bootstrap groups before creating the worker. The
    // eventual host also retains no supplementary groups from root startup.
    process.setgroups!([]);
    this.#child = spawn(process.execPath, [fileURLToPath(new URL('./tool-worker-entry.js', import.meta.url)),
      options.workspace, piEntry, String(options.maxResultBytes)], {
      cwd: options.workspace, uid: options.workerUid, gid: options.workerGid,
      env: { PATH: options.path, HOME: options.workspace, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.#ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('MEMORY_WORKER_START_TIMEOUT')); }, options.startupTimeoutMs);
      const failed = () => { clearTimeout(timer); reject(new Error('MEMORY_WORKER_UNAVAILABLE')); };
      this.#child.once('error', failed);
      this.#child.once('exit', failed);
      this.#child.on('message', message => {
        if (!message || typeof message !== 'object') return;
        const result = message as Record<string, unknown>;
        if (result.type === 'ready') {
          if (result.uid !== options.workerUid || result.gid !== options.workerGid) {
            this.close(); failed(); return;
          }
          clearTimeout(timer);
          resolve();
          return;
        }
        if (typeof result.id !== 'string') return;
        const pending = this.#pending.get(result.id);
        if (!pending) return;
        if (result.type === 'update') {
          if (Buffer.byteLength(JSON.stringify(result)) <= options.maxResultBytes) pending.onUpdate?.(result.value);
          return;
        }
        this.#pending.delete(result.id);
        pending.cleanup();
        if (Buffer.byteLength(JSON.stringify(result)) > options.maxResultBytes) pending.reject(new Error('MEMORY_WORKER_RESULT_LIMIT'));
        else if (result.type === 'result') pending.resolve(result.value);
        else pending.reject(new Error('MEMORY_WORKER_TOOL_FAILED'));
      });
    });
    // A bootstrap caller may still be preparing the host before awaiting ready.
    void this.#ready.catch(() => {});
    const disconnected = () => {
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        pending.cleanup();
        pending.reject(new Error('MEMORY_WORKER_UNAVAILABLE'));
      }
      this.#pending.clear();
    };
    this.#child.once('exit', disconnected);
    this.#child.once('error', disconnected);
    this.#child.once('disconnect', disconnected);
  }

  async assertIsolated(): Promise<void> {
    await this.#ready;
    if (this.#closed || !this.#child.connected || process.getuid?.() !== this.#options.hostUid) {
      throw new Error('MEMORY_WORKER_UNAVAILABLE');
    }
    // Independently inspect kernel identity, not a self-reported config flag.
    const status = await readFile(`/proc/${this.#child.pid}/status`, 'utf8');
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
    if (!uids || uids.slice(1).some(uid => Number(uid) !== this.#options.workerUid)) throw new Error('MEMORY_WORKER_IDENTITY_MISMATCH');
  }

  async execute(name: NativeToolName, parameters: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (value: unknown) => void): Promise<unknown> {
    await this.assertIsolated();
    if (!nativeToolNames.includes(name) || this.#pending.size >= this.#options.maxConcurrentOperations) {
      throw new Error('MEMORY_WORKER_REQUEST_LIMIT');
    }
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (this.#child.connected) this.#child.send({ type: 'cancel', id }, () => {});
        reject(new Error('MEMORY_WORKER_CANCELLED'));
      };
      const timer = setTimeout(cancel, this.#options.operationTimeoutMs);
      this.#pending.set(id, { resolve, reject, onUpdate, cleanup: () => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      } });
      signal?.addEventListener('abort', cancel, { once: true });
      this.#child.send({ type: 'execute', id, name, parameters }, error => {
        if (!error) return;
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.cleanup();
        pending?.reject(new Error('MEMORY_WORKER_UNAVAILABLE'));
      });
    });
  }

  close(): void {
    if (this.#child.connected) this.#child.send({ type: 'shutdown' }, () => {});
    this.#closed = true;
  }
}
