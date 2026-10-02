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
  // agent loop
  'agent.test.mjs',
  'agent-approval.test.mjs',
  'agent-image.test.mjs',
  // approval
  'approval.test.mjs',
  // image capability
  'image-probe.test.mjs',
  // capability composition core
  'capability-composition.test.mjs',
  // public-entry contract surface (M3b review R1: the descriptor validators
  // and the skill-instance contract data real Product consumers read)
  'public-entry-contracts.test.mjs',
  // extracted task/provider/replay modules (real ESM since M1a/M2b)
  'task-runner.test.mjs',
  'provider-session.test.mjs',
  'harness-replay.test.mjs',
  // independence gates
  'harness-standalone.test.mjs',
  'harness-boundary.test.cjs',
  'import-purity.test.mjs',
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
