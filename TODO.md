# Maintenance TODO

The repository split is complete. The items below remain open maintenance work.

## HN-TEST-001: Reject signal-terminated browser gates

- [x] Closed 2026-10-12 in PR #2. Owner: Harness test infrastructure.
- Fix commit: [e37a9ee](https://github.com/boccchi2993/locus-harness/commit/e37a9eefa27f93537c170ffb2b5d8df7a6bca915) — success now requires `status === 0` with no termination signal and no spawn error; every other outcome prints status/signal/error and exits nonzero; preview cleanup stays in the `finally` on every path (and on Windows the tree kill now runs while the shell wrapper is alive — the old order orphaned vite and left the port listening).
- Tests: `tests/e2e-orchestrator.test.cjs` (registered in the `npm test` SUITES list) drives the real `tests/e2e.cjs` through the TEST-ONLY `HARNESS_E2E_GATE_PATH` / `HARNESS_E2E_GATE_CMD` seams for exit 0 / nonzero / signal / spawn-error results.
- Evidence: pre-fix failure output (14 failing checks, preview-port leaks included; the exit3 case kept its exit code 3 — only the `status: null` cases were promoted to a false success: spawn-error on every platform, signal on POSIX — on the Windows evidence run the signal case degraded to a nonzero hard exit 1) and post-fix pass output are in the PR #2 description; PR-branch CI run [38230808236](https://github.com/boccchi2993/locus-harness/actions/runs/38230808236) — the unit job runs the four classification cases on ubuntu-24.04 (the POSIX `signal=SIGTERM` assertion included), the built-host browser gate and the out-of-checkout consumer job pass unchanged.
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
- Evidence 2026-10-16: run [38944406565](https://github.com/boccchi2993/locus-harness/actions/runs/38944406565) attempt 1 (PR #7, commit `352a876`), job `out-of-checkout tarball consumer (headless Chrome)`, step `serve + run the consumer browser gate (gates A–J+K)` exited 1 in the CDP readiness phase before any gate ran. Diagnostic tail from `--log-failed`:

  ```
  CONSUMER-E2E ERROR: Error: CDP browser endpoint unavailable: readiness timeout
  phase=cdp elapsedMs=15186
  Chrome executable=/usr/bin/google-chrome
  PID=2497 alive=yes exitCode=null signal=none
  debug port=40393 url=http://127.0.0.1:4931/
  /json/version result: unavailable: This operation was aborted
  /json/list snapshot: unavailable: This operation was aborted
  stderr tail: repeated dbus/bus.cc connect errors (routine headless-runner noise),
  then "DevTools listening on ws://127.0.0.1:40393/..." printed between the
  18:04:18.7Z and 18:04:23.8Z stderr timestamps
  0 passed, 1 failed
  ```

- Same event, classification and rerun evidence: (a) browser/CDP startup or readiness failure — the same intermittent CDP readiness class this section tracks via [RT-CI-001](https://github.com/boccchi2993/locus-runtime/blob/main/TODO.md). Rationale: the error is the harness's own `readinessError` diagnostic (`tests/chrome-helper.cjs`) raised at `phase=cdp` (`elapsedMs=15186`) before any gate executed (`0 passed, 1 failed` is the phase verdict, not an assertion result), so it is not a test-assertion failure; the same job's npm pack / consumer assemble / install / build steps all succeeded in attempt 1, so it is not a network or npm failure; Chrome stayed alive (`alive=yes exitCode=null signal=none`) but first printed its DevTools-listening line roughly 10–15s after launch, i.e. at/after the ~15s readiness probe had already aborted its `/json/version` and `/json/list` fetches. Rerun: the first failure was rerun within about 2 minutes and the rerun passed — attempt 2 started 18:05:21Z (attempt 1 began 18:03:28Z, the job itself failed ~18:04:29Z) and passed every step of the same job on the same commit, including the browser gate and the lifecycle fault self-proof; the post-merge main run [38946302420](https://github.com/boccchi2993/locus-harness/actions/runs/38946302420) also passed all four jobs. Per this section's discipline, green reruns do not establish cause.
