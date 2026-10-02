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

async function main() {
  process.stdout.write('[e2e] building packaged artifacts...\n');
  const build = spawnSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) process.exit(build.status || 1);

  process.stdout.write('[e2e] starting preview on port ' + PORT + '...\n');
  const preview = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' });
  let gateStatus = 1;
  try {
    await waitForServer(HOST_URL, 20000);
    const gate = spawnSync(process.execPath, [path.join(__dirname, 'e2e-harness-host.cjs')],
      { stdio: 'inherit', env: Object.assign({}, process.env, { E2E_HARNESS_HOST_URL: HOST_URL }) });
    gateStatus = gate.status || 0;
  } finally {
    preview.kill();
    if (process.platform === 'win32') {
      try { spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F']); } catch (e) {}
    }
  }
  process.exit(gateStatus);
}

main().catch((e) => { console.error(e); process.exit(1); });
