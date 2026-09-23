import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OwnerMemoryClient } from '../dist/host.js';

async function fixture(t, identity) {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') response.end(JSON.stringify(identity));
    else response.end(JSON.stringify({ status: 'ok', result: 'saved memory' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new OwnerMemoryClient({ owner: { accountId: 'test', userId: 'alice' },
    apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
  return { client, paths };
}

test('USER credential identity is verified before first data access', async t => {
  const { client, paths } = await fixture(t, { auth_mode: 'api_key', role: 'user', account_id: 'test', user_id: 'alice' });
  assert.equal(await client.readMemory('viking://user/alice/memories/fact.md'), 'saved memory');
  assert.equal(paths[0], '/health');
  assert.equal(paths.length, 2);
});

test('wrong owner, administrator keys and missing identity fail before data mutation', async t => {
  for (const identity of [
    { auth_mode: 'api_key', role: 'user', account_id: 'test', user_id: 'bob' },
    { auth_mode: 'api_key', role: 'admin', account_id: 'test', user_id: 'alice' },
    { status: 'ok', healthy: true },
  ]) {
    const { client, paths } = await fixture(t, identity);
    await assert.rejects(client.createSession('synthetic-session'), /CREDENTIAL_OWNER_MISMATCH/);
    assert.deepEqual(paths, ['/health']);
  }
});

test('foreign and ambiguous memory references are rejected locally', async t => {
  const { client, paths } = await fixture(t, {});
  for (const uri of ['viking://user/bob/memories/fact.md', 'viking://user/alice/memories/../credential',
    'viking://user/alice/memories/%2e%2e/credential', 'viking://user/alice/peers/other/memories/fact.md']) {
    await assert.rejects(client.readMemory(uri), /MEMORY_(REFERENCE|SCOPE)/);
  }
  assert.deepEqual(paths, []);
});

test('bounded export read rejects a body larger than stale stat before JSON decode', async t => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ auth_mode: 'api_key', role: 'user', account_id: 'test', user_id: 'alice' }));
    } else if (request.url.startsWith('/api/v1/content/read?')) {
      response.write('{"status":"ok","result":"');
      response.write('x'.repeat(20000));
      response.end('"}');
    } else response.end(JSON.stringify({ status: 'ok', result: { uri: 'viking://user/alice/memories/fact.md', is_dir: false, size: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new OwnerMemoryClient({ owner: { accountId: 'test', userId: 'alice' },
    apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
  await assert.rejects(client.readMemoryLimited('viking://user/alice/memories/fact.md', 100), /MEMORY_EXPORT_TOO_LARGE/);
});
