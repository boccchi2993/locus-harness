// Out-of-checkout CONSUMER browser gate (M3b) — real Chrome over the
// consumer's own BUILD of the packaged locus-harness tarball.
// Proves the packaged public entry end to end: gates A–J. The consumer
// installs the real tarball into ITS OWN node_modules and imports ONLY
// 'locus-harness'; this driver asserts behavior and the loaded-resource
// boundary on the built artifact.
// Run: node tests/e2e-consumer.cjs  (CONSUMER_URL or the default preview URL)
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./chrome-helper.cjs');

const HOST_URL = process.env.CONSUMER_URL || 'http://127.0.0.1:4931/';

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

function resourceVerdict(names) {
  const violations = [];
  const allowed = [];
  for (const full of names) {
    const name = full.replace(/^https?:\/\/[^/]+\//, '');
    if (name === '' || name === 'index.html') { allowed.push('index.html'); continue; }
    if (name === 'favicon.ico') { allowed.push(name); continue; } // browser-automatic
    if (/^assets\/index-[A-Za-z0-9_-]+\.js$/.test(name)) { allowed.push(name); continue; }
    violations.push(name);
  }
  return { allowed, violations };
}

async function main() {
  let chrome = null, cdp = null, profileDir = null;
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-consumer-profile-'));
    chrome = await launchChrome(HOST_URL, {
      chromePath: process.env.CHROME,
      label: 'consumer Chrome',
      profileDir,
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, HOST_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, 'document.title === "consumer-ready"',
      { process: chrome, phase: 'consumer-boot', timeoutMs: 15000 });
    check('H0 the consumer page is ready (packaged tarball, public entry only)', true);

    const r = await evaluate(cdp, 'window.__consumer');

    // ---- A ----
    check('A native tool → ToolPort → result → final answer',
      r.A.chain === 'task_start,tool_call,tool_result,assistant_text,task_end'
      && r.A.execs.length === 1 && r.A.execs[0][0] === 'lookup' && r.A.execs[0][1] === 'qA'
      && r.A.requestTools.join(',') === 'lookup' && r.A.toolCallId === 'tA'
      && r.A.finalText === 'final answer A' && r.A.ended,
      JSON.stringify(r.A));

    // ---- B ----
    check('B strict text fallback completes a REAL tool round trip',
      r.B.executed.join(',') === 'fenced-B' && r.B.feedbackCarried === true
      && r.B.request2HadNoToolRole === true && r.B.completed === true,
      JSON.stringify(r.B));

    // ---- C ----
    check('C TaskRunner prepare→run→cancel with exactly-once termination',
      r.C.prepareStartedRun === true && r.C.endsBeforeCancel === 0
      && r.C.outcomeReason === 'cancelled' && r.C.exactlyOneEnd === true
      && r.C.admissionReopenedAfterBoundary === true && r.C.outcome2Reason === 'rejected'
      && r.C.startEvents === 1,
      JSON.stringify(r.C));

    // ---- D ----
    check('D memory store + REAL adapter + REAL validators restore',
      r.DE.dValid.id === 'provider-session-consumer' && r.DE.dValid.blocked === false
      && r.DE.dValid.roles.join(',') === 'user,assistant,tool_result'
      && r.DE.dValid.toolCallId === 'call-D',
      JSON.stringify(r.DE.dValid));

    // ---- E ----
    check('E corrupted tail rejected by code (checkpoint_beyond_tail) and replay blocked',
      r.DE.eTail.rawInvalid === true && r.DE.eTail.code === 'checkpoint_beyond_tail' && r.DE.eTail.blocked === true,
      JSON.stringify(r.DE.eTail));
    check('E2 dangling tool result rejected (tool_result_unpaired) and replay blocked',
      r.DE.ePair.rawInvalid === true && r.DE.ePair.code === 'tool_result_unpaired' && r.DE.ePair.blocked === true,
      JSON.stringify(r.DE.ePair));
    check('E3 the direct validator export rejects a bad checkpoint',
      r.DE.directCode === 'checkpoint_beyond_tail', JSON.stringify(r.DE.directCode));

    // ---- F ----
    check('F1 a failed REQUIRED persistence prepare ends persistence_error with zero model requests',
      r.F1.reason === 'persistence_error' && r.F1.isPersistenceFailure === true
      && r.F1.modelRequests === 0 && r.F1.endEvents === 1,
      JSON.stringify(r.F1));
    check('F2 a required write failing mid-run ends persistence_error, zero further requests, zero executions',
      r.F2.endedPersistenceError === true && r.F2.errorEvent === true
      && r.F2.modelRequests === 1 && r.F2.zeroFurtherRequests === true && r.F2.toolExecutions === 0,
      JSON.stringify(r.F2));

    // ---- G ----
    check('G1 the run-level denial binding degrades HISTORY images; the real gate is untouched',
      r.G1.noImageOnWire === true && r.G1.noticeOnWire === true
      && r.G1.realGateUntouched === true && r.G1.completed === true,
      JSON.stringify(r.G1));
    check('G2 the next task (no override) sends the SAME history image normally again',
      r.G2.imageOnWire === true && r.G2.gateConsulted === true && r.G2.noticeGone === true,
      JSON.stringify(r.G2));

    // ---- H ----
    check('H capability composition happy path (enable → ready env → prompt index → payload valid)',
      r.H1.ready === true && r.H1.envKey === true && r.H1.promptCarriesIndex === true && r.H1.payloadValid === true,
      JSON.stringify(r.H1));
    check('H2 capability composition rejection path (traversal payload fails loudly)',
      r.H2.rejectCode === 'extension_resolution_failed', JSON.stringify(r.H2));

    // ---- I ----
    check('I two instances: configs, histories, runners and events never cross',
      r.I.aSawOwnBase === true && r.I.bSawOwnBase === true
      && r.I.historiesSeparate === true && r.I.outcomesSeparate === true && r.I.eventsSeparate === true,
      JSON.stringify(r.I));

    // ---- resource boundary ----
    const names = await evaluate(cdp, 'window.__consumer.resources()');
    const verdict = resourceVerdict(names);
    check('J every loaded resource is the consumer page or its own chunk (no Runtime/Product, no CDN)',
      verdict.violations.length === 0,
      JSON.stringify({ violations: verdict.violations, allowed: verdict.allowed }));

    // ---- console hygiene ----
    check('J2 zero page errors / unhandled rejections',
      (await evaluate(cdp, 'window.__consumer.errors.length')) === 0,
      JSON.stringify(r.errors));
  } catch (e) {
    console.error('CONSUMER-E2E ERROR:', e && e.stack || e);
    failed++;
  } finally {
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('consumer Chrome did not exit after bounded cleanup');
    }
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
