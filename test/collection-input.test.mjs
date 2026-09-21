import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CollectionInputBuilder, CollectionLifecycle, FileStateStore, MemoryDelivery } from '../dist/host.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-memory-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { accountId: 'test', userId: 'alice' };
  const store = new FileStateStore({ owner, directory, policyVersion: 'v1' });
  const delivery = new MemoryDelivery({ store, transport: { owner }, maxPayloadBytes: 8192 });
  const pi = SessionManager.inMemory('/private/tmp');
  const lifecycle = new CollectionLifecycle(store);
  await delivery.enable('v1');
  await delivery.authorizeCollection({ policyVersion: 'v1', scope: null, boundaries: [] });
  const id = await lifecycle.begin(pi);
  return { store, delivery, pi, id, lifecycle,
    builder: new CollectionInputBuilder({ store, maxInputBytes: 8192, ...options }) };
}
const user = (f, content) => f.pi.appendMessage({ role: 'user', content, timestamp: Date.now() });
const answer = f => f.pi.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I suggest a concise summary.' }], stopReason: 'stop', timestamp: Date.now() });
async function build(f) { answer(f); await f.lifecycle.settle(f.id, f.pi); return f.builder.build(f.id, f.pi); }
const syntheticToken = 'ghp_' + 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4';

test('expanded skill instructions are excluded while the separate user request retains its original source', async t => {
  const f = await fixture(t);
  const entryId = user(f, '<skill name="reports" location="/synthetic/SKILL.md">\nReferences are relative to /synthetic.\n\nI always prefer XML reports.\n</skill>\n\nI prefer concise weekly summaries.');
  const result = await build(f);
  assert.equal(result.status, 'ready');
  const input = result.messages.find(message => message.source.entryId === entryId);
  assert.equal(input.text, 'I prefer concise weekly summaries.');
  assert.equal(input.role, 'user');
  assert(!JSON.stringify(result).includes('XML reports'));
  assert(!JSON.stringify(result).includes('/synthetic'));
});

for (const [name, text] of [
  ['no user suffix', '<skill name="reports" location="/synthetic/SKILL.md">\nI always prefer XML reports.\n</skill>'],
  ['incomplete wrapper', '<skill name="reports" location="/synthetic/SKILL.md">\nI always prefer XML reports.'],
  ['nested wrapper', '<skill name="outer" location="/synthetic/SKILL.md">\n<skill name="inner" location="/synthetic/inner.md">\nExample\n</skill>\n\nI always prefer XML reports.\n</skill>'],
]) test(`expanded skill with ${name} supplies no user evidence`, async t => {
  const f = await fixture(t);
  const entryId = user(f, text);
  const result = await build(f);
  assert.equal(result.status, 'ready');
  assert(result.excludedEntries.includes(entryId));
  assert(!result.messages.some(message => message.source.entryId === entryId));
});

