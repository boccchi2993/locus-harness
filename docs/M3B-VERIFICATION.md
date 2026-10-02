# M3b review round 1 — verification record

Scope: the first review round of PR #1 (`refactor/extract-harness`), fixes
F1 (public interface gap + complete caller audit) and F2 (consumer cancel
boundary: explicit barriers + shared verdict + directed fault self-proof).
Baselines: PR head `eb70f854354eacf2b0164768a68b28fddaa736d2` (unmodified —
both first-failure proofs below were produced on it), source caller-audit
baseline `boccchi2993/Locus-browser-agent-runtime` @
`2aec76e78431382873be1db8a6db6310cc89c782` (the reviewed M2c state, NOT
source main). Runtime companion precondition is unchanged
(`locus-runtime` PR #1 @ `2435a57f…`, see §5).

## 1. F1 first-failure evidence (on unmodified eb70f85)

`docs/EXTRACTION-PLAN.md` §3 claimed `SKILL_INSTANCE_MAX_BYTES` was exported
from the public entry and that the descriptor validators were "in-package
suites only". Both statements were false; the complete caller table (§3b
there) names the real Product callers found by walking every cross-file free
identifier of the Product files at 2aec76e.

Evidence A — the new public-entry suite fails on unmodified eb70f85
(`node tests/public-entry-contracts.test.mjs`, exit 1):

```
PASS C5 this suite imports only the public entry (no internal module path)
FAIL C1 the four descriptor validators + skill path + sha256Hex are entry functions | ["validateCapabilityDescriptor","validatePluginDescriptor","validateSkillDescriptor","validateMcpDescriptor","skillInstancePath","sha256Hex"]
FAIL C1 SKILL_INSTANCE_MAX_BYTES is an entry constant (the 256 KiB skill contract) | undefined
FAIL C1 SKILL_INSTANCE_ROOT is an entry constant (the instance tree root)
FAIL C1 SKILL_INSTANCE_MARKER is an entry constant (the install-marker file name)
TypeError: entry.validateCapabilityDescriptor is not a function
```

Evidence B — a static named import fails at MODULE LINKAGE (what a real
consumer build hits):

```
SyntaxError: The requested module '…/src/index.js' does not provide an export
named 'SKILL_INSTANCE_MAX_BYTES'
```

Evidence C — a consumer built OUTSIDE the checkout against the eb70f85
tarball fails its build on the same named imports (consumer `package.json`
with `"locus-harness": "./locus-harness.tgz"`, own Vite, `npx vite build`,
exit 1):

```
error during build:
negative-main.js (1:9): "SKILL_INSTANCE_MAX_BYTES" is not exported by
"node_modules/locus-harness/src/index.js", imported by "negative-main.js".
```

After the fix (entry re-exports of the ORIGINAL authoritative definitions —
no copied validator, no re-declared constant; `SKILL_INSTANCE_MARKER` also
gained its module-level export in `extension-composition.js`): evidence A's
suite passes 20/20, and the real tarball consumer builds and passes gate K
(§4). Reproduce A/B: `git checkout eb70f85 -- src/ && node
tests/public-entry-contracts.test.mjs` (then restore). Reproduce C: pack
eb70f85 into a fresh consumer dir and `npx vite build` a module containing
the named imports above.

## 2. F2 first-failure evidence (the old gate was blind)

The OLD consumer scenario C waited a fixed `setTimeout(20)`, released the
park immediately after `cancel()` and asserted the boundary only AFTER
`await handle.ended` had settled — its comment claimed a pre-release
unsettled check that was never implemented. The reviewer's injection (a
wrapper that publishes `task_end` at cancel, resolves the caller-visible
`ended` early, and lets a second submit be accepted) passed the old C gate
and its driver checks unchanged. That injection is now a permanent,
reproducible self-proof: `tools/consumer-e2e/faults.html` +
`e2e-consumer-faults.cjs` run the SHARED scenario as control +
`early-ended` + `early-admission` + `early-task-end` over the REAL packaged
TaskRunner (test-side wrappers only — no production switch), and the SHARED
verdict (`lifecycle-verdict.js`, the same module the normal gate's check C
asserts with) must

- PASS the clean control, and
- REJECT every fault with its expected key, with the injection verified
  effective (`observation.faultInjected === true` — an ineffective
  injection fails the proof and is never counted as detection).

Actual local self-proof result (§4, full log commands there): control
`failures: []`; `early-ended` rejected by `pre-release.ended-unsettled`;
`early-admission` rejected by `pre-release.admission-closed`;
`early-task-end` rejected by `pre-release.no-task-end`; zero page errors
across all four runs. Each fault's actual rejection list is printed by the
driver and was exactly the expected key (no extra, no missing).

Deterministic pin without a browser: `tests/consumer-lifecycle-verdict.test.mjs`
(18 checks) feeds the clean observation and each fault shape to the shared
verdict and pins expected-key-only rejections plus every post-release fact.

## 3. What changed (fix summary)

