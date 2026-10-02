// Fault SELF-PROOF page script (M3b review round 1 — F2 step 3).
// Runs the SHARED lifecycle scenario over the REAL packaged TaskRunner
// surface: one clean control plus three directed test-side faults
// (wrappers — the production implementation is untouched):
//   early-ended     only the caller-visible `ended` settles early (at cancel)
//   early-admission a new submit is accepted while the run is parked
//   early-task-end  task_end published at cancel; never re-published
// The gate for every run is the SHARED verdict module — the same key
// assertions the normal consumer gate (consumer-main.js scenario C) uses.
// The old C gate (fixed 20 ms wait, release before any boundary assertion)
// accepted ALL THREE faults; the driver pins that this verdict rejects each.
import { createTaskRunner } from 'locus-harness';
import { runLifecycleScenario } from './lifecycle-scenario.js';
import { FAULT_EXPECTED_KEYS } from './lifecycle-verdict.js';

const errors = [];
let unhandledRejectionCount = 0;
window.addEventListener('error', (e) => errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => {
  errors.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason));
  unhandledRejectionCount++;
});

const results = { runs: {}, expectedKeys: FAULT_EXPECTED_KEYS, errors };

(async () => {
  for (const fault of [null, 'early-ended', 'early-admission', 'early-task-end']) {
    const key = fault || 'control';
    try {
      results.runs[key] = await runLifecycleScenario({
        createTaskRunner,
        unhandledRejections: () => unhandledRejectionCount,
      }, fault);
    } catch (e) {
      results.runs[key] = { crash: String((e && e.stack) || e) };
    }
  }
  results.ready = true;
  window.__faults = results;
  document.title = 'faults-ready';
})().catch((e) => {
  errors.push('boot failed: ' + (e && e.stack ? e.stack : String(e)));
  window.__faults = { ready: false, runs: results.runs, expectedKeys: FAULT_EXPECTED_KEYS, errors };
  document.title = 'faults-boot-failed';
});
