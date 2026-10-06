// Lifecycle fault SELF-PROOF driver (M3b review round 1 — F2 step 3).
// Real Chrome over the consumer's own BUILD of the packaged tarball: the
// fault page runs the SHARED lifecycle scenario as control + three
// directed faults, and THIS driver requires the SHARED verdict to
//   - PASS the clean control, and
//   - REJECT every fault with its expected key assertion.
// A fault whose wrapper did not actually inject (faultInjected === false)
// is a FAILURE of the proof — "the injection did not take effect" is never
// counted as a detection success. The actual failing key list of every run
// is printed so the report carries the real rejection evidence.
// Run: node tests/e2e-consumer-faults.cjs  (CONSUMER_FAULTS_URL or the default preview URL)
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./chrome-helper.cjs');

const HOST_URL = process.env.CONSUMER_FAULTS_URL || 'http://127.0.0.1:4931/faults.html';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const line = (cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 500) : '');
  console.log(line);
  if (cond) passed++; else failed++;
}

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 120000,
  });
  if (result?.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

async function main() {
  let chrome = null, cdp = null, profileDir = null;
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-consumer-faults-profile-'));
    chrome = await launchChrome(HOST_URL, {
      chromePath: process.env.CHROME,
      label: 'consumer-faults Chrome',
      profileDir,
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, HOST_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, 'document.title === "faults-ready"',
      { process: chrome, phase: 'consumer-faults-boot', timeoutMs: 15000 });
    check('F0 the fault self-proof page is ready (packaged tarball, public entry only)', true);

    const r = await evaluate(cdp, 'window.__faults');
    const faults = ['early-ended', 'early-admission', 'early-task-end'];

    // ---- control: the clean run passes the SHARED verdict ----
    const control = r.runs.control || {};
    check('S0 the control (no fault) passes the shared lifecycle verdict',
      control.verdict && control.verdict.pass === true,
      JSON.stringify({ crash: control.crash, failures: control.verdict && control.verdict.failures }));

    // ---- each directed fault is REJECTED by its expected key ----
    for (const fault of faults) {
      const run = r.runs[fault] || {};
      const expected = (r.expectedKeys && r.expectedKeys[fault]) || [];
      const gotKeys = (run.verdict && run.verdict.failures || []).map((f) => f.key);
      check('S-' + fault + ' the injection actually took effect (never counted as detection)',
        run.observation && run.observation.faultInjected === true,
        JSON.stringify({ faultInjected: run.observation && run.observation.faultInjected, crash: run.crash }));
      check('S-' + fault + ' the shared verdict REJECTS it with the expected key '
        + '(actual rejections: ' + (gotKeys.join(', ') || 'NONE') + ')',
        run.verdict && run.verdict.pass === false
        && expected.every((k) => gotKeys.includes(k)),
        JSON.stringify({ expected, gotKeys, crash: run.crash }));
    }

    // ---- page hygiene: the fault wrappers leak nothing ----
    check('S9 zero page errors / unhandled rejections across all four runs',
      (r.errors || []).length === 0,
      JSON.stringify(r.errors));
  } catch (e) {
    console.error('CONSUMER-FAULTS ERROR:', e && e.stack || e);
    failed++;
  } finally {
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('consumer-faults Chrome did not exit after bounded cleanup');
    }
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
