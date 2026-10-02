# M3b — Harness repository extraction plan

Status: implemented on `refactor/extract-harness` (see PROVENANCE.md for the
file/blob mapping and TEST-COVERAGE-MAP.md for the test migration). Source
baseline: `boccchi2993/Locus-browser-agent-runtime` @
`2aec76e78431382873be1db8a6db6310cc89c782` (branch `refactor/repository-split-m2c`,
PR #7 — the reviewed M2c state; NOT source main). Runtime companion:
`boccchi2993/locus-runtime` PR #1 @ `2435a57ff7a66db3db88aa98a88d404c75133483`.

This is the M3b record. It does NOT claim the Product consumes this package
yet — that switch (and the deletion of the Product's local Harness copy) is
M3c work. No M3c dependency lock exists yet and none is fabricated here.

## 1. Source symbol/file → target file → ownership

| Source file (2aec76e) | Target file | Notes |
|---|---|---|
| `src/harness/task-runner.js` (already ESM) | `src/task-runner.js` | moved; content unchanged |
| `src/harness/provider-session.js` (already ESM) | `src/provider-session.js` | moved; import path of the validators updated to the flat layout |
| `src/harness/replay-validation.js` (already ESM) | `src/replay-validation.js` | moved; the `__LOCUS_HARNESS_REPLAY_VALIDATION__` global publish DELETED |
| `src/harness/index.js` | `src/index.js` | rewritten: direct re-exports replace the table/self-assembly resolution (see §4) |
| `src/harness/core.js` | — (deleted) | the self-assembly chunk has no purpose without classic scripts |
| `src/model-adapters.js` | `src/model-adapters.js` | classic → ESM; `makeParseError` now a real import from model.js (circular edge, both sides hoisted function declarations used at call time) |
| `src/model.js` | `src/model.js` | classic → ESM; imports `getProviderAdapter`; the `Model` singleton + `legacyModelClient`/`callModel`/`callModelText`/`verifyConnection` wrappers DELETED (they read `Model` and `window.location`) |
| `src/capabilities.js` | `src/capabilities.js` | classic → ESM; gained the verbatim `uint8ToBase64` helper (the classic lexical chain had supplied it from Product `attachments.js` — the probe needs it) |
| `src/extension-composition.js` | `src/extension-composition.js` | classic → ESM |
| `src/approval.js` | `src/approval.js` | classic → ESM |
| `src/agent.js` | `src/agent.js` | classic → ESM; the `__LOCUS_HARNESS_CORE__` table assembly and all globalThis publishes DELETED |
| `tests/helpers/chrome.cjs` | `tests/helpers/chrome.cjs` | verbatim (CDP driver helper, package test infra) |
| `tests/harness-host.html` | `tests/harness-host.html` | adapted: imports `../src/index.js` directly; asserts table ABSENCE + shim semantics |
| `tests/e2e-harness-host.cjs` | `tests/e2e-harness-host.cjs` | adapted: H0c/R/Rb assert the new packaged shape (single chunk, no table, no registryVersion field) |

Extracted pure helpers that the classic lexical chain had hidden (each marked
in-file with provenance):

- `uint8ToBase64` (from `src/attachments.js`) → `src/capabilities.js`
  (consumer: `runImageInputProbe`).

No other symbol moved between files. The package has ZERO dependencies (dev
dep: vite, build-only) and no Runtime/Product import anywhere (enforced by
`tests/harness-boundary.test.cjs` B1/B2).

## 2. Import dependency graph (target) and extraction/conversion order

```
src/index.js (public entry)
  ├─ task-runner.js          (no imports)
  ├─ provider-session.js  ── replay-validation.js (no imports)
  ├─ agent.js                (no imports)
  ├─ approval.js             (no imports)
  ├─ capabilities.js         (no imports)
  ├─ extension-composition.js (no imports)
  └─ model.js  ⇄  model-adapters.js     (ONE circular edge:
        model.js imports { getProviderAdapter } from model-adapters.js;
        model-adapters.js imports { makeParseError } from model.js;
        both are hoisted function declarations consumed at call time)
```

Conversion was performed bottom-up exactly in this order, one layer fully
importing/exporting before the next was touched: (1) model-adapters + model,
(2) capabilities / extension-composition / approval, (3) agent, (4) entry.
The harness/ trio only moved. Assembly (the entry) changed last, after every
implementation was already real ESM.

## 3. Product callers → required public exports (call audit at 2aec76e)

Product files audited: `src/ui/store.js`, `src/main.js`, `src/extensions.js`,
`src/attachments.js`, `src/capability-package.js`, `src/persistence.js`,
`src/product/core-compatibility.js`, `src/product/tool-adapter.js`,
`src/ui/product-prompt.js`.

### 3a. Via the harness ENTRY (module imports)

| Consumer | Imports |
|---|---|
| `src/ui/store.js` | `createAgentSession, createApprovalController, createModelClient, historyBudgetBytes, createModelCapabilityRegistry, createImageInputGate, runImageInputProbe, classifyImageProviderError, imageInputUnavailableNotice, harnessCapabilities` + `createTaskRunner, isPersistenceFailure` (task-runner) + `createProviderSessions` (provider-session) |
| `src/main.js` | `harnessCapabilities` |

### 3b. The COMPLETE caller table (R1 revision — M3b review round 1)

The original M3b audit derived the table below from the OLD core-table/entry
publish list alone and MISSED real consumers: the classic lexical chain
resolves top-level `const`/`function` names that were never published to
globalThis and never appeared in the M2c `__LOCUS_HARNESS_CORE__` table —
that is exactly how descriptors validators and the skill-instance contract
stayed out of the public surface while the M3b text claimed full coverage.
The R1 audit walked every cross-file free identifier of the Product files
against the harness-owned definitions. First-failure evidence for the
missing exports is in docs/M3B-VERIFICATION.md §1; the surface is pinned by
`tests/public-entry-contracts.test.mjs` (public entry only) and consumer
gate K (named imports from the tarball).

| Symbol (defined in `src/extension-composition.js` unless noted) | Real caller at 2aec76e | Ownership | Public access on this branch |
|---|---|---|---|
| `validateCapabilityDescriptor` | `capability-package.js:292` (`normalizeDescriptor`) | Harness — THE descriptor schema; the package layer normalizes through it, never re-implements | entry export (R1) |
| `validatePluginDescriptor` | `capability-package.js:293` | Harness | entry export (R1) |
| `validateSkillDescriptor` | `capability-package.js:294` | Harness | entry export (R1) |
| `validateMcpDescriptor` | `capability-package.js:295` | Harness | entry export (R1) |
| `SKILL_INSTANCE_MAX_BYTES` | `capability-package.js:63` (read at MODULE INIT — the package's 256 KiB skill contract); `extensions.js:293–295` (mutation bound) | Harness contract — `SkillSourceStore.define` enforces the same bound | entry export (R1) |
| `skillInstancePath` | `extensions.js:222, 247, 317` (instance identity checks + approval labels) | Harness — the path IS the instance identity the manager materializes | entry export (R1) |
| `SKILL_INSTANCE_ROOT` | `extensions.js:222–223, 344, 390` | Harness — the instance tree root | entry export (R1) |
| `SKILL_INSTANCE_MARKER` | `extensions.js:218, 327` (hidden from `list()`, refused for mutation — Harness-owned metadata) | Harness — install-marker lifecycle | entry export (R1; the constant also gained its module export at R1) |
| `sha256Hex` | `extensions.js:359–442` (TOCTOU before/after hashes, no-op-write detection); `capability-package.js:934` (bundle integrity) | Harness-defined helper shared with the Product — the definition lives in the composition core and both sides must hash identically | entry export (R1) — the ORIGINAL implementation, no copy |
| `EXTENSION_ID_PATTERN` | `extensions.js:221`; `capability-package.js:490` | Harness | entry export since M3b |
| `CapabilityManager`, `SkillSourceStore`, `CAPABILITY_CATALOG`, `PLUGIN_CATALOG`, `SKILL_CATALOG`, `MCP_CATALOG` | `store.js:95–103` | Harness | entry exports since M3b |
| `getProviderAdapter`, `createProviderIdentity`, `createCredentialIdentity`, `projectNormalizedHistory` | `store.js:650–696, 978–979, 1385` | Harness (`model-adapters.js`) | entry exports since M3b |
| `validateReplayPrefix` / `validateNormalizedPrefix` / `replayValidationError` | `persistence.js:186–202` (one-way delegates over the deleted `__LOCUS_HARNESS_REPLAY_VALIDATION__`) | Harness | entry exports since M3b; the delegates become imports at M3c |
| `harnessCapabilities` | `store.js:61, 280`; `main.js:27` | Harness | entry export since M3b |
| `SKILL_DIFF_MAX_CHARS` | `extensions.js:283, 417` (approval-card diff length bound) | **Product presentation policy** — no Harness consumer reads it; the constant merely lived in the composition file | deliberately NOT exported — M3c moves the constant INTO Product `extensions.js` (value and fail-closed semantics unchanged) |

Not Harness symbols (found by the same walk, kept out of this package):
`WorkspaceAdapter`, `normalizeWorkspacePath`, `vfsError` / `vfsNotFound` /
`vfsReadOnly` are Runtime surface (`workspace.js` / `vfs.js`); the Product
continues to take them from the Runtime at M3c. `StaticFileWorkspace`,
`SkillInstanceStorage`, `SkillInstanceWorkspace`, `productTaskVfsMounts`
are Product-local (`extensions.js`). Runtime visibility of this split is
enforced by boundary B1/B2.

### 3c. Export-surface decisions with consumer evidence

- Kept as public factories (existing callers): `createAgentSession`,
  `createApprovalController`, `createModelClient`, `createModelCapabilityRegistry`,
  `createImageInputGate`, `createCapabilityManager`, `createProviderSessions`,
  `createTaskRunner`, plus `historyBudgetBytes()`/`maxToolIterations()`
  accessors (store reads them as functions).
- Exported AS CLASSES too (the entry previously hid them behind factories):
  `AgentSession`, `ApprovalController`, `ModelCapabilityRegistry`,
  `CapabilityManager` — real consumers exist (tests-as-hosts construct them;
  a standalone host may too).
- **Entry exports with REAL Product consumers (R1 correction):** the four
  descriptor validators, `skillInstancePath`, `SKILL_INSTANCE_ROOT`,
  `SKILL_INSTANCE_MARKER`, `SKILL_INSTANCE_MAX_BYTES` and `sha256Hex`. The
  M3b text below claimed these were consumed by "the in-package suites
  only" and that the entry already exported them — both statements were
  wrong: the callers in §3b are Product code, and the entry did not even
  re-export them (a static named import failed at module linkage; see
  docs/M3B-VERIFICATION.md §1). Fixed and pinned at R1.
- Still package-internal (module exports, consumers are the in-package
  suites only — re-verified at R1, no Product caller found):
  `parseToolCall`, `stripInternalFields`, `truncateFor` (agent.test),
  `ApprovalError`, `ApprovalBusyError` (approval.test), `detectDialect`
  (model.test), `makeHttpError` (image-probe.test), `generateProbePng`,
  `PROBE_*`, `isImageUnsupportedProviderError` (image-probe.test),
  `validateCatalogSet`, `CAPABILITY_STATES`, `MCP_STATES`, `PLUGIN_RUNTIMES`,
  `pluginRuntimeProvider`, `unregisterPluginRuntimeProvider`.
  (`rawReplayIdentityCompatible` is an ENTRY export since M3b — the M3b
  text mislisted it as internal; it stays a public export because it is
  provider-replay surface consumed alongside the replay validators.)
  The remaining internals surface through the entry only if a real
  consumer appears — never to pad the export list.
- No `./src/*` wildcard in the package `exports` map — consumers get exactly
  `.` (pinned by harness-boundary B3).

## 4. Deleted classic/global/legacy compat surface (the M3 removal list, executed)

1. `__LOCUS_HARNESS_CORE__` declaration table (agent.js) and every read of it
   (entry `readCoreTable`/`harness()`).
2. `__LOCUS_HARNESS_REPLAY_VALIDATION__` global publish (replay-validation.js)
   — the Product persistence delegates it served are an M3c adaptation item.
3. Every `globalThis.<name> =` publish across the six classic files
   (~40 publishes) — none remain in `src/` (boundary B3).
4. Classic-script load-order dependency — replaced by static ESM imports;
   the circular model.js ⇄ model-adapters.js edge is call-time-safe.
5. Host-side eval/new-Function assembly — the migrated suites import the
   package modules (in-package suites may import package modules directly;
   the external consumer imports only the public entry).
6. `Model` singleton + `legacyModelClient` + `callModel`/`callModelText`/
   `verifyConnection` wrappers, including the guarded `window.location`
   relay read (model.js). Consumers pass config objects to
   `createModelClient`; the relay decision is the explicit `relayEligible()`
   port (default: no relay).
7. `ensureHarnessCore()` self-assembly — kept ONLY as an explicitly-marked
   no-assembly compat function: it performs no work, boots no registry and
   resolves to `undefined`; factories work immediately after a plain import
   (proven by import-purity P4/P5 and the host page). It does NOT re-expose
   the old internal table.

## 5. What stays in the Product repository, and why

- `src/tools.js` (`AGENT_TOOL_DEFINITIONS`, `executeTool`) — the product tool
  registry and execution adapter (contract §3.2). The Harness receives its
  tool surface through the injected ToolPort. The migrated suites carry the
  registry content as verbatim fixtures (`tests/fixtures/`).
- `src/extensions.js` (Product adapter half: `StaticFileWorkspace`,
  `SkillInstanceStorage`, `SkillInstanceWorkspace`, `productTaskVfsMounts`)
  and `src/capability-package.js` — durable storage and product catalog
  adapters. `LocusCapabilityPackage` validation semantics are portable and
  MAY move in a later step; not needed by any Harness-owned behavior, so
  they stayed (no extraction without a consumer).
- `src/attachments.js` — attachment storage (`AttachmentStore`) plus the
  Product-side content-part constructors; the Harness consumes attachment
  resolution only through the image-input port.
- `src/persistence.js` (IDB/OPFS service, replay delegates), `src/ui/store.js`
  and all Vue/UI — Product composition and projection.
- `src/mutation-policy.js`, `src/product/*`, `src/ui/product-prompt.js` —
  product policy/check/notes.
- Product-owned suites: `harness-prompt-parity.test.mjs` (its whole purpose
  is parity between the REAL product notes/runtime description and the
  prompt — it evals Product sources), the product-adapter block of
  `capability-composition.test.cjs` (F1–F12, `productTaskVfsMounts` over the
  Runtime VFS) and the worker-install block (W0–W9, Runtime
  `PY_WORKER_SOURCE`), plus every Runtime/Product/joint suite.

## 6. harnessCapabilities(): registryVersion disposition (explicit record)

- The declaration is now built from the real module graph: `contractVersion: 1`,
  six port declarations (`taskLifecycle` with the real `TASK_OUTCOME_REASONS`
  enum, real `MAX_TOOL_ITERATIONS`/`HISTORY_BUDGET_BYTES`; `toolPort`;
  `descriptionPort` optional; `modelClient` captured-config; `approval` with
  the same shape rule as the source entry — `kinds` stays OMITTED because the
  real `APPROVAL_KINDS` is the kind→schema table, not a string array;
  `persistencePort`) and the six semantic capabilities, now all statically
  true because the implementations ARE the module graph.
- **`registryVersion` is REMOVED.** The internal registry the field described
  is deleted; keeping the field would require a fabricated registry, which
  this extraction refuses. The two version concepts (public `contractVersion`
  vs internal registry generation) remain distinct concepts — one of them
  simply no longer has a referent.
- **M3c adaptation (mandatory, recorded):** the Product checker
  (`src/product/core-compatibility.js`) requires `harness.registryVersion`
  (`PRODUCT_CORE_REQUIREMENTS.supportedRegistryVersions: [1]`) and classifies
  absence as `capability_missing` (core harness, port registryVersion) —
  i.e. every Product task would reject as `core_incompatible` if the Product
  consumed this package unchanged. M3c must drop
  `supportedRegistryVersions` from the Product requirement table (and its
  `result.harness.registryVersion` projection) in the same change that
  switches the imports. This is a Product-side adaptation of a documented
  deletion — NOT a silent change of version semantics: `contractVersion`
  is unchanged at 1 and the deleted field never was the protocol version.

## 7. Packaging and independence rules

- Package `locus-harness@0.1.0`, private, NOT published. Node >= 20.
- Zero runtime dependencies; vite is a devDependency (build of the host page
  only). No Runtime, no Vue, no Product file, no IDB/OPFS, no worker source.
- Import-time purity: no DOM/storage/fetch/global mutation/task start
  (`tests/import-purity.test.mjs` proves it under poisoned browser globals).
- `npm pack` ships exactly `src/` + `LICENSE` + `README.md` + `package.json`
  (no tests, no logs, no keys, no source-Product content; no file:, symlink
  or adjacency dependencies — verified by the out-of-checkout consumer).
- The out-of-checkout consumer installs the real tarball into its OWN
  `node_modules`, builds with its own Vite from `import … from 'locus-harness'`
  only, and runs the acceptance gates (A–J) in a real browser over the built
  artifact. CI runs the consumer against a tarball staged in `RUNNER_TEMP`
  and asserts the resolution path stays inside the consumer's `node_modules`.
