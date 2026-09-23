# pi-openviking

An independent OpenViking memory extension for pi, tracked by
[Dano #465](https://github.com/zhengchengqiaobusiness-arch/Dano/issues/465).

**Implementation in progress. Version 0.1.5 is published; governance changes on this branch are not yet released.**
The package name is `@josephyoung/pi-openviking`. Both entry modules compile
against pi 0.85.1. The real pi loader loads both entries and keeps a single
registration after reload; the standard entry fails closed without its launcher binding.
The Linux CLI now runs through the public pi entry; memory-enabled CLI acceptance and product integration continue under [#474](https://github.com/zhengchengqiaobusiness-arch/Dano/issues/474).

## Implemented

### Host worker integration

The protected bootstrap accepts an optional `toolProviderModule` from its
administrator-owned profile. This file must resolve inside the validated,
worker-read-only installation. It exports `createWorkerTools({ workspace })`
and returns the `WorkerToolProvider` contract exported by `./worker`.
The factory runs only inside the unprivileged `no_new_privs` worker; host
callbacks, credentials and environment are not provided. It handles the fixed
native tool names and `user_bash`, with the same bounded IPC and cancellation.
Invalid modules fail startup; execution errors never fall back to host tools.
This allows a host to retain its own tool policies, such as Heimdall, inside
the worker. It does not itself implement Dano's Heimdall adapter or multi-user
supervisor; hosts must still provide their own worker tool policy.

### Current capabilities

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
module must run when installing. The governance suite is exercised with Node
22.22.3; release CI uses Node 22.23.2 on Linux.

```sh
npm ci
npm test
npm run check
```

`npm test` covers independent processes, killed writers, concurrent processors,
response loss, source conflicts, owner mismatch, consent, recall budgets and
lifecycle behavior. It does not prove
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

Issue #476 still requires Dano management integration, real browser acceptance,
account retirement and release verification. Publishing the extension alone
does not activate these capabilities in Dano.

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

Hosts that supply `toolProviderModule` must first require
`protectedWorkerProviderApiVersion === 1` from the bootstrap export. This
capability means the module is validated inside the protected installation and
loaded only in the unprivileged worker, with no native-tool fallback on loading
failure. Older releases without this export do not enforce this contract and
must not be used for host-specific tool guards.

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

The tokenizer callback is `countTokens(text, { model, signal })`, where `model`
contains the active pi model's `provider`, `api` and `id`. It may return a number
or a promise. Select the exact tokenizer using that identity; reject unsupported
models instead of estimating with character counts. Honor `signal` for remote
counting requests. Token counting shares the recall deadline, and errors or a
missing model omit recalled data while ordinary chat continues. The per-request
cache is bound to the model identity; model changes require counting again.

`scheduler.stop(timeoutMs)` stops new claims and returns `true` only when the
active tick has settled, including its local receipt writes. `false` means the
deadline elapsed; it does not cancel an already sent mutation or certify that
the state directory can be removed. A host that must drain writes before
releasing user resources can await `scheduler.stop()` without a deadline after
settling its network client. The ordinary launcher reports
`MEMORY_SHUTDOWN_INCOMPLETE` on a bounded stop timeout and still closes its worker.

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
## Automated npm releases

Changes to the root `package.json` version on `main` trigger
`.github/workflows/publish.yml`. The workflow checks the version against the
pre-push commit, skips versions already present on npm, then installs locked
dependencies, type-checks, builds, tests and publishes with provenance.
Use `npm version patch --no-git-tag-version` (or a deliberate minor/prerelease
version) and commit both package manifests. Stable versions use `latest`;
prereleases use `next`. A manual Actions run can retry an unpublished version.

Publishing uses npm Trusted Publishing bound to `josephyoung/pi-openviking`
and workflow filename `publish.yml`, with permission to publish. No npm token
is stored in GitHub secrets. The npm trust relationship names this repository
and workflow and permits direct publishing.

## Governance host API (unreleased)

The host constructs one `MemoryGovernanceService(stateStore, ownerClient,
delivery)` per authenticated owner and trusted scope. Pass it to the extension
factory as `governance` together with its scheduler's `wake()` method; use the
same service for authenticated management controls. Never accept owner, project,
credential or arbitrary remote Session identifiers from a model or browser.
`MemoryGovernanceScheduler` resumes pending jobs after restart without a viewer.
Keep the owner USER credential until cleanup is verified; a pending receipt is
not permission to delete local state or claim success.

`correct` and `forget` require a unique exact selection in a listed document.
Ambiguity fails before mutation. A durable barrier suppresses recall while old
scope writers drain, then public OpenViking APIs update only the selected text
and verify the old text is gone. Shared documents retain unrelated content.
The model tools return a job ID and distinguish `pending` from `complete`;
`memory_clear` asks for a real UI confirmation first. Hosts must also confirm
clear in their own management UI. `exportPage` returns only bound-scope content
and source metadata; it validates cursors and has per-document/page byte
budgets. The model export tool uses a smaller budget than the host API.

Exact-text cleanup and real-service fixtures do not prove semantic paraphrase
erasure, account retirement, or Dano browser acceptance. Those are #476 release
gates, so this branch must not be treated as the completed feature.

## Automatic collection host API (0.1.3)

`CollectionLifecycle` journals completed pi requests without copying conversation
bodies. `CollectionFactSelector` screens original entries and selects source-backed
facts using the trusted host's model callback. `CollectionScheduler` runs once per
owner, independent of viewers: it merges settled requests within `mergeWindowMs`,
forces a due batch at `maxWaitMs`, limits `maxRequestsPerBatch`, and atomically
claims the batch before inference. `resolveSession(sessionId, signal)` must resolve
only this owner's protected original session, including after process restart.
It must never resolve a model-provided path or another owner's session.

User-message roles alone do not prove authorship: pi can persist expanded Skill
or prompt-template text as a user message. The built-in input projection uses
pi's public Skill parser and excludes its instructions/examples. Hosts with
unmarked prompt templates or injected user wrappers must also provide
`projectUserText({ source, text, signal })` to `CollectionFactSelector`. Resolve
the user-authored span from protected attribution records tied to the original
entry digest, including after restart and forks. Return `undefined` when its
origin cannot be proved; that excludes the entry without falling back to the
template. Returned text must be a contiguous substring of the original message,
and is still screened for credentials and checked against current consent.
This callback is trusted host code, never a model or tool-provided function.
The protected CLI disables prompt templates already. Dano's durable attribution
adapter remains an integration requirement; the callback alone is not proof of
complete template-origin handling.

The scheduler persists attempts, next retry time and expiring claim tokens.
A second process cannot start selection while an owner claim is live. Expired
claims may be recovered, but only the current token can commit selection and
outbox receipts. A pause/revocation invalidates the claim. `maxAttempts` bounds
failures; exhausted requests become `selection_failed` with a fixed error code.
These request failures need a host status projection; they are not saved memories.
Network outcomes from actual OpenViking writes remain the delivery scheduler's
responsibility and must be reconciled rather than resent.

`workTimeoutMs` bounds source lookup and selection; configure `leaseMs` longer
than that deadline with room for durable handoff. Call `wake()` after settlement
and `start()` on owner startup to recover pending work. `stop()` aborts local
selection and waits for bounded claim cleanup. It does not flush raw conversations
or cancel a remote write. The supplied store supports `read(signal)` and
`transact(mutation, signal)` to cancel lock waits; once an atomic write starts it
finishes its durable commit. Custom stores and host callbacks should honor abort
signals too. The scheduler also fences late callbacks at the handoff boundary.

The host must still wire protected session recovery, the configured model and
credential snapshot, separate consent controls, status and lifecycle ownership.
Publishing the extension does not authorize collection for a user by itself.

`CollectionSessionRegistry` supplies the owner's persistent source resolver.
Configure it with that owner's private session root outside tool access, then
pass `collection: { sessions, lifecycleTimeoutMs, wake }` to the extension.
Before each request the extension records its original pi file reference; after
`agent_settled` it wakes the owner scheduler only after durable settlement. The
foreground deadline covers isolation/source registration and state lock waits.
An optional `onError` callback receives a fixed lifecycle-unavailable code for
status/logging without exposing source text. Without collection configuration,
the extension does not journal automatic requests.
Recovery reads original files through pi's public parser and an in-memory session
manager, rejecting invalid, old-version, cross-root or mismatched sources without
repairing them. Live branch positions use weak references for consent boundaries;
recovery without a live session uses the persisted branch.

Standard pi now offers `/memory auto-enable` with its own confirmation, and
`/memory auto-disable` to revoke collection while keeping the main memory switch
unchanged. These commands require a host with collection configured. Enabling or
resuming the main switch never creates automatic consent; resume preserves an
existing separate grant with a new source boundary. Selection failures are
reported separately in `/memory status`.

A standard host can return `collectionScheduler` alongside its delivery
`scheduler`; the launcher starts and stops both. The acceptance host in
`scripts/cli-memory-host.mjs` demonstrates optional administrator-owned
`memory-connection.json.collection` configuration: `model` (provider, id,
maxTokens, temperature and optional provider payload fields), `selector`
(maxInputBytes, maxFacts, timeoutMs), the collection `scheduler` policy and
`lifecycleTimeoutMs`. It uses the protected pi model/auth files and snapshots the
model/service keys only for local input screening. Configure these fields for the
chosen provider; collection remains unavailable when the section is absent.

Dano adapter wiring, cross-batch confirmation context, declassified task facts,
and full browser consent/lifecycle acceptance remain pending for this branch.

Cross-batch confirmation uses one adjacent, completed assistant proposition as
screened evidence. The new user's explicit confirmation is the collection source;
an already-processed request never becomes pending again. Completion metadata
records the original entry timestamp and message digest, so a copied fork ancestor
can retain its original provenance while a reused short ID or changed content
cannot borrow it. This reference must remain in the same owner, scope, authorization
epoch and collection revision. Pause/resume or renewed consent does not import the
older proposition. No historical user messages are pulled into the new batch.

### Allowlisted task facts

Raw tool arguments/results remain excluded by default. A host may configure
`CollectionFactSelector` (or `CollectionInputBuilder`) with `taskFacts: {
policyVersion, tools: new Map([[toolName, projector]]) }`. Projectors are trusted,
installed host functions, not model parameters or browser configuration. They run
locally and must verify their business result/actor contract and return only the
necessary fact text, or `undefined`. Do not stringify raw content/details or use a
model/network service inside the projector. The context supplies the bound owner,
scope and cancellation signal; the result is a copy of the original tool result.

Projection requires one matching earlier tool call, one successful result and the
same separately authorized policy version. Failed, duplicate, unlisted or
unmatched results never invoke the projector. Projected text passes the same
credential scanner, private-key snapshot matching and byte budget as conversation
candidates. The model receives only `task_fact` text with opaque source IDs, never
the raw arguments/results. Selected task facts retain the original result source
plus tool/policy provenance; only selected necessary fact text enters the outbox.

Verified provenance does not imply lasting value. The selector separately checks
whether a candidate establishes a reusable business outcome or enduring fact.
Successful connectivity/authentication/health checks, numeric status codes and
acceptance markers are transient execution evidence, including when completing
such a check was exactly what the user requested. These should produce no fact.
Host contracts should project necessary durable business fields in the first
place; a model's semantic filter is not a substitute for a narrow allowlist.

The opt-in real-model regression probe covers eligible business outcomes,
foreign owners, failed/unlisted tools, sensitive/instruction text, and repeated
transient-status requests. After building, run:

```sh
node scripts/check-collection-semantics.mjs "$PWD" /secure/models.json /secure/model-credentials.json
```

It uses the configured `xiaomi-token-plan-cn` / `mimo-v2.5` model and synthetic
business responses. The private credential JSON supplies the corresponding model
key; it is never printed. This makes real model calls and fails on a semantic
mismatch. It does not claim real OA, OpenViking delivery or browser coverage.

Explicit and automatic saves may overlap in a completed turn. The selector gets
exclusion-only context from `memory_save` calls only when the protected owner
state confirms the matching user source, content digest, scope and authorization
epoch. It must omit equivalent facts (including paraphrases), while retaining
other eligible facts in the same user message. Receipt context is locally
secret-screened and cannot itself become a selected source. Failed, blocked or
unverifiable saves do not suppress automatic candidates. If an explicit save
fails during selection or before handoff, the batch stays unprocessed for the
normal bounded retry rather than silently losing candidates.

This semantic overlap check uses the configured selector model; the host verifies
provenance, not semantic equivalence. The opt-in real-model probe covers repeated
paraphrases, partial overlap and failed/forged receipts:

```sh
node scripts/check-explicit-collection-semantics.mjs "$PWD" /secure/models.json /secure/model-credentials.json
```

Restoring the main switch preserves the existing collection grant's rule version.
It does not authorize a new task-fact policy. Hosts can pass their current
`collection.policyVersion` to the extension: standard pi reports changed rules
and `/memory auto-enable` confirms the new version separately. Each grant/resume
still establishes a new source boundary, with no backfill. Configure no projector
for tools without a trusted business-result contract, including general-purpose
shell output; the default empty allowlist remains intentional.
