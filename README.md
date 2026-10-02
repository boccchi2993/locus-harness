# locus-harness

Locus Harness — model-driven agent execution and orchestration, extracted from the
[Locus product repository](https://github.com/boccchi2993/Locus-browser-agent-runtime).

**Status: extraction candidate (M3b). This `main` branch is intentionally minimal —
the implementation lives on `refactor/extract-harness` and is not merged yet. Until
the Product switches its imports (M3c), the authoritative Harness implementation
remains in the product repository at
`2aec76e78431382873be1db8a6db6310cc89c782` (branch `refactor/repository-split-m2c`,
PR #7).**

Owns (independent of the Runtime and the Product):

- agent loop (`AgentSession`), task lifecycle (`createTaskRunner`), approval semantics
  (`createApprovalController`),
- model protocol and transport: provider adapters, `createModelClient` with captured
  configuration, provider identity, tools-downgrade and fallback policy,
- provider replay validation (the real `validateReplayPrefix` /
  `validateNormalizedPrefix` algorithms),
- image capability gate (registry, gate, probe, provider-rejection classification),
- capability composition core (descriptor validation, `CapabilityManager`,
  plugin runtime provider seam, `TaskEnvironment`).

Does not own and never imports: Runtime (VFS/shell/Python/network/workers), Vue,
Product store/persistence/tools routing, IDB/OPFS. Tools arrive through an injected
`ToolPort`, execution-environment descriptions through a description port, persistence
through injected storage ports, image bytes through an image-input port, telemetry
through an injected sink.

License: Apache-2.0 (see [LICENSE](LICENSE)). Provenance: source commit, per-file blob
SHAs and extraction mapping are recorded in `docs/PROVENANCE.md` on the implementation
branch.
