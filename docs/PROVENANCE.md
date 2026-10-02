# Provenance

All implementation sources were extracted from the source repository below as
snapshots at one fixed commit. This package does NOT claim the source
repository's full Git history, does not rewrite it, and does not reattribute
authorship.

- Source repository: https://github.com/boccchi2993/Locus-browser-agent-runtime
- Source branch: `refactor/repository-split-m2c` (PR #7, the reviewed M2c state)
- **Fixed extraction baseline commit: `2aec76e78431382873be1db8a6db6310cc89c782`**
- License: Apache-2.0 — carried verbatim in [`LICENSE`](../LICENSE) (the source
  repository's license file, unmodified).
- Companion extraction: `boccchi2993/locus-runtime` PR #1 @
  `2435a57ff7a66db3db88aa98a88d404c75133483` (Runtime, extracted first).

## Blob mapping (source path → blob SHA at the baseline → target path)

| Source blob (git ls-tree @ 2aec76e) | Source path | Target path |
|---|---|---|
| `400a85acc1f8fd3fc274aff20e75031c516b758a` | `src/agent.js` | `src/agent.js` |
| `7e3189181332a35855996c12e2a24f63ba74cf71` | `src/approval.js` | `src/approval.js` |
| `a10d446be0f8182f726ac9106938f8aa4305c78f` | `src/capabilities.js` | `src/capabilities.js` |
| `86395ed3d765ddaac67d66941f61c86faddb5d96` | `src/extension-composition.js` | `src/extension-composition.js` |
| `0a616a5573f7d6767ac2aff61848453523937e76` | `src/model-adapters.js` | `src/model-adapters.js` |
| `7b63849e0df4173e05e30ae6b06f554b3a29ca9b` | `src/model.js` | `src/model.js` |
| `ca98615309250b33644a3545b53226dd0ed39b17` | `src/harness/index.js` | `src/index.js` (rewritten; see EXTRACTION-PLAN §4) |
| `d5287912b2c5001b7658141228cf5868b853182e` | `src/harness/task-runner.js` | `src/task-runner.js` |
| `fbee7d9ea6d01ceade50135facb988ca2437dbb8` | `src/harness/provider-session.js` | `src/provider-session.js` |
| `e8a3d83d5c656c48e662f6bc83a3b447b2bd82dd` | `src/harness/replay-validation.js` | `src/replay-validation.js` |
| `371e3c50855be121889aab22cd51dd3a2945196e` | `tests/agent.test.cjs` | `tests/agent.test.mjs` |
| `2ccc1199cd87c98a776bdf0c841d34dad9c0a6ff` | `tests/agent-approval.test.cjs` | `tests/agent-approval.test.mjs` |
| `708d33444d139da1e1d610c138df20c2379b49a4` | `tests/agent-image.test.cjs` | `tests/agent-image.test.mjs` |
| `97fe91ecf5246b364fcf29f2426d6b3f77046fad` | `tests/approval.test.cjs` | `tests/approval.test.mjs` |
| `126f184d0e23997996f04f298221899335e06803` | `tests/capability-composition.test.cjs` | `tests/capability-composition.test.mjs` (split; see TEST-COVERAGE-MAP) |
| `d90ff04d297c7e4dc357b9eb7f5aece841105f12` | `tests/model.test.cjs` | `tests/model.test.mjs` |
| `e16b3f82fab7422e84e5844e8f9e7588c7aad6ba` | `tests/model-adapters.test.cjs` | `tests/model-adapters.test.mjs` |
| `27c58f318c2de63cdfdc39753000a19d63cfceb7` | `tests/model-adapters-image.test.cjs` | `tests/model-adapters-image.test.mjs` |
| `7ce45678862a39ef068de3fe82c2eb5b465afa12` | `tests/native-tools.test.cjs` | `tests/native-tools.test.mjs` |
| `1a24bea42535a395948dfd3ca289b23064518c76` | `tests/image-probe.test.cjs` | `tests/image-probe.test.mjs` |
| `04a1f43ff85a11169ffa4e107a406a0078b535b8` | `tests/task-runner.test.mjs` | `tests/task-runner.test.mjs` |
| `2297585b848045f4752c35d70549e5d9b4a79ae3` | `tests/provider-session.test.mjs` | `tests/provider-session.test.mjs` |
| `29d241946851e682f06c17c406d19db026c2d1f9` | `tests/harness-replay.test.mjs` | `tests/harness-replay.test.mjs` |
| `c4ec4172dc10094414ac0a167dd9653c87b54755` | `tests/harness-standalone.test.mjs` | `tests/harness-standalone.test.mjs` |
| `986b2a64f108b4130f49517cf9cf4fa046e5b0a9` | `tests/harness-boundary.test.cjs` | `tests/harness-boundary.test.cjs` (rewritten for the package) |
| `c748e1c1024506354a2c81a9d720e7ebe163a788` | `tests/harness-host.html` | `tests/harness-host.html` (adapted) |
| `22287f7423865448cf9061e9e7298bb27b30bde0` | `tests/e2e-harness-host.cjs` | `tests/e2e-harness-host.cjs` (adapted) |
| (helpers, verbatim) | `tests/helpers/chrome.cjs` | `tests/helpers/chrome.cjs` |
| (verbatim helper, see below) | `src/attachments.js` (`uint8ToBase64` only) | inlined into `src/capabilities.js` |

Small verbatim inclusions with their own provenance comments in-file:

- `uint8ToBase64` — extracted from `src/attachments.js` @ 2aec76e into
  `src/capabilities.js` (the classic lexical chain had supplied it to the
  image probe; the package owns its copy now).
- `AGENT_TOOL_DEFINITIONS` / `locusEnvironmentNotes` — Product-owned content
  carried as TEST FIXTURES ONLY (`tests/fixtures/product-tool-registry.mjs`,
  `tests/fixtures/product-environment-notes.mjs`), byte-identical to the
  source at 2aec76e so the migrated prompt assertions keep their exact
  subject. Never imported by `src/`.
- The synthetic skill markdown (`tests/fixtures/skills/synthetic-skill/SKILL.md`)
  — test fixture carried from the source `tests/fixtures/` tree.

## Conversion, not just copy

Each migrated implementation file carries a provenance header (source repo,
branch, commit, blob SHA, license) and a note about its M3b conversion. The
conversion is assembly-only: real ESM imports/exports replace the classic
globalThis publishes, the declared `__LOCUS_HARNESS_CORE__` table, the
self-assembly chunk and the legacy `Model`/`callModel` wrappers (the full
deletion list is in [EXTRACTION-PLAN.md](EXTRACTION-PLAN.md) §4). The
algorithmic content (agent loop, model protocol/transport, replay validation,
approval semantics, image gating, capability composition, task lifecycle) is
unchanged — this package is an extraction candidate whose behavior is pinned
by the migrated suites, not a redesign.
