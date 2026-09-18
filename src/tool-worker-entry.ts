// Internal executable. Its arguments come only from the trusted bootstrap.
import { pathToFileURL } from 'node:url';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { loadWorkerProvider } from './worker-provider.js';
import type { WorkerOperationName } from './tool-worker.js';
const [workspace, piEntry, limitText, providerModule] = process.argv.slice(2);
const maxResultBytes = Number(limitText);
if (!process.send || process.getuid?.() === 0 || !workspace || !piEntry || !Number.isSafeInteger(maxResultBytes)) {
  throw new Error('INVALID_TOOL_WORKER_START');
}
const pi = await import(pathToFileURL(piEntry).href) as typeof import('@earendil-works/pi-coding-agent');
const definitions = [pi.createReadToolDefinition(workspace), pi.createWriteToolDefinition(workspace),
  pi.createEditToolDefinition(workspace), pi.createBashToolDefinition(workspace), pi.createGrepToolDefinition(workspace),
  pi.createFindToolDefinition(workspace), pi.createLsToolDefinition(workspace)] as unknown as ToolDefinition[];
const tools = new Map(definitions.map(tool => [tool.name, tool]));
const provider = providerModule ? await loadWorkerProvider(providerModule, workspace) : undefined;
const running = new Map<string, AbortController>();
const send = (value: unknown) => { if (process.connected) process.send!(value, () => {}); };
process.on('disconnect', () => { for (const controller of running.values()) controller.abort(); provider?.close?.(); process.exit(0); });
process.on('message', async message => {
  if (!message || typeof message !== 'object') return;
  const request = message as Record<string, unknown>;
  if (request.type === 'shutdown') {
    for (const controller of running.values()) controller.abort();
    process.disconnect?.();
    return;
  }
  if (typeof request.id !== 'string') return;
  const id = request.id;
  if (request.type === 'cancel') { running.get(id)?.abort(); return; }
  if (request.type !== 'execute' || typeof request.name !== 'string' || !request.parameters
      || typeof request.parameters !== 'object' || Array.isArray(request.parameters) || running.has(id)) return;
  const tool = tools.get(request.name);
  if (!tool && request.name !== 'user_bash') { send({ type: 'error', id }); return; }
  const controller = new AbortController();
  running.set(id, controller);
  try {
    if (provider) {
      const value = await provider.execute(request.name as WorkerOperationName,
        request.parameters as Record<string, unknown>, controller.signal, value => {
          const update = { type: 'update', id, value };
          if (Buffer.byteLength(JSON.stringify(update)) <= maxResultBytes) send(update);
        });
      const result = { type: 'result', id, value };
      if (Buffer.byteLength(JSON.stringify(result)) > maxResultBytes) send({ type: 'error', id });
      else send(result);
      return;
    }
    // Native definitions do not consume extension context. No host callback,
    // credentials, mutable environment or arbitrary function crosses this IPC.
    if (request.name === 'user_bash') {
      const parameters = request.parameters as Record<string, unknown>;
      if (typeof parameters.command !== 'string') throw new Error('INVALID_SHELL_COMMAND');
      const value = await pi.createLocalBashOperations().exec(parameters.command, workspace, {
        signal: controller.signal,
        timeout: typeof parameters.timeout === 'number' ? parameters.timeout : undefined,
        onData(data) {
          const value = { data: data.toString('base64') };
          const update = { type: 'update', id, value };
          if (Buffer.byteLength(JSON.stringify(update)) <= maxResultBytes) send(update);
        },
      });
      send({ type: 'result', id, value });
      return;
    }
    const value = await tool!.execute(id, request.parameters as Record<string, unknown>, controller.signal, update => {
        const result = { type: 'update', id, value: update };
        if (Buffer.byteLength(JSON.stringify(result)) <= maxResultBytes) send(result);
      }, undefined as never);
    const result = { type: 'result', id, value };
    if (Buffer.byteLength(JSON.stringify(result)) > maxResultBytes) send({ type: 'error', id });
    else send(result);
  } catch { send({ type: 'error', id }); }
  finally { running.delete(id); }
});
send({ type: 'ready', uid: process.getuid?.(), gid: process.getgid?.() });