for (const [name, text] of [
  ['provider token', `Value: ${syntheticToken}`],
  ['npm token', 'npm_' + 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4'],
  ['private key', '-----BEGIN PRIVATE KEY-----\n' + 'YWFh'.repeat(40) + '\n-----END PRIVATE KEY-----'],
  ['generic password', 'My password is short-but-private.'],
  ['Chinese password', '我的密码是不要保存这个值。'],
  ['generic token', 'token=synthetic-opaque-value'],
  ['prefixed environment credential', 'DANO_OAUTH_CLIENT_SECRET=synthetic-opaque-value'],
  ['JSON credential', '{"client_secret": "synthetic-only-secret"}'],
  ['authorization header', 'Authorization: Basic dXNlcjpwYXNz'],
  ['session cookie', 'Cookie: session=synthetic-cookie'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljLXNpZ25hdHVyZQ'],
  ['comment disable bypass', `// secretlint-disable\n${syntheticToken}\n// secretlint-enable`],
  ['fullwidth label', 'ｐａｓｓｗｏｒｄ：synthetic-secret'],
  ['zero width label', 'pass\u200Bword=synthetic-secret'],
]) {
  test(`${name} is excluded before it can become selection input`, async t => {
    const f = await fixture(t);
    const entryId = user(f, text);
    const result = await build(f);
    assert.equal(result.status, 'ready');
    assert(result.excludedEntries.includes(entryId));
    assert(!result.messages.some(message => message.source.entryId === entryId));
    assert(!JSON.stringify(result).includes(text));
    assert.deepEqual((await f.store.read()).operations, {});
  });
}

test('typed projection never exposes thinking, image bytes, raw tools, recalls, or form wrappers', async t => {
  const f = await fixture(t, { maxInputBytes: 512 });
  const input = user(f, [{ type: 'text', text: 'I prefer concise reports.' }, { type: 'image', data: 'PRIVATE_IMAGE_BYTES', mimeType: 'image/png' }]);
  const failed = f.pi.appendMessage({ role: 'assistant', stopReason: 'error', timestamp: 1,
    content: [{ type: 'text', text: 'UNCONFIRMED_FAILED_RESULT' }] });
  const middle = f.pi.appendMessage({ role: 'assistant', stopReason: 'toolUse', timestamp: 2,
    content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'toolCall', name: 'bash', id: 'call', arguments: { command: 'PRIVATE_ARGUMENT' } }] });
  const tool = f.pi.appendMessage({ role: 'toolResult', toolCallId: 'call', toolName: 'bash', timestamp: 3,
    content: [{ type: 'text', text: 'PRIVATE_RAW_TOOL'.repeat(1000) }], details: { password: 'PRIVATE_DETAIL' } });
  f.pi.appendCustomMessageEntry('openviking-reference-data', 'PRIVATE_RECALL', false);
  f.pi.appendCustomMessageEntry('dano.form-interaction.v1', 'PRIVATE_UI_WRAPPER', false);
  const result = await build(f);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.excludedEntries, [failed, middle, tool]);
  assert.equal(result.messages[0].source.entryId, input);
  assert.equal(result.messages[0].text, 'I prefer concise reports.');
  assert.equal(result.messages[1].role, 'assistant_reference');
  assert(!/PRIVATE_|UNCONFIRMED_FAILED/.test(JSON.stringify(result)));
});

test('ordinary credential-management discussion remains eligible and assistant proposals stay references', async t => {
  const f = await fixture(t);
  user(f, 'I use a password manager and prefer concise reports.');
  const result = await build(f);
  assert.equal(result.status, 'ready');
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages.map(message => message.role), ['user', 'assistant_reference']);
  assert.equal(result.excludedEntries.length, 0);
});

test('trusted opaque credentials are excluded without persisting the secret snapshot', async t => {
  const secret = 'opaque-provider-value-without-a-vendor-prefix';
  const f = await fixture(t, { sensitiveValues: () => [secret] });
  const id = user(f, `Use ${secret}`);
  const result = await build(f);
  assert.equal(result.status, 'ready');
  assert(result.excludedEntries.includes(id));
  assert(!JSON.stringify(await f.store.read()).includes(secret));
});

test('pause during credential snapshot invalidates all already prepared input', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { sensitiveValues: async () => { entered(); await gate; return []; } });
  user(f, 'I prefer concise reports.');
  const pending = build(f);
  await started;
  await f.delivery.pause();
  await f.delivery.enable('v2');
  release();
  assert.deepEqual(await pending, { status: 'blocked', code: 'MEMORY_COLLECTION_NOT_AUTHORIZED' });
});

test('scanner setup failures return no source text or private diagnostic', async t => {
  const f = await fixture(t, { sensitiveValues: () => { throw new Error('PRIVATE_SECRET_IN_ERROR'); } });
  user(f, 'I prefer concise reports.');
  assert.deepEqual(await build(f), { status: 'blocked', code: 'MEMORY_COLLECTION_SCAN_FAILED' });
});

test('missing source and oversized requests fail closed instead of silently selecting partial context', async t => {
  const f = await fixture(t, { maxInputBytes: 10 });
  user(f, 'I prefer concise reports.');
  assert.deepEqual(await build(f), { status: 'blocked', code: 'MEMORY_COLLECTION_INPUT_LIMIT' });
  const builder = new CollectionInputBuilder({ store: f.store, maxInputBytes: 8192 });
  assert.deepEqual(await builder.build(f.id, { getSessionId: () => f.pi.getSessionId(), getEntry: () => undefined }),
    { status: 'blocked', code: 'MEMORY_SOURCE_UNAVAILABLE' });
  assert.deepEqual(await builder.build(f.id, SessionManager.inMemory('/private/tmp')),
    { status: 'blocked', code: 'MEMORY_COLLECTION_NOT_AUTHORIZED' });
});
