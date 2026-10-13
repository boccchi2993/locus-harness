// HN-TEST-001: classification tests for the real e2e orchestrator.
//
// Each case below runs tests/e2e.cjs — the very script `npm run test:e2e`
// runs, build + preview server included — with the browser gate swapped out
// through the TEST-ONLY seams documented there (HARNESS_E2E_GATE_PATH /
// HARNESS_E2E_GATE_CMD), then asserts on the orchestrator's own exit code
// and diagnostics. The success classification lives only in tests/e2e.cjs;
// this file feeds controlled child outcomes and observes the parent — it
// never re-implements the classification.
//
// The four cases:
//   exit 0       fixture selected via HARNESS_E2E_GATE_FIXTURE=exit0 — the
//                gate child exits 0; the orchestrator must exit 0.
//   nonzero exit fixture HARNESS_E2E_GATE_FIXTURE=exit3 — the gate child
//                exits 3; the orchestrator must exit nonzero and print
//                status=3 / signal=none / error=none diagnostics.
//   signal       fixture HARNESS_E2E_GATE_FIXTURE=signal — the gate child
//                terminates itself with SIGTERM, so spawnSync reports
//                { status: null, signal: 'SIGTERM' } on POSIX; the
//                orchestrator must exit nonzero and report signal=SIGTERM.
//                On Windows the same self-kill degrades to a nonzero hard
//                exit (status 1, no signal), so only the nonzero-parent-exit
//                and FAILED-diagnostic assertions run there.
//   spawn error  HARNESS_E2E_GATE_CMD points at a nonexistent executable, so
//                spawnSync itself fails ({ status: null, error: ENOENT });
//                the orchestrator must exit nonzero and report status=null /
//                error=ENOENT.
// On Windows the test additionally probes the preview port after every run:
// the orchestrator must not leave the server listening (taskkill /T makes
// that deterministic there). On POSIX the npx→vite grandchild makes that
// probe unreliable, so cleanup there is covered by the finally block that
// tests/e2e.cjs retains on every path.
const { spawnSync } = require('child_process');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
const e2eScript = path.join(__dirname, 'e2e.cjs');
const fixture = path.join(__dirname, 'helpers', 'e2e-gate-fixture.cjs');
const missingGateCmd = path.join(__dirname, 'helpers', 'no-such-gate-executable');
const POSIX = process.platform !== 'win32';

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log('  ok ' + label);
  else {
    failures++;
    console.error('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

function runOrchestrator(name, port, seamEnv) {
  const startedAt = Date.now();
  const r = spawnSync(process.execPath, [e2eScript], {
    cwd: root,
    env: Object.assign({}, process.env, seamEnv, { HARNESS_E2E_PORT: String(port) }),
    encoding: 'utf8',
    timeout: 240000,
  });
  const secs = Math.round((Date.now() - startedAt) / 1000);
  console.log('[case ' + name + '] orchestrator exit=' + r.status +
    (r.signal ? ' signal=' + r.signal : '') + ' (' + secs + 's)');
  return r;
}

function combinedOutput(r) {
  return (r.stdout || '') + '\n' + (r.stderr || '');
}

function probeOnce(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/' }, (res) => {
      res.resume();
      resolve(false); // something is still serving the port
    });
    req.on('error', () => resolve(true)); // connection refused → gone
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function portClosed(port) {
  for (let i = 0; i < 5; i++) {
    if (await probeOnce(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function main() {
  const gateSeam = { HARNESS_E2E_GATE_PATH: fixture };
  const cases = [
    { name: 'exit0', port: 4591,
      seam: Object.assign({ HARNESS_E2E_GATE_FIXTURE: 'exit0' }, gateSeam) },
    { name: 'exit3', port: 4592,
      seam: Object.assign({ HARNESS_E2E_GATE_FIXTURE: 'exit3' }, gateSeam) },
    { name: 'signal', port: 4593,
      seam: Object.assign({ HARNESS_E2E_GATE_FIXTURE: 'signal' }, gateSeam) },
    { name: 'spawn-error', port: 4594,
      seam: { HARNESS_E2E_GATE_CMD: missingGateCmd } },
  ];

  for (const c of cases) {
    console.log('[case ' + c.name + ']');
    const r = runOrchestrator(c.name, c.port, c.seam);
    const out = combinedOutput(r);

    if (c.name === 'exit0') {
      check('parent exits 0', r.status === 0,
        'exit=' + r.status + ' signal=' + r.signal);
      check('no failure diagnostics', out.indexOf('[e2e] gate FAILED') === -1);
    } else {
      check('parent exits nonzero', typeof r.status === 'number' && r.status !== 0,
        'exit=' + r.status + ' signal=' + r.signal);
      check('failure diagnostics printed', out.indexOf('[e2e] gate FAILED') !== -1,
        'output tail: ' + out.slice(-400).replace(/\s+/g, ' '));
    }

    if (c.name === 'exit3') {
      check('status=3 reported', /status=3\b/.test(out));
      check('signal=none reported', /signal=none/.test(out));
      check('error=none reported', /error=none/.test(out));
    }
    if (c.name === 'signal') {
      if (POSIX) check('SIGTERM reported', /signal=SIGTERM/.test(out));
      else check('win32 hard exit reported (SIGTERM degrades to status 1)', /status=1\b/.test(out));
    }
    if (c.name === 'spawn-error') {
      check('status=null reported', /status=null/.test(out));
      check('spawn error (ENOENT) reported', /error=ENOENT/.test(out));
    }

    if (!POSIX) {
      check('preview server cleaned up (port ' + c.port + ' closed)',
        await portClosed(c.port));
    }
  }

  if (failures) {
    console.error(failures + ' check(s) FAILED');
    process.exit(1);
  }
  console.log('all e2e-orchestrator classification cases passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
