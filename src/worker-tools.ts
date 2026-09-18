import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition,
  createLsToolDefinition, type ToolDefinition, type ExtensionFactory, type BashOperations,
} from '@earendil-works/pi-coding-agent';
import { resolve } from 'node:path';
import type { NativeToolWorker, NativeToolName } from './tool-worker.js';

type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;
export type IsolatedToolExecutor = Pick<NativeToolWorker, 'workspace' | 'execute' | 'assertIsolated'>;

function toolResult(value: unknown): ToolResult {
  if (!value || typeof value !== 'object') throw new Error('INVALID_WORKER_TOOL_RESULT');
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content) || !content.every(item => item && typeof item === 'object'
    && ((item.type === 'text' && typeof item.text === 'string')
      || (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string')))) {
    throw new Error('INVALID_WORKER_TOOL_RESULT');
  }
  return value as ToolResult;
}

function checkWorkspace(worker: IsolatedToolExecutor, cwd: string): void {
  if (resolve(cwd) !== resolve(worker.workspace)) throw new Error('MEMORY_WORKER_WORKSPACE_MISMATCH');
}

/** Preserve pi schemas, normalization and rendering; replace every execution function. */
export function createIsolatedToolDefinitions(worker: IsolatedToolExecutor): ToolDefinition[] {
  const cwd = worker.workspace;
  const definitions = [createReadToolDefinition(cwd), createWriteToolDefinition(cwd), createEditToolDefinition(cwd),
    createBashToolDefinition(cwd), createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd)] as unknown as ToolDefinition[];
  return definitions.map(definition => ({ ...definition,
    async execute(_callId, parameters, signal, onUpdate, context) {
      checkWorkspace(worker, context.cwd);
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('INVALID_WORKER_TOOL_ARGUMENTS');
      await worker.assertIsolated();
      return toolResult(await worker.execute(definition.name as NativeToolName, parameters as Record<string, unknown>, signal,
        update => onUpdate?.(toolResult(update))));
    },
  }));
}

/** Interactive ! / !! commands must use the same worker as model Bash calls. */
export function createIsolatedBashOperations(worker: IsolatedToolExecutor): BashOperations {
  return {
    async exec(command, cwd, options) {
      checkWorkspace(worker, cwd);
      await worker.assertIsolated();
      // Never copy options.env from the privileged host into the worker.
      const result = await worker.execute('user_bash', { command, timeout: options.timeout }, options.signal, update => {
        if (!update || typeof update !== 'object' || typeof (update as { data?: unknown }).data !== 'string') {
          throw new Error('INVALID_WORKER_SHELL_UPDATE');
        }
        options.onData(Buffer.from((update as { data: string }).data, 'base64'));
      });
      const exitCode = result && typeof result === 'object' ? (result as { exitCode?: unknown }).exitCode : undefined;
      if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error('INVALID_WORKER_SHELL_RESULT');
      return { exitCode: exitCode as number | null };
    },
  };
}

export function createIsolatedToolsExtension(worker: IsolatedToolExecutor): ExtensionFactory {
  const definitions = createIsolatedToolDefinitions(worker);
  const operations = createIsolatedBashOperations(worker);
  return pi => {
    for (const definition of definitions) pi.registerTool(definition);
    pi.on('user_bash', event => {
      checkWorkspace(worker, event.cwd);
      return { operations };
    });
  };
}
