// SHARED consumer lifecycle scenario (M3b review round 1 — F2 steps 1+2).
//
// ONE scenario implementation for the cancel-around-a-parked-run boundary,
// run by BOTH the normal tarball-consumer gate (consumer-main.js, fault =
// null) and the fault self-proof page (consumer-faults-main.js, fault =
// 'early-ended' | 'early-admission' | 'early-task-end'). The faults are
// test-side wrappers around the REAL packaged TaskRunner surface — the
// production implementation is untouched and carries no test switches.
//
// Explicit barriers replace the old fixed setTimeout(20):
//   entered  — resolved when the real run body reached the park point;
//   release  — the test releases the park and lets the run settle for real.
// Every wait is bounded and labeled; a fault that wedges the flow fails
// its labeled timeout and the finally-block releases the park, so the
// driver can never hang CI.
//
// The REAL completion boundary is proven in this order:
//   submit → await entered → cancel → a clear scheduling turn →
//   PRE-RELEASE snapshot (caller ended unsettled / no task_end / a second
//   submit is rejected by the real admission contract — submit() returns
//   null — / the run still parked) → release → await ended →
//   post-release facts (cancelled outcome, exactly one task_start and one
//   task_end, run really exited, admission reopened, a follow-up task
//   completes, no late duplicate terminations, no unhandled rejections).
// Browser scheduling turns use MessageChannel — never a fixed sleep as
// proof that something "has" or "has not" happened yet.
import { assessTaskLifecycle } from './lifecycle-verdict.js';

const BOUNDED_MS = 5000;

// One browser macrotask turn.
function schedulerTurn() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

async function settle(turns) {
  for (let i = 0; i < turns; i++) await schedulerTurn();
}

// Bounded, labeled wait: poll the predicate once per scheduling turn.
async function waitForBounded(label, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || BOUNDED_MS);
  while (!(await predicate())) {
    if (Date.now() > deadline) return { ok: false, label };
    await schedulerTurn();
  }
  return { ok: true, label };
}

