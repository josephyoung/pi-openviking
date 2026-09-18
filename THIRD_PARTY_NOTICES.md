# Third-party distribution review

This repository's adapter code is original MIT-licensed code. It does not copy
OpenViking server or example implementation code.

- `@openviking/sdk@0.1.0` declares Apache-2.0. Its upstream npm tarball omits a
  standalone LICENSE. Before publication, include the Apache license text and
  applicable upstream notices in the final artifact and review the actual
  packaged dependency tree.
- `fs-ext@2.1.1` declares MIT. Preserve its license and the notices of native
  build dependencies when distributing them.
- pi 0.82.1 is an MIT peer dependency. The extension must not bundle a second
  kernel. Images distributing pi must retain its applicable license/notices.
- OpenViking server 0.4.20 is a separate AGPL-3.0 service, not part of this
  extension artifact. Server-image delivery must include applicable license,
  notices and exact corresponding source/build/install materials. Reassess
  obligations if the server is modified. HTTP separation is not a blanket
  exemption from license obligations.

The first dependency audit reported the fixed pi peer's pinned `undici` and
`brace-expansion` vulnerabilities. Resolve or explicitly gate the affected
runtime combination before release; this source scaffold is not a published
or production-approved artifact.
