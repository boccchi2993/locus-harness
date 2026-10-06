// Standalone HARNESS HOST browser e2e (M3b — adapted from the source
// repository's tests/e2e-harness-host.cjs at
// 2aec76e78431382873be1db8a6db6310cc89c782, blob
// 22287f7423865448cf9061e9e7298bb27b30bde0) — real build, real Chrome,
// the packaged public entry.
//
// Drives dist/tests/harness-host.html (a REAL vite build input): the page
// imports ONLY src/index.js (the public package entry) as one ES module.
// Proves, on the packaged artifacts:
//   H0   the harness host page is ready with zero page errors;
//   H0b  the page carries ZERO classic scripts (pure module import);
//   H0c  NO core table exists (the M3b deletion), the no-assembly
//        compat shim resolves to undefined, the public declaration is
//        v1 with NO registryVersion field, and no Locus product DOM;
//   R    the loaded resource set contains ONLY the harness host page
//        and its single entry chunk — NO Runtime/Product chunk, no
//        classic dist/src scripts, no product CSS, no CDN;
//   T1   a complete native tool → result → final answer task runs;
//   T2   strict text-fallback rules hold (prose-wrapped fence is plain
//        text; a pure fence executes exactly once);
//   T3   a parked task is cancelled through the session;
//   T4   provider-session restore runs against an in-memory store with
//        the harness's REAL replay validators (valid restore + corrupt
//        tail → checkpoint_beyond_tail + replay blocked).
// Run: node tests/e2e-harness-host.cjs   (E2E_HARNESS_HOST_URL or the default preview URL)
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const HOST_URL = process.env.E2E_HARNESS_HOST_URL || 'http://127.0.0.1:4173/tests/harness-host.html';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const line = (cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 400) : '');
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

// The ONLY resources a standalone harness host may load: the page itself,
// the browser-automatic favicon, and its ONE entry chunk (the whole
// implementation graph is a single static ESM chunk — the M2b-era
// dynamic-import self-assembly chunk is gone). Anything else — a product
// main chunk/CSS, a runtime chunk, a copied classic dist/src script, any
// CDN — is a boundary violation.
function resourceVerdict(names) {
  const violations = [];
  const allowed = [];
  for (const full of names) {
    const name = full.replace(/^https?:\/\/[^/]+\//, '');
    if (name === 'tests/harness-host.html' || name === 'harness-host.html') { allowed.push(name); continue; }
    if (name === 'favicon.ico') { allowed.push(name); continue; } // browser-automatic
    if (/^assets\/harnessHost-[A-Za-z0-9_-]+\.js$/.test(name)) { allowed.push(name); continue; }
    violations.push(name);
  }
  return { allowed, violations };
}

async function main() {
  let chrome = null;
  let cdp = null;
  let profileDir = null;
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-harness-host-profile-'));
    chrome = await launchChrome(HOST_URL, {
      chromePath: process.env.CHROME,
      label: 'harness-host Chrome',
      profileDir,
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, HOST_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, 'document.title === "harness-host-ready"',
      { process: chrome, phase: 'harness-host-boot', timeoutMs: 15000 });
    check('H0 the standalone harness host page is ready', true);

    const results = await evaluate(cdp, 'window.__harnessHost');
    check('H0b the page carries ZERO classic scripts (pure module import)',
      results.assembly.classicScriptTags === 0, JSON.stringify(results.assembly));
    check('H0c no core table, shim resolves undefined, declaration v1 without registryVersion, no product DOM',
      results.assembly.registryPresent === false && results.assembly.shimResolved === true
      && results.assembly.contractVersion === 1 && results.assembly.registryVersionField === false
      && results.assembly.domProductNodes === 0,
      JSON.stringify(results.assembly));

    // ---- R: the loaded resource set is harness-only ----
    const names = await evaluate(cdp, 'window.__harnessHost.resources()');
    const verdict = resourceVerdict(names);
    check('R every loaded resource is the harness host page or its single entry chunk',
      verdict.violations.length === 0,
      JSON.stringify({ violations: verdict.violations, allowed: verdict.allowed }));
    check('Rb exactly one harness entry chunk loaded (no self-assembly/dynamic chunks)',
      verdict.allowed.filter((n) => /assets\/harnessHost-/.test(n)).length === 1,
      JSON.stringify(verdict.allowed));

    // ---- T1: native tool → tool result → final answer ----
    const nat = results.native;
    check('T1 the full native tool task ran (events, execution, replay history)',
      nat.chain === 'task_start,tool_call,tool_result,assistant_text,task_end'
      && nat.execs.length === 1 && nat.execs[0][0] === 'lookup' && nat.execs[0][1] === 'q1'
      && nat.requestTools.length === 1 && nat.requestTools[0] === 'lookup'
      && nat.historyRoles.join(',') === 'user,assistant,tool_result,assistant'
      && nat.toolCallId === 't1'
      && nat.finalText === 'final answer after tool',
      JSON.stringify(nat));

    // ---- T2: strict text fallback ----
    const fb = results.textFallback;
    check('T2 strict text fallback: prose-wrapped fence is plain text; pure fence executes once',
      fb.proseExecuted === 0 && fb.proseIsPlainText === true
      && fb.fencedExecuted.join(',') === 'fenced' && fb.fencedCompleted === true,
      JSON.stringify(fb));

    // ---- T3: cancellation ----
    check('T3 a parked task cancels through the session',
      results.cancel.cancelled === true && results.cancel.chain === 'task_start,warning,task_end',
      JSON.stringify(results.cancel));

    // ---- T4: REAL replay validation over the in-memory store ----
    const rp = results.replay;
    check('T4 a valid raw prefix restores through the REAL validators',
      rp.validRestore.id === 'provider-session-host' && rp.validRestore.blocked === false
      && rp.validRestore.historyRoles.join(',') === 'user,assistant,tool_result'
      && rp.validRestore.toolCallId === 'call-1',
      JSON.stringify(rp.validRestore));
    check('T4b a tail corrupted behind the checkpoint is rejected by code and blocks replay',
      rp.invalidRestore.rawInvalid === true && rp.invalidRestore.code === 'checkpoint_beyond_tail'
      && rp.invalidRestore.blocked === true,
      JSON.stringify(rp.invalidRestore));
    check('T4c the entry validator export runs in the browser',
      rp.directValid === true, JSON.stringify(rp.directValid));

    // ---- console hygiene ----
    check('H1 zero page errors / unhandled rejections',
      (await evaluate(cdp, 'window.__harnessHost.errors.length')) === 0,
      JSON.stringify(results.errors));
  } catch (e) {
    console.error('HARNESS-HOST-E2E ERROR:', e && e.stack || e);
    failed++;
  } finally {
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('harness-host Chrome did not exit after bounded cleanup');
    }
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
