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
- 进展 2026-10-30：product PR #52（CI-STAB，合并提交 a70c301）的修复与诊断（同 [runtime TODO RT-CI-001](https://github.com/boccchi2993/locus-runtime/blob/main/TODO.md) 下 2026-10-30 追记）：product 的 `tests/helpers/chrome.cjs` 改为 `--remote-debugging-port=0` + 读取 DevToolsActivePort、就绪等待 60 秒、服务端口 EADDRINUSE 重试；本节 2026-10-16 的证据（Chrome 启动后约 10–15 秒才打印 DevTools 监听行，与 15 秒就绪超时吻合）与该诊断一致。harness 的 `tests/chrome-helper.cjs` 尚未移植该修复。
- 进展 2026-10-31：harness 侧移植（PR 号见 `test/ci-port-chrome-readiness` 分支的 PR）。2026-10-31 main push run [41185934066](https://github.com/boccchi2993/locus-harness/actions/runs/41185934066)（合并提交 `bdb10db`，PR #15 之后）的同一 job `out-of-checkout tarball consumer (headless Chrome)` 再次以同签名失败，`--log-failed` 关键行：

  ```
  CONSUMER-E2E ERROR: Error: CDP browser endpoint unavailable: readiness timeout
  phase=cdp elapsedMs=15001
  Chrome alive=yes exitCode=null signal=none
  0 passed, 1 failed
  ```

  所有者决定不重跑、移植修复。本次把 product a70c301 的三项修复移植进 harness 的 `tests/helpers/chrome.cjs`（consumer job 拷贝为 `tests/chrome-helper.cjs`，同一文件覆盖两个入口）：Chrome `--remote-debugging-port=0` + 从 profile 目录 DevToolsActivePort 文件读取实际端口（消除 allocateFreePort 的释放/重绑竞态）、CDP 就绪等待默认 60 秒（`DEFAULT_CDP_TIMEOUT_MS`，显式传 15000 的 waitForCdp 调用点改用默认值）、服务端口 EADDRINUSE 换端口重试（`startServiceWithRetry`/`listenWithRetry`，最多 3 次，在任何检查执行之前）——覆盖 `tests/e2e.cjs` 的 vite preview 与 CI consumer job 的预览服务（新增 `tools/consumer-e2e/serve-consumer.cjs`）；并补 `tests/chrome-helper.test.cjs`（DevToolsActivePort 正常/迟到/内容异常解析、EADDRINUSE 第二次成功/三次耗尽的完整报错），注册进 `tests/run-unit.cjs`。按本节原有验收标准，仅加超时不能关单：本次是移植 port 0 / DevToolsActivePort 消除端口竞态并加超时兜底，待合并后观察一段时间再由所有者决定是否关单。

## 2026-10-30 新增条目

### HN-CI-NODE24（harness）：GitHub Actions "Node.js 20 is deprecated" 警告

- [ ] Open. Owner: Harness CI。
- 现状：GitHub Actions 每次运行都有 "Node.js 20 is deprecated" 警告：actions/checkout@v4、actions/setup-node@v4、actions/upload-artifact@v4 被强制以 Node 24 运行。
- 下一步：三个仓库各需升级 action 版本（product 侧见 product TODO 的 CI-NODE24 条目）。
- 验收：CI 运行不再出现该 deprecation 警告。
