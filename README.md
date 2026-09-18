# pi-openviking

An independent OpenViking memory extension for pi, tracked by
[Dano #465](https://github.com/zhengchengqiaobusiness-arch/Dano/issues/465).

**Implementation in progress. No package release or production activation yet.**
The package name is `@josephyoung/pi-openviking`. Both entry modules compile
against pi 0.85.1. The real pi loader loads both entries and keeps a single
registration after reload; the standard entry fails closed without its launcher binding.
The Linux CLI now runs through the public pi entry; memory-enabled CLI acceptance and product integration continue under [#474](https://github.com/zhengchengqiaobusiness-arch/Dano/issues/474).

## Implemented

- A Linux native-tool IPC worker with distinct UID, irreversible `no_new_privs`, explicit environment
  allowlist, kernel identity checks, bounded requests/results, streamed updates
  and cancellation. All seven native definitions and interactive `!`/`!!` shell
  operations have worker proxies; the standard entry registers these proxies
  with the memory extension. The protected CLI bootstraps and binds the worker.
- Immutable account/user binding and owner-checked private state files. Before
  first data access, the authenticated health response must confirm the expected
  account, user and USER role; an HTTP 200 with missing identity is insufficient.
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
lifecycle behavior (38 tests in the current development run). It does not prove
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

Further #474 gates: memory-enabled CLI acceptance and Dano worker lifecycle integration,
credential isolation, Dano exact-version integration, authenticated settings
and management, ordinary pi and real in-app Browser acceptance. Subsequent
#475–477 work covers full collection/lifecycle/governance and release gates.

## Verified service combination

- OpenViking server: unmodified 0.4.20.
- OpenViking TypeScript SDK: 0.1.0, exact dependency.
- pi: 0.85.1, exact peer dependency (not bundled).
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

The standard entry exposes `/memory enable` (interactive confirmation),
`/memory pause`, `/memory status`, and `/memory show <operation-id>`. Its enable
gate checks the exact worker used by its native tools. Automatic collection
remains unapproved. Read-only saved-content and credential-owner checks against
the actual service are reproducible with `scripts/real-read.mjs`.

The Linux worker integration now exercises the registered tool proxies and
interactive shell, preserving streaming and exit codes. Both cancellation
paths are checked for absence of a delayed file write, rather than only testing
that the caller receives a cancellation error.

## Protected bootstrap primitive

`bootstrapProtectedWorker` validates canonical workspace, private agent/state
roots and a protected installation tree before starting the worker and dropping
bootstrap UID/GID. It rejects workspace overlap, replaceable ancestors,
worker-writable code, and installation symlinks escaping the installation root.
Private directories must already belong to the configured host UID with no
group/other permissions. Provisioning is explicit; this function never widens
permissions or repairs arbitrary paths.

The worker uses a configured absolute util-linux `setpriv` path to set
`no_new_privs` before Node executes. Kernel `NoNewPrivs: 1` is checked alongside
UID identity. The complete bootstrap primitive passed the real Linux worker
fixture, including its tool/interactive-shell and cancellation checks. This
does not by itself establish the multi-user Dano worker lifecycle.

## Protected pi CLI

`pi-openviking /etc/pi-openviking/profile.json [pi chat arguments]` starts the
Linux worker, drops host privileges, loads a trusted host module and calls pi's
public `main` entry with the standard extension factory. The profile and its
ancestors must be root-owned and not group/other-writable. It contains bootstrap
paths/IDs/limits, `hostModule`, `shutdownTimeoutMs` and optional
`trustedSkillPaths`; it must contain no provider credentials. See the exported
`LauncherProfile` type for required fields.

The installed host module exports `createHost({ paths, assertToolIsolation })`
and returns `{ memory, scheduler }`. It reads keys from the host-private root
and supplies the selected model's exact tokenizer. It runs after privilege
drop. Its source and approved Skill paths must be inside the protected
installation. The CLI fixes private session storage and denies executable
resource/trust overrides and package/config administration commands.

Print mode closes its scheduler/worker on return. Interactive pi emits its own
shutdown hooks and exits; worker IPC disconnect terminates outstanding tool
work. Delivery does not depend on an exit flush: the durable queue recovers on
the next launch. A container supervisor must terminate the entire process tree
on abrupt host termination.

The 2026-09-18 Linux run used the real configured model through pi 0.82.1:
Bash wrote `cli-proof.txt`, read returned its content, and the file belonged to
the separate worker UID. Workspace extension discovery was denied and the CLI
exited normally. `scripts/linux-cli.mjs` reproduces this in a disposable root
container; its `cli-test-host.mjs` deliberately leaves memory disabled and does
not substitute for memory-enabled acceptance. Model credentials are copied to
a private agent directory. Extra CA certificates must remain readable after
host privilege drop; TLS verification stays enabled.

## Release candidate validation

The standard CLI RPC path has now passed explicit enable confirmation, real
OpenViking save to `ready`, content/source inspection, new-session recall and
pause. Automatic collection remains separately unapproved. This passed first
on pi 0.82.1 and again with a fresh account on pi 0.85.1. See
[the acceptance record](docs/acceptance-2026-09-18.md). Interactive TUI screenshots
and Dano's real in-app Browser gate remain outstanding.

The exact peer moved to pi 0.85.1 because pi 0.82.1's bundled shrinkwrap kept
vulnerable transitive dependencies despite root overrides. The 0.85.1 install
resolves undici 8.9.0 and brace-expansion 5.0.9; `npm audit` currently reports
zero vulnerabilities. The package includes the Apache-2.0 license text needed
for the unmodified OpenViking SDK.
