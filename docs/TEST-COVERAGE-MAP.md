# Test coverage map (M3b migration)

Every Harness-owned suite at the source baseline was audited. For each:
original assertions preserved (loading/assembly converted only), OR the
Product-owned part stays in the source repository with its replacement
evidence named. No assertion was deleted or loosened to reduce work; where a
scenario's assembly changed, the asserted behavior is the same behavior.

## Migrated suites (in-package, `npm test` — 16 suites, all green locally)

| Suite (source blob @ 2aec76e) | Target | Loading conversion | Checks (local run) |
|---|---|---|---|
| `tests/model.test.cjs` `d90ff04d…` | `tests/model.test.mjs` | eval → real ESM; the legacy `Model` singleton + `callModel*`/`verifyConnection` wrappers → `createModelClient` per `reset()` over the SAME captured config; the `window.location` 'file:'/'https:' hosting flip → the explicit `relayEligible()` port (file: ≡ no relay). Assertions unchanged. | 62 |
| `tests/model-adapters.test.cjs` `e16b3f82…` | `tests/model-adapters.test.mjs` | same conversion (client per reset); adapter/serialization/replay/downgrade assertions unchanged. | 84 |
| `tests/model-adapters-image.test.cjs` `27c58f31…` | `tests/model-adapters-image.test.mjs` | eval → import from the public entry; rich-content assertions unchanged. | 14 |
| `tests/native-tools.test.cjs` `7ce45678…` | `tests/native-tools.test.mjs` | eval(tools+adapters+model+agent) → imports + the product registry as a verbatim fixture; end-to-end native/text-fallback/downgrade/no-resend flows unchanged. | 21 |
| `tests/agent.test.cjs` `371e3c50…` | `tests/agent.test.mjs` | eval(tools+agent) → imports + fixtures; loop/events/budget/cancel/session-switch/S18 prompt-composition assertions unchanged (product notes via the verbatim fixture). | 105 |
| `tests/agent-approval.test.cjs` `2ccc1199…` | `tests/agent-approval.test.mjs` | eval(approval+tools+agent) → imports + fixture; the suspension/integration battery unchanged. | 54 |
| `tests/agent-image.test.cjs` `708d3344…` | `tests/agent-image.test.mjs` | eval(agent+persistence+attachments+approval+capabilities) → imports; the Product IDB `PersistenceService` → an in-memory persistence triple; the Product `AttachmentStore` → an in-memory store double reproducing the exact contract exercised (ingest → record; resolveForWire → bytes/base64; SHA-256 verification failure → the real `AttachmentIntegrityError` shape name/code/reason 'hash_mismatch'; external byte-corruption surface). The integrity fail-closed, degrade-honestly, registry-untouched and budget assertions are unchanged. | 31 |
| `tests/approval.test.cjs` `97fe91ec…` | `tests/approval.test.mjs` | eval → import; the whole controller battery unchanged. | 66 |
| `tests/image-probe.test.cjs` `1a24bea4…` | `tests/image-probe.test.mjs` | eval → imports (`makeHttpError` from the package-internal module surface); the pixel-decoder, failure matrix and real-serialization assertions unchanged (the dead `void uint8ToBase64` eval was dropped — the helper now ships in the package). | 20 |
| `tests/capability-composition.test.cjs` `126f184d…` | `tests/capability-composition.test.mjs` | split by ownership (below). Kept: P1–P9 (specs half of P8), V1–V21, M1–M34, S1–S12, F0 (specs half), K1–K5. The Product `SkillInstanceStorage` (durable storage over the Runtime `MemoryWorkspace`) → an in-memory port double reproducing the manager's narrow `{ readBytes, writeBytes, removeDir, stat }` contract AND the `read/exists/remove` observation surface on the same paths. | 90 |
| `tests/task-runner.test.mjs` `04a1f43f…` | `tests/task-runner.test.mjs` | already ESM; import path update only. Assertions untouched. | 99 |
| `tests/provider-session.test.mjs` `2297585b…` | `tests/provider-session.test.mjs` | already ESM; import path update only. | 14 |
| `tests/harness-replay.test.mjs` `29d24194…` | `tests/harness-replay.test.mjs` | already ESM (entry imports); path update only. | 18 |
| `tests/harness-standalone.test.mjs` `c4ec4172…` | `tests/harness-standalone.test.mjs` | entry path update; the ONE table assertion (H1) re-pinned to the M3b semantics: no table, `ensureHarnessCore()` → `undefined`, factories usable after a plain import. All H2–H6/F1/F1b/F2/H9 blocks untouched. | 87 |
| `tests/harness-boundary.test.cjs` `986b2a64…` | `tests/harness-boundary.test.cjs` | REWRITTEN for the package (the M2b gate asserted the classic pattern; this gate asserts its DELETION): B1 closure over `src/index.js` ⊆ package set + whole-core coverage + no bare imports + no tools.js; B2 no Runtime/Product/DOM/hosting/worker-asset refs (the model.js `window.location` declared exception is gone with the wrappers — the scan is now exception-free); B3 deletion evidence (no globalThis publishes/tables anywhere in src/, no legacy wrappers, exports map exposes only `.`, zero runtime deps); B4 explicit probe deps; B5 public-surface + no-registryVersion; B6 pairing with harness-standalone. | 15 |
| — (new) | `tests/import-purity.test.mjs` | NEW gate (the runtime package's purity discipline): the entry imports cleanly with window/document/location/storage/indexedDB poisoned as throwing getters; zero global additions; zero fetch; a full task runs straight off the plain import; the shim resolves without touching anything. | 5 |

Total: 785 checks across 16 suites, all green in a clean local run
(`node tests/run-unit.cjs`).

## Browser gates (packaged artifacts)

| Gate | Source | Target | Evidence |
|---|---|---|---|
| `tests/harness-host.html` + `tests/e2e-harness-host.cjs` `c748e1c1…`/`22287f74…` | `tests/harness-host.html` + `tests/e2e-harness-host.cjs` | adapted: the page imports the public entry directly; H0c asserts table ABSENCE, shim → `undefined`, declaration v1 WITHOUT `registryVersion`, zero product DOM; R/Rb assert exactly ONE entry chunk (no self-assembly/dynamic chunks), no Runtime/Product chunk, no classic dist/src scripts, no CDN; T1–T4 + H1 unchanged (native round trip, strict fallback, cancel, real-validator restore/corruption). | 12/12 local, real Chrome over `dist/` (vite build input) |
| — (new, out-of-checkout) | — | tarball consumer (`harness-consumer/`, OUTSIDE the locus-harness checkout): installs the REAL tarball, resolves `locus-harness` from its own `node_modules`, builds with its own Vite from the public entry only, drives gates A–J in real Chrome: A native round trip; B strict-fallback real tool round trip; C TaskRunner prepare/run/cancel + exactly-once termination + admission reopen only after the boundary; D memory store + REAL adapter + REAL validators restore; E checkpoint_beyond_tail + tool_result_unpaired rejections + direct validator export; F required-persistence failure blocks later model requests (runner-level zero requests; run-level one request then none, zero tool executions); G run-level image binding degrades HISTORY images without touching the real gate, next task sends the same image normally; H composition happy path + traversal rejection; I two instances (configs/histories/runners/events) never cross; J resource boundary + zero page errors. | 17/17 local |

The consumer's first runs caught a real defect the package suites had missed
(the public `createCapabilityManager` factory referenced the class through a
re-export without a module-local binding — ReferenceError at first call);
fixed and re-verified everywhere. First-failure evidence is in the delivery
report.

## Product-owned suites (stay in the source repository — replacement evidence)

| Suite | Why it stays | Harness-side replacement evidence |
|---|---|---|
| `tests/harness-prompt-parity.test.mjs` | Its subject is Product parity: the REAL product notes (`src/ui/product-prompt.js`), the REAL runtime description (evals Runtime shell.js) and the REAL product tool registry. | The harness-composition halves of its assertions are carried by migrated `agent.test` S18 (composition over notes/description/taskEnvironment) and `harness-standalone` H6 (no port → no claims, per-session isolation). The product-side parity keeps running in the source repo. |
| `capability-composition.test.cjs` F1–F12 (adapter block) | `productTaskVfsMounts` over the Runtime `VirtualWorkspace`/`StaticFileWorkspace` — Product adapter + Runtime VFS behavior. | The Harness-owned half (pure `taskVfsMountSpecs` data) is F0 in the migrated suite; the adapter block keeps running in the source repo. |
| `capability-composition.test.cjs` W0–W9 (worker block) | Drives the Runtime `PY_WORKER_SOURCE` in a VM — Runtime worker behavior. | `validatePluginPayload` path rules are pinned by H2 (rejection path) here and by the migrated K-block payload assertions; the worker-side install proofs stay with the Runtime/Product. |
| `tests/skill-instances.test.cjs`, `store-*`, `persistence*`, `product-integration`, `core-compatibility`, `e2e-*` (product/runtime/joint) | Product wiring, Runtime and joint integration gates — not Harness-owned. | Untouched in the source repository; M3c re-runs the joint gates when the Product switches imports. |

## Historical gates not re-run here (honest boundary)

The source repository's full battery (Runtime/Python/product e2e) is outside
this extraction's scope and was not re-run: the extracted package contains no
Runtime/worker/Python code (structurally enforced by harness-boundary B1/B2),
and the source repo's suites remain green there on their own baseline. The
Runtime-side M3b precondition (fixed head targeted re-run) is recorded in the
delivery report, not here.
