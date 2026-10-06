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
bound with no Harness consumer; it belongs to the Product (moves into the
Product at M3c). Package-internal module exports (test-only consumers) stay
off the entry; see `docs/EXTRACTION-PLAN.md` §3 for the full caller-audit
table and the ownership decisions.

License: Apache-2.0 (see [LICENSE](LICENSE)). Provenance: source commit, per-file blob
SHAs and extraction mapping are recorded in `docs/PROVENANCE.md` on the implementation
branch.
