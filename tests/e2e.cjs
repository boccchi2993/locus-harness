// E2E orchestrator: build the packaged harness host, serve dist/ over a
// preview server, run the browser gate, clean up. (npm run test:e2e)
// HARNESS_E2E_PORT overrides the preview port (default 4173 — the same
// port the npm preview script uses). The bind goes through
// startServiceWithRetry: an EADDRINUSE (the allocateFreePort release/rebind
// race, or any other listener on the port) retries on a freshly allocated
// port — at most 3 times, BEFORE any gate runs — and the host-page URL
// follows the port the server actually bound.
const { spawnSync } = require('child_process');
const path = require('path');
const {
  closeManagedProcess,
  isProcessAlive,
  launchManagedProcess,
  startServiceWithRetry,
  waitForHttp,
} = require('./helpers/chrome.cjs');

const PORT = Number(process.env.HARNESS_E2E_PORT || 4173);
const VITE_CLI = path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');
const root = path.join(__dirname, '..');

// TEST-ONLY seams (HN-TEST-001): HARNESS_E2E_GATE_PATH swaps the gate entry
// script and HARNESS_E2E_GATE_CMD swaps the gate executable, so that
// tests/e2e-orchestrator.test.cjs can drive controlled child outcomes
// (explicit zero / nonzero exit / signal / spawn error) through this real
// orchestrator. Both variables are unset in every real run, where the
// effective gate command stays exactly `node tests/e2e-harness-host.cjs`,
// as before the seams existed.
const GATE_CMD = process.env.HARNESS_E2E_GATE_CMD || process.execPath;
const GATE_PATH = process.env.HARNESS_E2E_GATE_PATH || path.join(__dirname, 'e2e-harness-host.cjs');

async function main() {
  process.stdout.write('[e2e] building packaged artifacts...\n');
  const build = spawnSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    process.exitCode = build.status || 1;
    return;
  }

  process.stdout.write('[e2e] starting preview on port ' + PORT + '...\n');
  let preview = null;
  let gateStatus = 1;
  try {
    const service = await startServiceWithRetry(async (port) => {
      const child = launchManagedProcess(process.execPath, [
        VITE_CLI, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
      ], { cwd: root, port, label: 'vite preview (harness host)' });
      try {
        await waitForHttp('http://127.0.0.1:' + port + '/tests/harness-host.html', { process: child, timeoutMs: 20000 });
      } catch (e) {
        // Retry ONLY the bind race: the child died with EADDRINUSE in its
        // output. Any other readiness failure is rethrown untouched.
        const raced = !isProcessAlive(child)
          && /EADDRINUSE|address already in use/.test(child.stderrTail + '\n' + child.stdoutTail);
        await closeManagedProcess(child);
        if (raced) {
          const bindError = new Error('vite preview could not bind port ' + port + ' (EADDRINUSE)');
          bindError.code = 'EADDRINUSE';
          throw bindError;
        }
        throw e;
      }
      return child;
    }, PORT);
    preview = service.handle;
    if (service.port !== PORT) {
      process.stdout.write('[e2e] preview bound to port ' + service.port
        + ' (ports tried: ' + service.portsTried.join(', ') + ')\n');
    }
    const hostUrl = process.env.E2E_HARNESS_HOST_URL
      || ('http://127.0.0.1:' + service.port + '/tests/harness-host.html');
    const gate = spawnSync(GATE_CMD, [GATE_PATH],
      { stdio: 'inherit', env: Object.assign({}, process.env, { E2E_HARNESS_HOST_URL: hostUrl }) });
    // HN-TEST-001: only an explicit zero child exit status, with no spawn
    // error and no termination signal, is success. `gate.status || 0` used
    // to promote status null (signal kill, spawn error) to exit 0 and
    // report the whole round as green.
    if (gate.error || gate.signal || gate.status !== 0) {
      process.stderr.write('[e2e] gate FAILED' +
        ' status=' + (gate.status === null ? 'null' : String(gate.status)) +
        ' signal=' + (gate.signal || 'none') +
        ' error=' + (gate.error ? gate.error.code + ' ' + gate.error.message : 'none') + '\n');
      gateStatus = gate.status || 1;
    } else {
      gateStatus = 0;
    }
  } catch (error) {
    // A preview that never became ready (bind-retry exhaustion included)
    // fails the round loudly before any gate ran — it must never be
    // promoted to a green gate.
    process.stderr.write('[e2e] preview FAILED: ' + (error && error.stack || error) + '\n');
    gateStatus = 1;
  } finally {
    // Runs on every path: gate success, nonzero exit, signal termination,
    // spawn error, and a preview that never became reachable.
    if (preview) await closeManagedProcess(preview);
  }
  process.exitCode = gateStatus;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
