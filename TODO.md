# Maintenance TODO

The repository split is complete. The items below remain open maintenance work.

## HN-TEST-001: Reject signal-terminated browser gates

- [ ] Open; priority: fix before relying on new browser-orchestrator exit codes. Owner: Harness test infrastructure.
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
