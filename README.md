# locus-harness

Locus Harness — model-driven agent execution and orchestration, extracted from the
[Locus product repository](https://github.com/boccchi2993/Locus-browser-agent-runtime).

**Status: repository split complete; implementation merged into `main`.**
This repository is the authoritative Harness implementation. It operates without
[locus-runtime](https://github.com/boccchi2993/locus-runtime), using injected tools and storage ports.
[locus-product](https://github.com/boccchi2993/locus-product) composes the two independent packages.
See the [M4b mainline verification](https://github.com/boccchi2993/locus-product/blob/main/docs/M4B-MAINLINE-VERIFICATION.md)
and [maintenance TODO](TODO.md) for remaining test-infrastructure work.

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

## Public surface (import from `'locus-harness'`)

The package exposes exactly one entry (`.`). Grouped exports:

- Agent loop: `createAgentSession` / `AgentSession`, `buildSystemPrompt`,
  `historyBudgetBytes()`, `maxToolIterations()`, `HISTORY_BUDGET_BYTES`,
  `MAX_TOOL_ITERATIONS`.
- Task lifecycle: `createTaskRunner`, `isPersistenceFailure`, `TASK_OUTCOME_REASONS`.
- Provider sessions + replay validation: `createProviderSessions`,
  `replayValidationError`, `validateReplayPrefix`, `validateNormalizedPrefix`.
- Model layer: `createModelClient`, `MODEL_TIMEOUT_MS`, `MODEL_MAX_RESPONSE_BYTES`,
  `getProviderAdapter`, `OpenAIAdapter`, `AnthropicAdapter`,
  `createProviderIdentity`, `createCredentialIdentity`, `projectNormalizedHistory`,
  `rawReplayIdentityCompatible`.
- Approval semantics: `createApprovalController` / `ApprovalController`, `APPROVAL_KINDS`.
- Image capability gate: `createModelCapabilityRegistry` / `ModelCapabilityRegistry`,
  `createImageInputGate`, `runImageInputProbe`, `classifyImageProviderError`,
  `imageInputUnavailableNotice`.
- Capability composition core: `createCapabilityManager` / `CapabilityManager`,
  `SkillSourceStore`, `pythonExtensionKeyOf`, `validatePluginPayload`,
  `registerPluginRuntimeProvider`, `EXTENSION_ID_PATTERN`,
  `EXTENSION_PY_MODULE_PATTERN`, `CAPABILITY_CATALOG`, `PLUGIN_CATALOG`,
  `SKILL_CATALOG`, `MCP_CATALOG`.
- Descriptor + skill-instance contract (added by review round 1 — real Product
  consumers at the source baseline; the ORIGINAL definitions, no copies):
  `validateCapabilityDescriptor`, `validatePluginDescriptor`,
  `validateSkillDescriptor`, `validateMcpDescriptor`, `skillInstancePath`,
  `SKILL_INSTANCE_ROOT`, `SKILL_INSTANCE_MARKER`, `SKILL_INSTANCE_MAX_BYTES`,
  `sha256Hex`.
- Declaration + compat: `harnessCapabilities()`, `ensureHarnessCore()` (a
  no-assembly shim resolving to `undefined` — factories need no init call).

Deliberately NOT exported: `SKILL_DIFF_MAX_CHARS` — an approval-card display
bound with no Harness consumer; it belongs to the Product and was moved there during M3c. Package-internal module exports (test-only consumers) stay
off the entry; see `docs/EXTRACTION-PLAN.md` §3 for the full caller-audit
table and the ownership decisions.

License: Apache-2.0 (see [LICENSE](LICENSE)). Provenance: source commit, per-file blob
SHAs and extraction mapping are recorded in [docs/PROVENANCE.md](docs/PROVENANCE.md).

## Development and consumption

```bash
npm ci
npm run build
npm test
npm run test:e2e
npm pack
```

The split-closeout baseline has 18 unit suites and a built standalone Harness
browser host. Browser tests require Chrome. The independent tarball consumer uses
its own installation and build; see [coverage](docs/TEST-COVERAGE-MAP.md) and
[verification](docs/M3B-VERIFICATION.md). Model traffic in these gates uses fakes.
The package is private and is not published to npm; consume a packed tarball or
an exact Git commit, importing only from `locus-harness`.
