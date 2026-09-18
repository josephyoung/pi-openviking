# Standard CLI memory acceptance — 2026-09-18

## Executed combination

- Independent extension source based on `f6bda12`, with the acceptance fixtures
  in this change; unpublished 0.1.0 development artifact.
- pi 0.82.1; Node 22.23.2 on Linux with distinct host/tool UIDs and `no_new_privs`.
- Original OpenViking 0.4.20, TypeScript SDK 0.1.0, disposable USER-level account.
- The configured model alias is `qwen35`, whose configured display name is
  `DeepSeek-V4-Flash`. This is configuration evidence, not a claim about the
  provider's private backend implementation.

## Exercised through public pi CLI RPC mode

The driver sends ordinary pi commands and answers the extension confirmation
request through pi's documented RPC UI response. It does not call the memory
factory's enable/save methods or advance delivery from the test driver.

1. `/memory status` proved default-off memory and unapproved auto collection.
2. `/memory enable` emitted the actual confirmation dialog and persisted consent.
3. A fresh user prompt caused the real model to call `memory_save`.
4. The background scheduler reached `ready`, using the real service's source,
   task, archive, diff, content and retrieval checks.
5. `/memory show` displayed saved content, source session and status.
6. `new_session` followed by a neutral preference question recalled the saved
   synthetic report title and Simplified Chinese preference.
7. `/memory pause` disabled authorization. Auto collection remained unapproved.
8. The configured USER key was absent from all captured RPC events and stderr.

The durable operation reference is `7c9002d59239465d23f39414618616044c2621bfc097e377c9e926f18a59a651`.
The safe machine result remains in the isolated run's `result.json`; no keys or
connection configuration are committed. Dano browser acceptance, interactive
TUI screenshots, dual-user product integration and published-artifact testing
are separate outstanding gates.

## Tokenizer evidence

The trusted test host loads [DeepSeek-V4-Flash tokenizer files](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/tree/60d8d70770c6776ff598c94bb586a859a38244f1)
from fixed revision `60d8d70770c6776ff598c94bb586a859a38244f1`.
`@huggingface/tokenizers@0.2.0` produced identical token IDs to Rust
`tokenizers@0.23.2` for 24 multilingual/Unicode/whitespace cases, with special
tokens disabled. The host counts the rendered reference block, not just the
memory text. This proves local tokenizer parity for that corpus; it does not
infer the remote provider's hidden routing or billing token count.

- `tokenizer.json`: SHA-256 `8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf`
- `tokenizer_config.json`: SHA-256 `6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547`

## Dependency release follow-up

The tested pi 0.82.1 tarball bundles a shrinkwrap that retained vulnerable
undici/brace-expansion versions despite root npm overrides. Those attempted
overrides are not a fix and are not the published installation recommendation.
The release candidate is being moved to upstream pi 0.85.1; its full checks and
real-service revalidation must pass before the new combination is approved.

## pi 0.85.1 revalidation

A second fresh disposable account completed all eight CLI/RPC steps above with
pi 0.85.1; operation
`3f5fba7c79c6c8d2f48e896f1ccae5ff6ffbf89a09fdc3defca41e082e628884`.
All 38 automated tests and type checks passed. The actual installed dependency
tree uses undici 8.9.0 and brace-expansion 5.0.9; the current audit has zero
findings. This establishes the updated CLI combination, not Dano compatibility.
