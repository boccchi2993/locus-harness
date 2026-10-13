// HN-TEST-001 fixture: a controllable stand-in for the real browser gate,
// reachable only through the TEST-ONLY HARNESS_E2E_GATE_PATH seam in
// tests/e2e.cjs. tests/e2e-orchestrator.test.cjs selects an outcome via the
// HARNESS_E2E_GATE_FIXTURE variable; with that variable unset the fixture
// fails closed, so it can never pass for a real gate.
const mode = process.env.HARNESS_E2E_GATE_FIXTURE || '';
if (mode === 'exit0') {
  process.exit(0);
} else if (mode === 'exit3') {
  process.exit(3);
} else if (mode === 'signal') {
  // Terminate this gate child by signal, so spawnSync reports
  // { status: null, signal: 'SIGTERM' } on POSIX. On Windows the same
  // self-kill degrades to a nonzero hard exit with no signal; the split
  // is documented (and asserted accordingly) in e2e-orchestrator.test.cjs.
  process.kill(process.pid, 'SIGTERM');
} else {
  console.error('e2e-gate-fixture: unknown HARNESS_E2E_GATE_FIXTURE: ' + JSON.stringify(mode));
  process.exit(70);
}
