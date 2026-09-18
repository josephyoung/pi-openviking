# pi-openviking

An independent OpenViking memory extension for pi, tracked by
[Dano #465](https://github.com/zhengchengqiaobusiness-arch/Dano/issues/465).

**Implementation in progress. No package release or production activation yet.**
The package name is `@josephyoung/pi-openviking`. Both entry modules compile
against pi 0.82.1. The real pi loader loads both entries and keeps a single
registration after reload; the standard entry fails closed without its launcher binding.
The Linux tool-worker launcher and product integration are still being implemented under [#474](https://github.com/zhengchengqiaobusiness-arch/Dano/issues/474).

## Implemented

- A Linux native-tool IPC worker with distinct UID, explicit environment
  allowlist, kernel identity checks, bounded requests/results, streamed updates
  and cancellation. Bootstrap integration is still required.
- Immutable account/user binding and owner-checked private state files.
- OS advisory locks, atomic replacement, file and directory fsync. The state
  contains delivery/consent metadata and pending payloads, not a second memory
  database. Kernel locks are released when a writer dies; no lease timeout can
  grant a second process permission to repeat a remote mutation.
- Standard and host factory entry modules; the host never reads global credentials.
- Bounded, quoted recall in a non-persisted custom context message, with a host
  tokenizer, per-request cache and pause/lifecycle invalidation.
- Default-off consent, explicit durable enqueue and stable source deduplication.
- A dedicated remote Session per save operation, with persisted causal phases.
  An unknown message/commit outcome is reconciled through public APIs and never
  blindly retransmitted. Missing or expired receipts require reconciliation;
  they do not authorize repeating a non-idempotent call.
- Owner-level background scheduling with durable backoff, startup recovery,
  bounded processing and shutdown. Exhausted reconciliation stays visibly blocked;
  it never turns an unknown remote outcome into an automatic resend.
- Protected resource-loader configuration rejects workspace packages/extensions
  while preserving explicitly supplied trusted Skills. Apply before package
  resolution; `noExtensions` alone is insufficient.
- `ready` requires a completed matching task, an archive containing the source,
  a matching memory diff, current content and a successful retrieval probe.
- Pause suppresses unsent operations and removes their pending bodies. Enabling
  again does not replay those operations or authorize automatic collection.

## Development

Requires Node.js >=22.19, a POSIX system, Python and a C++ compiler for the
`fs-ext` native advisory-lock binding. Install scripts for that audited native
module must run when installing. This first local run used Node 26.8.2; the
release gate must also test the selected Linux/Node deployment combination.

```sh
npm ci
npm test
npm run check
```

`npm test` covers independent processes, killed writers, concurrent processors,
response loss, source conflicts, owner mismatch, consent, recall budgets and
lifecycle behavior (22 tests in the current development run). It does not prove
end-to-end host isolation or UI acceptance.

For a separately provisioned disposable `extension-test-*` account, place an
owner-only JSON file outside the repository with `owner: {accountId, userId}`,
`baseUrl` (server origin) and a USER-level `apiKey`, then run:

```sh
npm run build
node scripts/real-service.mjs /absolute/private/test-run/connection.json
```

This invokes the configured server's extraction models and may incur charges.
The script rejects non-test account names, leaves synthetic data for inspection
and writes a credential-free result alongside the protected connection file.
Do not commit connection files, state, credentials or real user data.

## Security and release boundaries

State permissions alone do not protect credentials from same-UID Agent tools.
The selected memory-enabled profile requires a trusted Linux host and a
separate tool UID, protected installation/state and no executable discovery
from tool-writable paths. That launcher must be integrated and verified before
activating memory in either pi or Dano. Current modules are not a substitute
for that boundary.

Further #474 gates: complete CLI bootstrap and tool routing,
credential isolation, Dano exact-version integration, authenticated settings
and management, ordinary pi and real in-app Browser acceptance. Subsequent
#475–477 work covers full collection/lifecycle/governance and release gates.

## Verified service combination

- OpenViking server: unmodified 0.4.20.
- OpenViking TypeScript SDK: 0.1.0, exact dependency.
- pi: 0.82.1, peer dependency (not bundled).
- Local actual-adapter save: 2026-09-18, synthetic fact reached `ready` and was
  recalled after ~22.8 seconds. Every delivery step recreated the adapter from
  persisted state. This is one functional run, not the PRD performance sample.

See `THIRD_PARTY_NOTICES.md` for distribution responsibilities.

## Executed worker boundary

`scripts/linux-worker.mjs` exercises the actual worker in a disposable root
Linux container, with the three numeric identities supplied as arguments. The
2026-09-18 run used pi 0.82.1 and Node 22.23.2: workspace read/write succeeded;
absolute and symlink read/write/edit against the host-private credential failed;
Bash inherited no synthetic memory key; updates and cancellation worked. The
container used no network and was removed after the run. This verifies the
worker primitive, not the final CLI/Dano launch and resource-discovery profile.

The actual background scheduler also completed a fresh real-service save on
2026-09-18: it reached `ready` after 30.3 seconds and the subsequent query
retrieved the synthetic preference. No viewer or foreground delivery calls
advanced the operation. Reproduce with `scripts/real-scheduler.mjs` and a fresh
disposable account config, using the same private-config rules above.
