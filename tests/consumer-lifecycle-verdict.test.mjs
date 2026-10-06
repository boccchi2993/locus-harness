// Shared consumer lifecycle verdict — deterministic Node test (M3b review
// round 1, F2 step 3). The verdict module is the ONE key-assertion set for
// both the normal consumer gate and the fault self-proof; this suite pins
// its logic without a browser: the clean observation passes, and each
// directed fault shape is rejected by exactly the expected key. The
// browser-level proof that the real wrappers trigger these shapes lives in
// the consumer fault page (tools/consumer-e2e/e2e-consumer-faults.cjs).
// Run: node tests/consumer-lifecycle-verdict.test.mjs

import { assessTaskLifecycle, FAULT_EXPECTED_KEYS } from '../tools/consumer-e2e/lifecycle-verdict.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

function cleanObservation() {
  return {
    fault: null,
    faultInjected: false,
    entered: true,
    timeouts: [],
    preRelease: {
      endedSettled: false,
      taskEndPublished: false,
      secondSubmitAccepted: false,
      runExited: false,
    },
    postRelease: {
      endedReason: 'cancelled',
      taskStartCount: 1,
      taskEndCount: 1,
      taskEndReason: 'cancelled',
      runExited: true,
      admissionReopened: true,
      followUpCompleted: true,
      followUpReason: 'rejected',
      lateTerminationEvents: 0,
      unhandledRejections: 0,
    },
  };
}

const keys = (obs) => assessTaskLifecycle(obs).failures.map((f) => f.key);

// ---- the clean control passes every key ----
{
  const v = assessTaskLifecycle(cleanObservation());
  check('V0 the clean control observation passes the shared verdict',
    v.pass === true, JSON.stringify(v.failures));
}

// ---- barrier failures ----
{
  const obs = cleanObservation();
  obs.entered = false;
  check('V1 a run that never reached the park point fails the entered barrier',
    keys(obs).includes('entered'), JSON.stringify(keys(obs)));
  const obs2 = cleanObservation();
  obs2.timeouts = ['ended-settled'];
  check('V2 an expired labeled bounded wait fails no-timeouts',
    keys(obs2).includes('no-timeouts'), JSON.stringify(keys(obs2)));
}

// ---- pre-release fault shapes (the directed self-proof targets) ----
{
  const obs = cleanObservation();
  obs.fault = 'early-ended';
  obs.preRelease.endedSettled = true;
  check('V3 fault A (caller-visible ended settles early) is rejected by pre-release.ended-unsettled',
    keys(obs).includes('pre-release.ended-unsettled'), JSON.stringify(keys(obs)));
  check('V3b fault A is rejected by its expected key and nothing else',
    JSON.stringify(keys(obs)) === JSON.stringify(FAULT_EXPECTED_KEYS['early-ended']),
    JSON.stringify({ expected: FAULT_EXPECTED_KEYS['early-ended'], got: keys(obs) }));
}
{
  const obs = cleanObservation();
  obs.fault = 'early-admission';
  obs.preRelease.secondSubmitAccepted = true;
  check('V4 fault B (a submit accepted while parked) is rejected by pre-release.admission-closed',
    keys(obs).includes('pre-release.admission-closed'), JSON.stringify(keys(obs)));
  check('V4b fault B is rejected by its expected key and nothing else',
    JSON.stringify(keys(obs)) === JSON.stringify(FAULT_EXPECTED_KEYS['early-admission']),
    JSON.stringify({ expected: FAULT_EXPECTED_KEYS['early-admission'], got: keys(obs) }));
}
{
  const obs = cleanObservation();
  obs.fault = 'early-task-end';
  obs.preRelease.taskEndPublished = true;
  check('V5 fault C (task_end published before release, exactly-once kept) is rejected by pre-release.no-task-end',
    keys(obs).includes('pre-release.no-task-end'), JSON.stringify(keys(obs)));
  check('V5b fault C is rejected by its expected key and nothing else',
    JSON.stringify(keys(obs)) === JSON.stringify(FAULT_EXPECTED_KEYS['early-task-end']),
    JSON.stringify({ expected: FAULT_EXPECTED_KEYS['early-task-end'], got: keys(obs) }));
}

// ---- post-release facts ----
{
  const cases = [
    ['endedReason', 'session_changed', 'post-release.ended-cancelled'],
    ['taskStartCount', 2, 'post-release.one-task-start'],
    ['taskEndCount', 0, 'post-release.one-task-end'],
    ['taskEndReason', 'error', 'post-release.one-task-end'],
    ['runExited', false, 'post-release.run-exited'],
    ['admissionReopened', false, 'post-release.admission-reopened'],
    ['followUpReason', 'completed', 'post-release.follow-up-completed'],
    ['lateTerminationEvents', 2, 'post-release.no-late-termination'],
    ['unhandledRejections', 1, 'post-release.no-unhandled-rejections'],
  ];
  for (const [field, value, expectedKey] of cases) {
    const obs = cleanObservation();
    obs.postRelease[field] = value;
    check('V6 ' + field + '=' + JSON.stringify(value) + ' fails ' + expectedKey,
      keys(obs).includes(expectedKey), JSON.stringify(keys(obs)));
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
