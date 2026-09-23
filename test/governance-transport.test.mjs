import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OwnerMemoryClient } from '../dist/host.js';

async function fixture(t, { scope = null, staleWrite = false, staleDelete = false, failedRead = false, taskStatus = 'completed', taskMismatch = false, noTask = false } = {}) {
  const calls = [];
  let content = 'unrelated fact\nold fact', session = true;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local');
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const body = bytes ? JSON.parse(bytes) : undefined;
    calls.push({ path: url.pathname, method: request.method, peer: request.headers['x-openviking-actor-peer'], body,
      uri: url.searchParams.get('uri'), recursive: url.searchParams.get('recursive'), wait: url.searchParams.get('wait') });
    response.setHeader('content-type', 'application/json');
    const reply = result => response.end(JSON.stringify({ status: 'ok', result }));
    const fail = status => { response.statusCode = status; response.end(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', message: 'synthetic' } })); };
    if (url.pathname === '/health') return response.end(JSON.stringify({ auth_mode: 'api_key', role: 'user', account_id: 'test', user_id: 'alice' }));
    if (url.pathname === '/api/v1/sessions' && request.method === 'POST') return reply({ session_id: body.session_id });
    if (url.pathname === '/api/v1/sessions/source-1/messages') return reply({});
    if (url.pathname === '/api/v1/tasks') return reply(noTask ? [] : [{ task_id: 'task-1', task_type: 'session_commit', resource_id: 'source-1' }]);
    if (url.pathname === '/api/v1/tasks/task-1') return reply({ task_id: 'task-1', task_type: 'session_commit',
      resource_id: taskMismatch ? 'foreign-source' : 'source-1', status: taskStatus });
    if (url.pathname === '/api/v1/fs/stat') return content === undefined ? fail(404) : reply({});
    if (url.pathname === '/api/v1/content/write') { if (!staleWrite) content = body.content; return reply({}); }
    if (url.pathname === '/api/v1/content/read') {
      if (failedRead) return fail(403);
      return content === undefined ? fail(404) : reply(content);
    }
    if (url.pathname === '/api/v1/fs') { if (!staleDelete) content = undefined; return reply({}); }
    if (url.pathname === '/api/v1/sessions/source-1') {
      if (request.method === 'DELETE') { if (!staleDelete) session = false; return reply({}); }
      return session ? reply({ session_id: 'source-1' }) : fail(404);
    }
    return fail(404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new OwnerMemoryClient({ owner: { accountId: 'test', userId: 'alice' }, scope,
    apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 2000 });
  return { client, calls, uri: `viking://user/alice/${scope ? `peers/${scope}/` : ''}memories/preferences/fact.md` };
}
const operation = { owner: { accountId: 'test', userId: 'alice' }, scope: null, remoteSessionId: 'source-1' };

test('governance writes use bound identity and trusted peer and verify visible replacement', async t => {
  const { client, calls, uri } = await fixture(t, { scope: 'project-a' });
  await client.replaceMemory(uri, 'unrelated fact\ncorrected fact');
  assert.equal(calls[0].path, '/health');
  assert(calls.slice(1).every(call => call.peer === 'project-a'));
  const write = calls.find(call => call.method === 'POST');
  assert.equal(write.body.mode, 'replace'); assert.equal(write.body.wait, true);
  assert.equal(write.body.uri, uri);
});

test('deletion is non-recursive, waits and proves absent; replay remains idempotent', async t => {
  const { client, calls, uri } = await fixture(t);
  await client.removeMemory(uri); await client.removeMemory(uri);
  const deletions = calls.filter(call => call.method === 'DELETE');
  assert.equal(deletions.length, 2);
  assert(deletions.every(call => call.uri === uri && call.recursive === 'false' && call.wait === 'true'));
  await client.removeSource(operation); await client.removeSource(operation);
});

test('successful HTTP responses with stale content do not acknowledge governance completion', async t => {
  const write = await fixture(t, { staleWrite: true });
  await assert.rejects(write.client.replaceMemory(write.uri, 'replacement'), /REPLACEMENT_UNCONFIRMED/);
  const remove = await fixture(t, { staleDelete: true });
  await assert.rejects(remove.client.removeMemory(remove.uri), /DELETION_UNCONFIRMED/);
  await assert.rejects(remove.client.removeSource(operation), /SOURCE_DELETION_UNCONFIRMED/);
  const failedRead = await fixture(t, { failedRead: true });
  await assert.rejects(failedRead.client.removeMemory(failedRead.uri));
});

test('foreign owner, scope, directories, metadata and ambiguous paths fail before network access', async t => {
  const { client, calls } = await fixture(t, { scope: 'project-a' });
  for (const uri of ['viking://user/alice/memories/fact.md', 'viking://user/bob/peers/project-a/memories/fact.md',
    'viking://user/alice/peers/project-b/memories/fact.md', 'viking://user/alice/peers/project-a/memories',
    'viking://user/alice/peers/project-a/memories/.abstract.md', 'viking://user/alice/peers/project-a/memories/%2e/fact.md',
    'viking://user/alice/peers/project-a/memories/../fact.md', 'viking://user/alice/peers/project-a/memories/preferences']) {
    await assert.rejects(client.removeMemory(uri));
    await assert.rejects(client.replaceMemory(uri, 'replacement'));
  }
  await assert.rejects(client.removeSource(operation), /OWNER_MISMATCH/);
  await assert.rejects(client.removeSource({ ...operation, scope: 'project-a', owner: { accountId: 'test', userId: 'bob' } }), /OWNER_MISMATCH/);
  await assert.rejects(client.removeSource({ ...operation, scope: 'project-a', remoteSessionId: '../foreign' }), /INVALID_MEMORY_REFERENCE/);
  assert.deepEqual(calls, []);
});


test('writer drain uses bound task identity and does not mistake unknown or running results for settled', async t => {
  const running = await fixture(t, { taskStatus: 'running' });
  assert.equal(await running.client.writerSettled({ ...operation, phase: 'commit_unknown' }), false);
  const missing = await fixture(t, { noTask: true });
  assert.equal(await missing.client.writerSettled({ ...operation, phase: 'commit_unknown' }), false);
  assert.equal(await missing.client.writerSettled({ ...operation, phase: 'blocked', errorCode: 'MEMORY_RECONCILIATION_LIMIT' }), false);
  const done = await fixture(t);
  assert.equal(await done.client.writerSettled({ ...operation, phase: 'blocked', errorCode: 'MEMORY_RECONCILIATION_LIMIT', reconciliationPhase: 'commit_unknown' }), true);
  const partial = await fixture(t, { taskStatus: 'failed' });
  assert.equal(await partial.client.writerSettled({ ...operation, phase: 'processing', taskId: 'task-1' }), true);
  const mismatch = await fixture(t, { taskMismatch: true });
  await assert.rejects(mismatch.client.writerSettled({ ...operation, phase: 'processing', taskId: 'task-1' }), /TASK_MISMATCH/);
});

test('whole-scope clear derives its target from the bound project, waits and confirms absence', async t => {
  const { client, calls } = await fixture(t, { scope: 'project-a' });
  await client.clearMemoryScope();
  const removal = calls.find(call => call.method === 'DELETE');
  assert.equal(removal.uri, 'viking://user/alice/peers/project-a/memories');
  assert.equal(removal.recursive, 'true'); assert.equal(removal.wait, 'true');
  assert.equal(removal.peer, 'project-a');
  const stale = await fixture(t, { staleDelete: true });
  await assert.rejects(stale.client.clearMemoryScope(), /CLEAR_UNCONFIRMED/);
});


test('trusted project binds extraction policy and source peer instead of only an access header', async t => {
  const project = await fixture(t, { scope: 'project-a' });
  await project.client.createSession('source-1');
  await project.client.append({ ...operation, scope: 'project-a', id: 'source-id', payload: 'project fact' });
  const created = project.calls.find(call => call.path === '/api/v1/sessions');
  assert.deepEqual(created.body.memory_policy, { self: { enabled: false }, peer: { enabled: true } });
  const appended = project.calls.find(call => call.path.endsWith('/messages'));
  assert.equal(appended.body.peer_id, 'project-a');
  assert.equal(appended.peer, 'project-a');
  const global = await fixture(t);
  await global.client.createSession('source-1');
  await global.client.append({ ...operation, id: 'source-id', payload: 'global fact' });
  assert.equal(global.calls.find(call => call.path.endsWith('/messages')).body.peer_id, undefined);
});
