// SHARED consumer lifecycle verdict (M3b review round 1 — F2 step 3).
//
// The ONE set of key assertions for the cancel-around-a-parked-run
// boundary. Both consumers of this module run EXACTLY these assertions:
//   - the normal tarball-consumer gate (consumer-main.js scenario C), and
//   - the fault self-proof page (consumer-faults-main.js), which wraps the
//     SAME scenario with test-side faults and requires each directed fault
//     to be REJECTED by these very assertions.
// There is deliberately no second, stronger verdict for the self-proof:
// if a fault slips past this module, the gate is blind, not the proof.
//
// The module is pure logic over a plain observation object (no DOM, no
// timers), so the Node suite tests/consumer-lifecycle-verdict.test.mjs
// pins it deterministically without a browser.
//
// Observation contract (produced by lifecycle-scenario.js):
//   fault               null | 'early-ended' | 'early-admission' | 'early-task-end'
//   faultInjected       boolean  — did the wrapper actually inject?
//   entered             boolean  — the real run reached the park point
//   timeouts            [label]  — every labeled bounded wait that expired
//   preRelease   { endedSettled, taskEndPublished, secondSubmitAccepted, runExited }
//   postRelease  { endedReason, taskStartCount, taskEndCount, taskEndReason,
//                  runExited, admissionReopened, followUpCompleted,
//                  followUpReason, lateTerminationEvents, unhandledRejections }

export const FAULT_EXPECTED_KEYS = {
  // A. only the caller-visible `ended` settles early (at cancel, before the
  //    run is released; everything else stays real).
  'early-ended': ['pre-release.ended-unsettled'],
  // B. a new submit is ACCEPTED after cancel while the run is not released.
  'early-admission': ['pre-release.admission-closed'],
  // C. task_end is published early (at cancel) and never re-published —
  //    exactly-once kept, timing wrong.
  'early-task-end': ['pre-release.no-task-end'],
};

export function assessTaskLifecycle(obs) {
  const failures = [];
  const add = (key, detail) => failures.push({ key, detail: String(detail) });
  const o = obs || {};

  // Barriers: without them the boundary was never observed at all.
  if (o.entered !== true) add('entered', 'the run never reached the park point');
  if (Array.isArray(o.timeouts) && o.timeouts.length) {
    add('no-timeouts', 'bounded wait(s) expired: ' + o.timeouts.join(', '));
  }

  // Pre-release invariants (cancel observed, release NOT yet called):
  // the caller-visible boundary must still be open on every axis.
  const pre = o.preRelease || {};
  if (pre.endedSettled !== false) {
    add('pre-release.ended-unsettled',
      'caller-visible ended settled before release: ' + JSON.stringify(pre.endedSettled));
  }
  if (pre.taskEndPublished !== false) {
    add('pre-release.no-task-end',
      'task_end published before release: ' + JSON.stringify(pre.taskEndPublished));
  }
  if (pre.secondSubmitAccepted !== false) {
    add('pre-release.admission-closed',
      'a second submit was accepted while the run was parked: ' + JSON.stringify(pre.secondSubmitAccepted));
  }
  if (pre.runExited !== false) {
    add('pre-release.run-parked',
      'the parked run exited before release: ' + JSON.stringify(pre.runExited));
  }

  // Post-release facts (release called, boundary settled):
  const post = o.postRelease || {};
  if (post.endedReason !== 'cancelled') {
    add('post-release.ended-cancelled',
      'ended reason: ' + JSON.stringify(post.endedReason));
  }
  if (post.taskStartCount !== 1) {
    add('post-release.one-task-start', 'task_start count: ' + JSON.stringify(post.taskStartCount));
  }
  if (post.taskEndCount !== 1 || post.taskEndReason !== 'cancelled') {
    add('post-release.one-task-end',
      'task_end count/reason: ' + JSON.stringify(post.taskEndCount) + '/' + JSON.stringify(post.taskEndReason));
  }
  if (post.runExited !== true) {
    add('post-release.run-exited', 'the run body never returned past the park point');
  }
  if (post.admissionReopened !== true) {
    add('post-release.admission-reopened',
      'submit after the boundary returned: ' + JSON.stringify(post.admissionReopened));
  }
  if (post.followUpCompleted !== true || post.followUpReason !== 'rejected') {
    add('post-release.follow-up-completed',
      'follow-up outcome: ' + JSON.stringify(post.followUpReason));
  }
  if (post.lateTerminationEvents !== 0) {
    add('post-release.no-late-termination',
      'late duplicate start/end events after settlement: ' + JSON.stringify(post.lateTerminationEvents));
  }
  if (post.unhandledRejections !== 0) {
    add('post-release.no-unhandled-rejections',
      'unhandled rejection count: ' + JSON.stringify(post.unhandledRejections));
  }

  return { pass: failures.length === 0, failures };
}
