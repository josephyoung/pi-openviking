import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as pi from '@earendil-works/pi-coding-agent';

// Acceptance fixture only, never included in the npm package.
export async function createWorkerTools({ workspace }) {
  assert.notEqual(process.getuid(), 0);
  assert.match(await readFile('/proc/self/status', 'utf8'), /^NoNewPrivs:\s+1$/m);
  assert.equal(process.env.MEMORY_SYNTHETIC_KEY, undefined);
  const definitions = [pi.createReadToolDefinition(workspace), pi.createWriteToolDefinition(workspace),
    pi.createEditToolDefinition(workspace), pi.createBashToolDefinition(workspace),
    pi.createGrepToolDefinition(workspace), pi.createFindToolDefinition(workspace), pi.createLsToolDefinition(workspace)];
  const tools = new Map(definitions.map(tool => [tool.name, tool]));
  return {
    async execute(name, parameters, signal, onUpdate) {
      if (name === 'user_bash') return pi.createLocalBashOperations().exec(parameters.command, workspace, {
        signal, timeout: parameters.timeout, onData: data => onUpdate({ data: data.toString('base64') }),
      });
      const value = await tools.get(name).execute('fixture', parameters, signal, onUpdate);
      return { ...value, details: { ...value.details, workerProvider: true } };
    },
  };
}
