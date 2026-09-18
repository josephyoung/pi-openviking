// Acceptance-only host: consent stays off, so no tokenizer or service call is permitted.
import { FileStateStore, OwnerMemoryClient, MemoryDelivery, DeliveryScheduler } from '../dist/host.js';
export function createHost({ paths, assertToolIsolation }) {
  const owner = { accountId: 'extension-test-cli', userId: 'alice' };
  const stateStore = new FileStateStore({ owner, directory: paths.stateDir, policyVersion: 'test-v1' });
  const client = new OwnerMemoryClient({ owner, baseUrl: 'http://localhost:1', apiKey: 'SYNTHETIC_UNUSED_KEY', timeoutMs: 1000 });
  const policy = { maxPayloadBytes: 4096, recallTimeoutMs: 100, recallTokenBudget: 1000,
    recallLimit: 3, minimumScore: 0.5, countTokens() { throw new Error('Disabled memory must not tokenize'); } };
  const delivery = new MemoryDelivery({ store: stateStore, transport: client, maxPayloadBytes: policy.maxPayloadBytes });
  const scheduler = new DeliveryScheduler({ store: stateStore, delivery, pollIntervalMs: 250,
    initialBackoffMs: 250, maxBackoffMs: 2000, maxAttemptsPerPhase: 4, maxOperationsPerTick: 2 });
  return { memory: { owner, stateStore, client, policy, assertToolIsolation, wakeDelivery: () => scheduler.wake() }, scheduler };
}
