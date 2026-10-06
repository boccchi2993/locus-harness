# Tarball consumer harness (sources)

These files are the SOURCE of the out-of-checkout tarball consumer used by
CI (`out-of-checkout tarball consumer` job): CI copies them under
`RUNNER_TEMP`, installs the packed `locus-harness` tarball there, builds the
page with the consumer's own Vite from the public entry import only
(`import … from 'locus-harness'`), and drives acceptance gates A–J+K in
headless Chrome over the built artifact, then the lifecycle fault
self-proof on the SAME build.

The consumer instance NEVER runs inside this checkout — that isolation is
the point of the gate (it proves the package is self-contained: no
adjacency, no `file:` dependency, no checkout `src/` fallback). The primary
local verification was performed with this harness assembled in a directory
outside the checkout; see docs/EXTRACTION-PLAN.md §7 and
docs/M3B-VERIFICATION.md.

- `consumer-main.js` — the page script (public entry import only; gates
  A–J+K; scenario K named-imports the M3b-R1 public contract surface, so a
  missing entry export breaks the consumer build)
- `lifecycle-verdict.js` — the SHARED lifecycle key assertions (pure
  logic; also pinned by tests/consumer-lifecycle-verdict.test.mjs)
- `lifecycle-scenario.js` — the SHARED cancel-boundary scenario
  (entered/release barriers, labeled bounded waits, test-side fault
  wrappers); runs fault=null in the normal gate and the three directed
  faults on the self-proof page
- `faults.html` / `consumer-faults-main.js` — the fault SELF-PROOF page:
  control + early-ended + early-admission + early-task-end over the REAL
  packaged TaskRunner surface; the gate is the same shared verdict
  (control passes, every fault is rejected by its expected key)
- `e2e-consumer.cjs` / `e2e-consumer-faults.cjs` — the CDP gate drivers
  (use the repo's `tests/helpers/chrome.cjs`, copied next to them at
  assembly time)
- `index.html` / `faults.html` / `vite.config.js` / `package.json` — the
  consumer's own build (two-page rollup input; the `index` key keeps the
  entry chunk name the J resource verdict matches)

The old scenario-C gate (fixed `setTimeout(20)` wait, park released
immediately after cancel, boundary asserted only after `ended` settled)
accepted all three directed faults — that weakness is what the shared
verdict + self-proof replace.

