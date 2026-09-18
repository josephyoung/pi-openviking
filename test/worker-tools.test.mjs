import test from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedToolDefinitions, createIsolatedBashOperations, createIsolatedToolsExtension } from '../dist/worker-tools.js';

function fixture() {
  const calls = [];
  const worker = { workspace: '/tmp/synthetic-workspace', async assertIsolated() {},
    async execute(name, parameters, signal, onUpdate) {
      calls.push({ name, parameters, signal });
      if (name === 'user_bash') { onUpdate?.({ data: Buffer.from('worker shell output').toString('base64') }); return { exitCode: 7 }; }
      onUpdate?.({ content: [{ type: 'text', text: 'worker progress' }], details: {} });
      return { content: [{ type: 'text', text: 'worker result' }], details: {} };
    } };
  return { worker, calls };
}

test('every native definition routes execution and updates to the worker', async () => {
  const { worker, calls } = fixture();
  const definitions = createIsolatedToolDefinitions(worker);
  assert.deepEqual(definitions.map(tool => tool.name), ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);
  const controller = new AbortController();
  for (const tool of definitions) {
    let updates = 0;
    const parameters = { path: '/host/private/credential', command: 'env', content: 'must not be written by host' };
    const result = await tool.execute('call', parameters, controller.signal, () => { updates++; }, { cwd: worker.workspace });
    assert.equal(result.content[0].text, 'worker result');
    assert.equal(updates, 1);
    assert.equal(calls.at(-1).name, tool.name);
    assert.deepEqual(calls.at(-1).parameters, parameters);
    assert.equal(calls.at(-1).signal, controller.signal);
  }
});

test('interactive shell uses the worker without copying host environment', async () => {
  const { worker, calls } = fixture();
  let output = '';
  const operations = createIsolatedBashOperations(worker);
  const result = await operations.exec('echo hello', worker.workspace, {
    env: { SYNTHETIC_HOST_SECRET: 'not-for-worker' }, onData: data => { output += data; } });
  assert.equal(result.exitCode, 7);
  assert.equal(output, 'worker shell output');
  assert.equal(calls[0].name, 'user_bash');
  assert.equal('env' in calls[0].parameters, false);
});

test('wrong workspace and unavailable isolation never fall back to host execution', async () => {
  const { worker, calls } = fixture();
  const tools = createIsolatedToolDefinitions(worker);
  await assert.rejects(tools[0].execute('call', { path: 'file' }, undefined, undefined, { cwd: '/other-user' }), /WORKSPACE_MISMATCH/);
  worker.assertIsolated = async () => { throw new Error('WORKER_UNAVAILABLE'); };
  await assert.rejects(tools[0].execute('call', { path: 'file' }, undefined, undefined, { cwd: worker.workspace }), /WORKER_UNAVAILABLE/);
  assert.equal(calls.length, 0);
});

test('malformed worker results are rejected and the extension covers interactive shell', async () => {
  const { worker } = fixture();
  worker.execute = async () => ({ content: [{ type: 'script', value: 'invalid' }] });
  const tools = createIsolatedToolDefinitions(worker);
  await assert.rejects(tools[0].execute('call', {}, undefined, undefined, { cwd: worker.workspace }), /INVALID_WORKER_TOOL_RESULT/);
  const registered = [], handlers = new Map();
  createIsolatedToolsExtension(worker)({ registerTool: tool => registered.push(tool.name), on: (name, handler) => handlers.set(name, handler) });
  assert.equal(registered.length, 7);
  assert(handlers.get('user_bash')({ cwd: worker.workspace }).operations);
  assert.throws(() => handlers.get('user_bash')({ cwd: '/other-user' }), /WORKSPACE_MISMATCH/);
});