// Bounded, labeled await of one promise. The loser (timeout) never wins a
// real settlement: the result says which happened.
function awaitBounded(promise, label, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, label, timedOut: true }), timeoutMs || BOUNDED_MS);
  });
  return Promise.race([
    Promise.resolve(promise).then((value) => ({ ok: true, value, label })),
    timeout,
  ]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

// ---- test-side fault wrappers (never production code) ----
// phase(): () => { parked } — true while the first run is inside the park
// and not yet released by the test.

// B: admission reopens while the first run is parked (a new submit is
// ACCEPTED — the real runner rejects with `submit() === null`).
function wrapRunnerForFault(real, fault, phase, state) {
  if (fault !== 'early-admission') return real;
  return Object.assign({}, real, {
    submit(input, opts) {
      if (phase().parked) {
        state.faultInjected = true;
        return { ended: Promise.resolve({ reason: 'rejected' }) }; // the bug: accepted
      }
      return real.submit(input, opts);
    },
  });
}

// A: the caller-visible `ended` settles early (at cancel — before the run
// is released); everything else stays real.
// C: task_end is published at cancel time; the runner's real publication is
// swallowed (the emit wrapper below) so the terminal stays exactly-once
// (early, not duplicated).
function wrapHandleForFault(handle, fault, phase, state, events) {
  if (fault !== 'early-ended' && fault !== 'early-task-end') return handle;
  const forward = {
    get id() { return handle.id; },
    get input() { return handle.input; },
    get signal() { return handle.signal; },
    phase: () => handle.phase(),
    cancelReason: () => handle.cancelReason(),
    outcome: () => handle.outcome(),
    adoptEpoch: (e) => handle.adoptEpoch(e),
  };
  if (fault === 'early-ended') {
    let settled = false;
    let resolveEarly;
    const earlyEnded = new Promise((resolve) => { resolveEarly = resolve; });
    handle.ended.then((value) => { if (!settled) { settled = true; resolveEarly(value); } });
    return Object.assign(forward, {
      get ended() { return earlyEnded; },
      cancel(reason) {
        const r = handle.cancel(reason);
        if (r && !settled) {
          settled = true;
          state.faultInjected = true;
          resolveEarly({ reason: 'cancelled' }); // the bug: caller-visible ended at cancel time
        }
        return r;
      },
    });
  }
  return Object.assign(forward, {
    get ended() { return handle.ended; },
    cancel(reason) {
      const r = handle.cancel(reason);
      if (r && !state.faultInjected) {
        state.faultInjected = true;
        events.push({ type: 'task_end', reason: 'cancelled', taskId: handle.id }); // the bug: terminal published early
      }
      return r;
    },
  });
}

// The scenario. deps = { createTaskRunner, unhandledRejections? } — the
// SAME packaged public entry the consumer imports, and the page's rejection
// counter. Returns { observation, verdict } with the verdict computed by
// the SHARED assessTaskLifecycle.
export async function runLifecycleScenario(deps, fault) {
  const state = { faultInjected: false, released: false };
  const events = [];
  let entered = false;
  let runExited = false;
  let callerEndedSettled = false;
  let releasePark;
  const park = new Promise((resolve) => { releasePark = resolve; });
  let firstTask = true;

  const emit = (e) => {
    if (fault === 'early-task-end' && state.faultInjected
      && e && e.type === 'task_end') return; // swallow the real publication (fault C)
    events.push(e);
  };
  const phase = () => ({ parked: entered && !runExited && !state.released });

  const realRunner = deps.createTaskRunner({
    emit,
    sessionEpoch: () => 1,
    prepare: async () => {
      if (!firstTask) return { status: 'silent' }; // the follow-up admission probe
      firstTask = false;
      return {
        status: 'ready',
        epoch: 1,
        run: async (ctx) => {
          entered = true; // ENTERED: the real run is at the park point
          ctx.emit({ type: 'task_start', input: 'lifecycle-C' });
          await park;
          runExited = true;
          if (ctx.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        },
      };
    },
  });
  const runner = wrapRunnerForFault(realRunner, fault, phase, state);

  const obs = { fault: fault || null, timeouts: [], entered: false };

  try {
    // submit → the caller sees the (possibly wrapped) handle
    const submitted = runner.submit('lifecycle-C');
    const handle = wrapHandleForFault(submitted, fault, phase, state, events);
    handle.ended.then(() => { callerEndedSettled = true; }); // caller-visible settlement watch

    // ENTERED barrier: the run reached the park point.
    const enteredWait = await waitForBounded('run-entered-park', async () => entered);
    if (!enteredWait.ok) obs.timeouts.push(enteredWait.label);
    obs.entered = entered === true;

    // CANCEL, then one clear scheduling turn set so cancel-time
    // microtasks flush before the boundary snapshot.
    handle.cancel('test-cancel');
    await settle(4);

    // PRE-RELEASE snapshot (before release; the run is still parked).
    const secondSubmit = runner.submit('pre-release-probe');
    obs.preRelease = {
      endedSettled: callerEndedSettled,
      taskEndPublished: events.some((e) => e.type === 'task_end'),
      secondSubmitAccepted: secondSubmit != null,
      runExited,
    };

    // RELEASE: let the real run settle.
    state.released = true;
    releasePark();

    const endedWait = await awaitBounded(handle.ended, 'ended-settled');
    if (!endedWait.ok) obs.timeouts.push(endedWait.label);
    const outcome = endedWait.ok ? endedWait.value : null;

    // Admission reopens and a follow-up completes through the same runner.
    const followUp = runner.submit('lifecycle-C-follow-up');
    let followUpOutcome = null;
    if (followUp) {
      const fuWait = await awaitBounded(followUp.ended, 'follow-up-settled');
      if (!fuWait.ok) obs.timeouts.push(fuWait.label);
      else followUpOutcome = fuWait.value;
    }

    // Late-arrival window: more scheduling turns, then the terminal truth.
    const midEnd = events.filter((e) => e.type === 'task_end').length;
    const midStart = events.filter((e) => e.type === 'task_start').length;
    await settle(8);
    const endCount = events.filter((e) => e.type === 'task_end').length;
    const startCount = events.filter((e) => e.type === 'task_start').length;
    const endEvent = events.filter((e) => e.type === 'task_end')[0] || {};

    obs.postRelease = {
      endedReason: outcome ? outcome.reason : null,
      taskStartCount: startCount,
      taskEndCount: endCount,
      taskEndReason: endEvent.reason || null,
      runExited,
      admissionReopened: followUp != null,
      followUpCompleted: !!followUpOutcome,
      followUpReason: followUpOutcome ? followUpOutcome.reason : null,
      lateTerminationEvents: (endCount - midEnd) + (startCount - midStart),
      unhandledRejections: typeof deps.unhandledRejections === 'function' ? deps.unhandledRejections() : 0,
    };
  } finally {
    // Cleanup: never leave the park held (a fault that wedged the flow has
    // already failed its labeled timeout above).
    if (!state.released) {
      state.released = true;
      releasePark();
    }
  }

  obs.faultInjected = state.faultInjected;
  return { observation: obs, verdict: assessTaskLifecycle(obs) };
}
