// Runs every locus-harness Node unit suite sequentially. No internet required.
// Usage: node tests/run-unit.cjs   (npm test)
// M3b registry: only the migrated Harness-owned suites (see
// docs/TEST-COVERAGE-MAP.md for the per-suite migration mapping).
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  // model protocol + transport
  'model.test.mjs',
  'model-adapters.test.mjs',
  'model-adapters-image.test.mjs',
  'native-tools.test.mjs',
  'tool-output-path.test.mjs',
  // agent loop
  'agent.test.mjs',
  'agent-approval.test.mjs',
  'agent-image.test.mjs',
  'request-budget.test.mjs',
  'context-window.test.mjs',
  // approval
  'approval.test.mjs',
  // C3 persistent approval grants (scope 'persistent' + the persistentGrants port)
  'approval-persistent.test.cjs',
  // image capability
  'image-probe.test.mjs',
  // capability composition core
  'capability-composition.test.mjs',
  // incremental capability package registration (wheel artifacts, skill upgrade rule)
  'capability-packages.test.mjs',
  // C3 credential bindings in capability descriptors (validation, cross-
  // capability name uniqueness, credential state, snapshot entries)
  'capability-credentials.test.cjs',
  // wheel-only plugins (D10 §6): no source-text payloads, no provider seam
  'wheel-only-plugins.test.mjs',
  // public-entry contract surface (M3b review R1: the descriptor validators
  // and the skill-instance contract data real Product consumers read)
  'public-entry-contracts.test.mjs',
  // consumer lifecycle verdict logic (M3b review R1 F2: the shared key
  // assertions the tarball consumer gate and the fault self-proof both run)
  'consumer-lifecycle-verdict.test.mjs',
  // extracted task/provider/replay modules (real ESM since M1a/M2b)
  'task-runner.test.mjs',
  'provider-session.test.mjs',
  'harness-replay.test.mjs',
  // independence gates
  'harness-standalone.test.mjs',
  'harness-boundary.test.cjs',
  'import-purity.test.mjs',
  // HN-TEST-001: the real tests/e2e.cjs orchestrator's success
  // classification (exit 0 / nonzero / signal / spawn error), driven
  // through the TEST-ONLY gate seams. Four real orchestrator runs,
  // each with its own vite build + preview — the slow suite in this
  // list by design.
  'e2e-orchestrator.test.cjs',
];

let failed = 0;
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error('SUITE FAIL: ' + s);
  }
}
console.log(failed ? failed + ' suite(s) FAILED' : 'all ' + SUITES.length + ' harness suites passed');
process.exit(failed ? 1 : 0);
