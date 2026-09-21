// Real-service acceptance host. All configuration comes from protected files.
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileStateStore, OwnerMemoryClient, MemoryDelivery, DeliveryScheduler, CollectionSessionRegistry, CollectionFactSelector, CollectionScheduler } from '../dist/host.js';
export async function createHost({ paths, assertToolIsolation }) {
  const config = JSON.parse(await readFile(join(paths.agentDir, 'memory-connection.json'), 'utf8'));
  if (!config.owner.accountId.startsWith('extension-test-')) throw new Error('DISPOSABLE_ACCOUNT_REQUIRED');
  const tokenizerRoot = join(paths.installationDir, 'tokenizer');
  const { Tokenizer } = await import(pathToFileURL(join(tokenizerRoot, 'node_modules/@huggingface/tokenizers/dist/tokenizers.mjs')).href);
  const tokenizer = new Tokenizer(JSON.parse(await readFile(join(tokenizerRoot, 'tokenizer.json'))),
    JSON.parse(await readFile(join(tokenizerRoot, 'tokenizer_config.json'))));
  const stateStore = new FileStateStore({ owner: config.owner, directory: paths.stateDir, policyVersion: 'acceptance-v1' });
  const client = new OwnerMemoryClient({ ...config, timeoutMs: 15000 });
  const policy = { maxPayloadBytes: 8192, recallTimeoutMs: 5000, recallTokenBudget: 1000,
    recallLimit: 5, minimumScore: 0.1, countTokens: text => tokenizer.encode(text, { add_special_tokens: false }).ids.length };
  const delivery = new MemoryDelivery({ store: stateStore, transport: client, maxPayloadBytes: policy.maxPayloadBytes });
  const scheduler = new DeliveryScheduler({ store: stateStore, delivery, pollIntervalMs: 500,
    initialBackoffMs: 500, maxBackoffMs: 5000, maxAttemptsPerPhase: 90, maxOperationsPerTick: 5 });
  let collection, collectionScheduler;
  if (config.collection) {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const configured = config.collection;
    const runtime = await ModelRuntime.create({ authPath: join(paths.agentDir, 'auth.json'),
      modelsPath: join(paths.agentDir, 'models.json'), refreshOnCreate: false });
    const model = runtime.getModel(configured.model.provider, configured.model.id);
    if (!model) throw new Error('COLLECTION_MODEL_UNAVAILABLE');
    await mkdir(join(paths.agentDir, 'sessions'), { recursive: true, mode: 0o700 });
    const sessions = new CollectionSessionRegistry({ store: stateStore, sessionRoot: join(paths.agentDir, 'sessions') });
    const selector = new CollectionFactSelector({ ...configured.selector, store: stateStore,
      sensitiveValues: async signal => [config.apiKey, (await runtime.getAuth(model, { signal }))?.apiKey].filter(value => typeof value === 'string' && value.length),
      async complete({ systemPrompt, data, signal }) {
        await assertToolIsolation(); signal.throwIfAborted();
        const answer = await runtime.completeSimple(model, { systemPrompt,
          messages: [{ role: 'user', content: data, timestamp: Date.now() }] },
          { signal, maxTokens: configured.model.maxTokens, temperature: configured.model.temperature,
            onPayload: payload => ({ ...payload, ...configured.model.payload }) });
        if (answer.stopReason !== 'stop') throw new Error('MEMORY_SELECTION_FAILED');
        return answer.content.filter(block => block.type === 'text').map(block => block.text).join('');
      } });
    collectionScheduler = new CollectionScheduler({ ...configured.scheduler, store: stateStore, delivery, selector,
      resolveSession: (id, signal) => sessions.resolveSession(id, signal), wakeDelivery: () => scheduler.wake() });
    collection = { sessions, lifecycleTimeoutMs: configured.lifecycleTimeoutMs, wake: () => collectionScheduler.wake(), onError: code => console.error(code) };
  }
  return { memory: { owner: config.owner, stateStore, client, policy, collection, assertToolIsolation,
    wakeDelivery: () => scheduler.wake() }, scheduler, collectionScheduler };
}