F1: `src/index.js` re-exports `validateCapabilityDescriptor`,
`validatePluginDescriptor`, `validateSkillDescriptor`, `validateMcpDescriptor`,
`skillInstancePath`, `SKILL_INSTANCE_ROOT`, `SKILL_INSTANCE_MARKER`,
`SKILL_INSTANCE_MAX_BYTES`, `sha256Hex` (original definitions;
`extension-composition.js` additionally exports `SKILL_INSTANCE_MARKER`).
`SKILL_DIFF_MAX_CHARS` is deliberately NOT exported — Product presentation
policy, M3c moves it into Product `extensions.js` (EXTRACTION-PLAN §3b).
No validator algorithm, path rule, approval wording, size bound, error code
or validation order changed. Boundary B5 pins the new required surface.

F2: new shared `tools/consumer-e2e/lifecycle-verdict.js` (key assertions)
and `lifecycle-scenario.js` (entered/release barriers, MessageChannel
scheduling turns, labeled bounded waits, fault wrappers; `finally` releases
the park so a wedged fault fails its labeled timeout, never the CI wait).
`consumer-main.js` scenario C now runs the shared scenario (fault=null) and
the driver asserts the shared verdict plus the concrete boundary facts. CI
copies the new files (same list the local assembly used) and runs the
self-proof step on the SAME built consumer. Untouched, per the review
constraints: the task-runner implementation, lifecycle settlement boundary,
persistence_error priority, task identity/epoch, snapshot freezing,
relay/transport capture, replay algorithms, image run-binding, model retry
policy.

## 4. Executed this round (local, Windows, Node 24.10; commands verbatim)

| # | Command | Result |
|---|---|---|
| 1 | `node tests/public-entry-contracts.test.mjs` on eb70f85 | FAIL (§1 evidence A/B) → after fix 20/20 PASS |
| 2 | `npm test` (18 suites incl. the two new) | all 18 suites passed, 823 checks |
| 3 | `npm run build` | OK (13 modules; single entry chunk) |
| 4 | `npm pack` + content check (`tar -tzf`) | exactly `src/` + `LICENSE` + `README.md` + `package.json` |
| 5 | `HARNESS_E2E_PORT=4940 npm run test:e2e` (harness-host browser gate) | 12/12 (H0–H1) |
| 6 | consumer assembled OUTSIDE the checkout (fresh dir; files copied exactly per the CI list; `npm install`; resolution check → `node_modules/locus-harness/src/index.js`; own `npx vite build`) | build OK; both pages emitted |
| 7 | `CONSUMER_URL=http://127.0.0.1:4941/ node tests/e2e-consumer.cjs` | 20/20 (A–J+K) |
| 8 | `CONSUMER_FAULTS_URL=http://127.0.0.1:4941/faults.html node tests/e2e-consumer-faults.cjs` | 9/9 (§2) |
| 9 | eb70f85 tarball consumer `npx vite build` (negative) | build fails (§1 evidence C) |

Ports 4940/4941 were used because 4173/4930/4931 carried stale previews from
an earlier session (left untouched). One transient defect was caught and
fixed during verification (driver read `faultInjected` from the wrong
level); it never produced a false PASS — the faulty run failed visibly and
the corrected driver re-ran green.

## 5. Reused historical results (not re-run this round)

- Runtime M3b precondition (`locus-runtime` @ 2435a57 targeted re-run + CI
  green) — unchanged dependency, not re-run.
- Source-repo Product/Runtime/joint suites — outside Harness scope (see
  TEST-COVERAGE-MAP "Historical gates"); the M3c switch re-runs them.
- PR CI browser-readiness first-failures of the M3b push (two runs, same
  pattern: CDP readiness timeout before any assertion, zero-change rerun
  green, cause undetermined) — NOT re-diagnosed this round; no new
  occurrence in the local browser gates above; no timeout was loosened and
  no automatic retry was added. The first-fail logs remain with the M3b
  delivery record; the final CI run of THIS push is the authoritative
  re-verification.

## 6. Remaining M3c items (explicitly deferred, with concrete paths)

- Product `store.js` switches its classic-global reads to entry imports
  (symbols ready: §3b table); `persistence.js` replay delegates become
  imports of the entry validators.
- Product `core-compatibility.js` drops `supportedRegistryVersions` (the
  `registryVersion` field is deleted from `harnessCapabilities()` — M3b §6).
- `SKILL_DIFF_MAX_CHARS` moves INTO Product `extensions.js` (value 20000 and
  fail-closed semantics unchanged; not a Harness export by decision).
- `extensions.js` / `capability-package.js` replace the lexical-chain reads
  (validators, `sha256Hex`, `skillInstancePath`, `SKILL_INSTANCE_ROOT`,
  `SKILL_INSTANCE_MARKER`, `SKILL_INSTANCE_MAX_BYTES`, `EXTENSION_ID_PATTERN`)
  with entry imports — the surface they need is exactly what this round
  made public and proved through the tarball gate K.
- PROVENANCE.md is unchanged by this round: no new source symbol or file was
  extracted — every newly public name is a definition already extracted at
  M3b (`src/extension-composition.js`), only its visibility changed.
