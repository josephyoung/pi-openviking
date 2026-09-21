# Third-party distribution review

This repository's adapter code is original MIT-licensed code. It does not copy
OpenViking server or example implementation code.

- `@openviking/sdk@0.1.0` declares Apache-2.0. Its upstream npm tarball omits a
  standalone LICENSE. The complete Apache-2.0 text is shipped in `licenses/Apache-2.0.txt`.
  Upstream: https://github.com/volcengine/OpenViking/tree/b54001e2e5c974ffd7a09ba543813fa104a99561/sdk/typescript.
  The dependency is unmodified; its published tarball contains no separate
  NOTICE or copyright attribution file. Its package metadata and original
  source notices remain in the dependency. Review the final image dependency
  tree separately; this notice does not relabel the server license.
- `fs-ext@2.1.1` declares MIT. Preserve its license and the notices of native
  build dependencies when distributing them.
- pi 0.85.1 is an MIT peer dependency. The extension must not bundle a second
  kernel. Images distributing pi must retain its applicable license/notices.
- OpenViking server 0.4.20 is a separate AGPL-3.0 service, not part of this
  extension artifact. Server-image delivery must include applicable license,
  notices and exact corresponding source/build/install materials. Reassess
  obligations if the server is modified. HTTP separation is not a blanket
  exemption from license obligations.

The release candidate uses pi 0.85.1 after the initial pi 0.82.1 combination
reported undici and brace-expansion vulnerabilities. Root overrides did not
replace the old package's bundled shrinkwrap. The current exact peer resolves
undici 8.9.0 and brace-expansion 5.0.9 and passes `npm audit` with zero findings
on 2026-09-18. Re-audit the final host image and later releases separately.

- `@secretlint/core@13.0.5` and
  `@secretlint/secretlint-rule-preset-recommend@13.0.5` declare MIT and ship their
  LICENSE files. They are unmodified runtime dependencies for local text
  screening. The recommended preset bundles scanner implementations; preserve
  its original copyright/license notices in distributions. The adapter excludes
  its comment-suppression scanner so conversation content cannot disable checks.
