# Maintenance TODO

The repository split is complete. The items below remain open maintenance work.

## HN-TEST-001: Reject signal-terminated browser gates

- [x] Closed 2026-10-12 in PR #2. Owner: Harness test infrastructure.
- Fix commit: [e37a9ee](https://github.com/boccchi2993/locus-harness/commit/e37a9eefa27f93537c170ffb2b5d8df7a6bca915) — success now requires `status === 0` with no termination signal and no spawn error; every other outcome prints status/signal/error and exits nonzero; preview cleanup stays in the `finally` on every path (and on Windows the tree kill now runs while the shell wrapper is alive — the old order orphaned vite and left the port listening).
- Tests: `tests/e2e-orchestrator.test.cjs` (registered in the `npm test` SUITES list) drives the real `tests/e2e.cjs` through the TEST-ONLY `HARNESS_E2E_GATE_PATH` / `HARNESS_E2E_GATE_CMD` seams for exit 0 / nonzero / signal / spawn-error results.
- Evidence: pre-fix failure output (16 failing checks; all three negative cases exited 0) and post-fix pass output are in the PR #2 description; PR-branch CI run [38230808236](https://github.com/boccchi2993/locus-harness/actions/runs/38230808236) — the unit job runs the four classification cases on ubuntu-24.04 (the POSIX `signal=SIGTERM` assertion included), the built-host browser gate and the out-of-checkout consumer job pass unchanged.
- Location: `tests/e2e.cjs`, where `gateStatus = gate.status || 0` converts a child result with `status: null` into success.
- Closeout review reproduced this through the actual script with a controlled child-process result `{ status: null, signal: 'SIGTERM' }`: the orchestrator exited 0.
- This is a test-driver defect, not evidence that previously observed complete browser assertion runs failed.

Implementation path:

1. Count only an explicit zero child exit status without a spawn error or termination signal as success.
2. Preserve nonzero exits; treat null status, signal termination and spawn errors as failures. Include status/signal/error diagnostics.
3. Retain preview cleanup and bounded process termination on every path.
4. Add deterministic tests exercising the actual orchestrator for zero, nonzero, signal and spawn-error results; do not copy the classification algorithm into the test.

Acceptance: negative tests fail on the old script and pass after the fix; normal built-host and external-consumer gates still pass; signal/spawn failures produce nonzero parent exits and cleanup still executes. Link the fixing commit and actual commands/results before checking off.

## Shared browser-startup investigation

- [ ] Track [RT-CI-001](https://github.com/boccchi2993/locus-runtime/blob/main/TODO.md) for intermittent CDP readiness failures.
- Keep this separate from HN-TEST-001 and from Python E3/B-PY1. Root cause remains unknown; green reruns do not establish cause.
