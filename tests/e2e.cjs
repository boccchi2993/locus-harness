// E2E orchestrator: build the packaged harness host, serve dist/ over a
// preview server, run the browser gate, clean up. (npm run test:e2e)
// HARNESS_E2E_PORT overrides the preview port (default 4173 — the same
// port the npm preview script uses); the host-page URL follows it.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.HARNESS_E2E_PORT || 4173);
const HOST_URL = process.env.E2E_HARNESS_HOST_URL || ('http://127.0.0.1:' + PORT + '/tests/harness-host.html');
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

function waitForServer(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error('preview server not ready: ' + url));
        else setTimeout(probe, 300);
      });
    };
    probe();
  });
}

function stopPreview(preview) {
  // On Windows the preview runs behind cmd.exe (shell: true) — killing
  // cmd.exe first orphans the vite child, so the tree kill must come first.
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F']); } catch (e) {}
  }
  preview.kill();
}

async function main() {
  process.stdout.write('[e2e] building packaged artifacts...\n');
  const build = spawnSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    process.exitCode = build.status || 1;
    return;
  }

  process.stdout.write('[e2e] starting preview on port ' + PORT + '...\n');
  const preview = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' });
  let gateStatus = 1;
  try {
    await waitForServer(HOST_URL, 20000);
    const gate = spawnSync(GATE_CMD, [GATE_PATH],
      { stdio: 'inherit', env: Object.assign({}, process.env, { E2E_HARNESS_HOST_URL: HOST_URL }) });
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
  } finally {
    // Runs on every path: gate success, nonzero exit, signal termination,
    // spawn error, and a preview that never became reachable.
    stopPreview(preview);
  }
  process.exitCode = gateStatus;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
