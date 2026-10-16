// Request-budget tests (node, NO DOM / jQuery / terminal): configurable
// transport budget (setRequestBudget / requestBudgetBytes), tool
// definitions counted toward the request, one-shot low-water trimming and
// within-task elision of older tool results, the task-level budget
// snapshot in run(), minimumRequestBytes for submit-time pre-checks, and
// task-boundary restoration on replay (docs/CONTEXT-MANAGEMENT.md §3.3,
// DECISIONS.md D9).
// Style follows tests/agent.test.mjs: the same check()/envelope()/
// asToolPort/newSession() helpers, injected fakes only.
// Run: node tests/request-budget.test.mjs

import {
  AgentSession, buildSystemPrompt, stripInternalFields, HISTORY_BUDGET_BYTES,
} from '../src/agent.js';
import { harnessCapabilities } from '../src/index.js';
import { createProviderSessions } from '../src/provider-session.js';
import { AGENT_TOOL_DEFINITIONS } from './fixtures/product-tool-registry.mjs';
import { locusEnvironmentNotes } from './fixtures/product-environment-notes.mjs';

function envelope(text, extra) {
  return Object.assign({
    content: text,
    reasoning: null,
    stopReason: 'end_turn',
    usage: null,
    rawMessage: { role: 'assistant', content: text },
    truncated: false,
  }, extra || {});
}
const TOOL_CALL = envelope('```json\n{"tool":"bash","input":"ls"}\n```');
const FINAL = envelope('done');

let passed = 0, failed = 0;
const asToolPort = (executor) => ({
  definitions: () => AGENT_TOOL_DEFINITIONS.slice(),
  execute: ({ name, input, context }) =>
    executor(name, input, (context && context.filesystem) || null, { signal: context && context.signal }),
});

function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// A session wired only with injected fakes — no globals of any kind.
function newSession(overrides) {
  const events = [];
  const resetCalls = { n: 0 };
  const session = new AgentSession(Object.assign({
    modelClient: async () => FINAL,
    toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
    buildSystemPrompt,
    environmentNotes: locusEnvironmentNotes,
    emit: (e) => events.push(e),
    onSessionReset: () => { resetCalls.n++; },
  }, overrides || {}));
  return { session, events, resetCalls };
}

const WS_A = { name: 'A' };
const ELIDED_NOTICE = '[earlier tool output elided to fit the request budget';

async function run() {
  // ---------- RB1. tool definitions count toward the request bytes ----------
  {
    const { session } = newSession();
    const withTools = session._promptInput({ definitions: AGENT_TOOL_DEFINITIONS }, null, null, null, null);
    const withoutTools = session._promptInput(null, null, null, null, null);
    const diff = session._requestBytesFor(withTools) - session._requestBytesFor(withoutTools);
    const jsonBytes = new TextEncoder().encode(JSON.stringify(AGENT_TOOL_DEFINITIONS)).byteLength;
    check('RB1 tool definitions count toward the request bytes', diff >= jsonBytes,
      'diff=' + diff + ' json=' + jsonBytes);
  }

  // ---------- RB2. null prompt input is safe ----------
  {
    const { session } = newSession();
    session.history.push({ role: 'user', content: 'hello', _taskStart: true });
    let r = null, threw = null;
    try { r = session.enforceHistoryBudget(null); } catch (e) { threw = e; }
    check('RB2 enforceHistoryBudget(null) under budget is a no-op',
      !threw && r && r.dropped === 0 && r.elided === 0, threw && threw.message);
  }

  // ---------- RB3. the budget setter validates and applies ----------
  {
    const { session } = newSession();
    const thrown = [];
    for (const bad of [0, -1, 1.5, '100']) {
      try { session.setRequestBudget(bad); } catch (e) { thrown.push(String(bad) + ':' + e.message); }
    }
    check('RB3 invalid setRequestBudget values throw', thrown.length === 4
      && thrown.every((t) => t.includes('requestBudgetBytes must be a positive integer')), thrown.join(' | '));
    session.setRequestBudget(5000);
    check('RB3b setRequestBudget applies', session.requestBudgetBytes() === 5000);
    let ctorThrew = null;
    try {
      new AgentSession({
        modelClient: async () => FINAL,
        toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
        requestBudgetBytes: 1.5,
      });
    } catch (e) { ctorThrew = e; }
    check('RB3c invalid constructor requestBudgetBytes throws', !!ctorThrew
      && ctorThrew.message.includes('requestBudgetBytes must be a positive integer'), ctorThrew && ctorThrew.message);
    check('RB3d default request budget is HISTORY_BUDGET_BYTES',
      newSession().session.requestBudgetBytes() === HISTORY_BUDGET_BYTES);
  }

  // ---------- RB4. over budget trims ONCE down to the low-water mark ----------
  let rb7Session = null;
  {
    const { session } = newSession();
    session.setRequestBudget(200000);
    for (let i = 0; i < 10; i++) {
      session.history.push({ role: 'user', content: 'old' + i + ' ' + 'x'.repeat(10000), _taskStart: true });
      session.history.push({ role: 'assistant', content: 'y'.repeat(10000) });
    }
    session.history.push({ role: 'user', content: 'current', _taskStart: true });
    const before = session._requestBytesFor(null);
    check('RB4 precondition: over budget before the trim', before > 200000, 'bytes=' + before);
    const r = session.enforceHistoryBudget(null, 200000);
    check('RB4 whole oldest tasks dropped', r.dropped > 0, JSON.stringify(r));
    const after = session._requestBytesFor(null);
    check('RB4b trimmed down to the low-water mark', after <= 120000, 'bytes=' + after);
    check('RB4c first survivor is a task boundary', session.history[0]._taskStart === true);
    check('RB4d the current task is kept', session.history[session.history.length - 1].content === 'current');

    // ---------- RB5. the trimmed prefix stays stable while under budget ----------
    const first = session.history[0];
    let allClean = true;
    const verdicts = [];
    for (let k = 0; k < 5; k++) {
      session.history.push({ role: 'assistant', content: 'a'.repeat(2000) });
      session.history.push({ role: 'tool_result', toolCallId: 'c' + k, toolName: 'bash', content: 'r'.repeat(2000), success: true });
      const rr = session.enforceHistoryBudget(null, 200000);
      verdicts.push(rr.dropped + '/' + rr.elided);
      if (rr.dropped !== 0 || rr.elided !== 0) allClean = false;
    }
    check('RB5 five appended turns stay under budget (no re-trim)', allClean, verdicts.join(','));
    check('RB5b the trimmed prefix is stable across turns', session.history[0] === first);
  }

  // ---------- RB6. run() snapshots the budget for the whole task ----------
  {
    let rb6calls = 0;
    let rb6session = null;
    const h6 = newSession({
      modelClient: async () => {
        rb6calls++;
        if (rb6calls === 1) { rb6session.setRequestBudget(2000); return TOOL_CALL; }
        return FINAL;
      },
      toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
    });
    rb6session = h6.session;
    for (let i = 0; i < 10; i++) {
      h6.session.history.push({ role: 'user', content: 'old' + i + ' ' + 'x'.repeat(30000), _taskStart: true });
      h6.session.history.push({ role: 'assistant', content: 'y'.repeat(30000) });
    }
    await h6.session.run('snapshot task', { workspace: WS_A });
    check('RB6 a mid-task setRequestBudget does not trim the running task', rb6calls === 2,
      'modelCalls=' + rb6calls);
    check('RB6b no history_budget error while the task runs',
      !h6.events.some((e) => e.type === 'error' && e.code === 'history_budget'));
    check('RB6c the task completes', h6.events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
    check('RB6d the new budget applies after the task', h6.session.requestBudgetBytes() === 2000);
  }

  // ---------- RB7. older tool results of the current task are elided ----------
  {
    const { session } = newSession();
    session.setRequestBudget(60000);
    session.history.push({ role: 'user', content: 'task', _taskStart: true });
    const toolResults = [];
    const assistants = [];
    for (let k = 0; k < 8; k++) {
      const a = { role: 'assistant', content: 'call' + k };
      assistants.push(a);
      session.history.push(a);
      const t = { role: 'tool_result', toolCallId: 'c' + k, toolName: 'bash', content: 'R'.repeat(9000), success: true };
      toolResults.push(t);
      session.history.push(t);
    }
    const r = session.enforceHistoryBudget(null, 60000);
    check('RB7 older tool results elided, no task dropped', r.elided >= 1 && r.dropped === 0, JSON.stringify(r));
    const survivors = session.history.filter((m) => m.role === 'tool_result');
    check('RB7b the most recent results stay intact',
      survivors.slice(-4).every((m) => m.content === 'R'.repeat(9000)),
      'n=' + survivors.length);
    const elided = survivors.slice(0, survivors.length - 4);
    check('RB7c elided entries carry the notice and keep their identity',
      elided.length >= 1 && elided.every((m, i) =>
        typeof m.content === 'string' && m.content.startsWith(ELIDED_NOTICE)
        && m._elided === true
        && m.toolCallId === toolResults[i].toolCallId
        && m.toolName === toolResults[i].toolName
        && m.success === toolResults[i].success),
      'elided=' + elided.length);
    check('RB7d copy-on-write: the original entries are never mutated',
      toolResults.every((t) => t.content === 'R'.repeat(9000)));
    check('RB7e assistant entries are preserved by reference',
      assistants.length === 8 && assistants.every((a) => session.history.indexOf(a) !== -1));
    const finalBytes = session._requestBytesFor(null);
    check('RB7f the elided request fits the budget', finalBytes <= 60000, 'bytes=' + finalBytes);
    rb7Session = session;

    // ---------- RB11. internal elision fields never reach the wire ----------
    check('RB11 internal fields are stripped from the wire projection',
      !JSON.stringify(stripInternalFields(rb7Session.history)).includes('_elided'));
  }

  // ---------- RB8. elision carries the full-output path when present ----------
  {
    const { session } = newSession();
    session.setRequestBudget(60000);
    session.history.push({ role: 'user', content: 'task', _taskStart: true });
    for (let k = 0; k < 8; k++) {
      session.history.push({ role: 'assistant', content: 'call' + k });
      const t = { role: 'tool_result', toolCallId: 'c' + k, toolName: 'bash', content: 'R'.repeat(9000), success: true };
      if (k === 0) t._outputPath = '/home/locus/history/c1/tool-outputs/3.txt';
      session.history.push(t);
    }
    session.enforceHistoryBudget(null, 60000);
    const first = session.history.find((m) => m.role === 'tool_result' && m.toolCallId === 'c0');
    check('RB8 the elided notice reports the full-output path',
      !!first && first._elided === true
      && first.content === ELIDED_NOTICE + '; full output: /home/locus/history/c1/tool-outputs/3.txt]',
      first && first.content);
  }

  // ---------- RB9. text-fallback feedback turns are elidable too ----------
  {
    const { session } = newSession();
    session.setRequestBudget(60000);
    const taskMsg = { role: 'user', content: 'task', _taskStart: true };
    session.history.push(taskMsg);
    for (let k = 0; k < 8; k++) {
      session.history.push({ role: 'assistant', content: 'call' + k });
      session.history.push({ role: 'user', content: '<tool_result>\n' + 'R'.repeat(9000) + '\n</tool_result>' });
    }
    const r = session.enforceHistoryBudget(null, 60000);
    const feedback = session.history.filter((m) => m.role === 'user' && m !== taskMsg);
    check('RB9 text-fallback feedback is elided with its framing',
      r.elided >= 1 && feedback.slice(0, -4).every((m) =>
        typeof m.content === 'string'
        && m.content.startsWith('<tool_result>\n[earlier tool output elided')
        && m.content.endsWith('</tool_result>')
        && m._elided === true),
      JSON.stringify(r));
    check('RB9b the current task\'s user message is never touched',
      session.history[0] === taskMsg && taskMsg.content === 'task' && taskMsg._elided === undefined);
  }

  // ---------- RB10. current task alone over budget still fails loudly ----------
  {
    const { session } = newSession();
    session.setRequestBudget(60000);
    const a = { role: 'assistant', content: 'Z'.repeat(70000) };
    session.history.push({ role: 'user', content: 'only', _taskStart: true });
    session.history.push(a);
    let threw = null;
    try { session.enforceHistoryBudget(null, 60000); } catch (e) { threw = e; }
    check('RB10 a current task over budget throws with the budget in the message',
      !!threw && threw.message.includes('transport budget') && threw.message.includes('60000'),
      threw && threw.message);
    check('RB10b the assistant entry is untouched by the failed trim',
      session.history[1] === a && a.content === 'Z'.repeat(70000));
  }

  // ---------- RB12. minimumRequestBytes: the floor of the NEXT task ----------
  {
    const { session } = newSession();
    const a = await session.minimumRequestBytes(null, null, 0);
    const bare = await session.historyRequestBytes(null);
    session.history.push({ role: 'user', content: 'x'.repeat(500000), _taskStart: true });
    const b = await session.minimumRequestBytes(null, null, 0);
    check('RB12 droppable older tasks never raise the minimum', a === b, a + ' vs ' + b);
    check('RB12b extraBytes is added verbatim', (await session.minimumRequestBytes(null, null, 500)) - a === 500);
    check('RB12c the minimum counts tools, so it exceeds the bare estimate', a > bare, a + ' vs ' + bare);
  }

  // ---------- RB13. a restored conversation re-derives task boundaries ----------
  {
    // Fake persistence in the shape of tests/provider-session.test.mjs's
    // makeDeps store, trimmed to the restoreInto surface.
    const store = {
      providerSessions: new Map(),
      framesBySession: new Map(),
      normalizedByConversation: new Map(),
    };
    const persistence = {
      async get(name, key) { return (store[name] && store[name].get(key)) || null; },
      async loadProviderSession(conversationId) {
        for (const row of store.providerSessions.values()) if (row.conversationId === conversationId) return row;
        return null;
      },
      async loadProviderFrames(sessionId) { return (store.framesBySession.get(sessionId) || []).slice(); },
      async loadNormalizedMessages(conversationId) { return (store.normalizedByConversation.get(conversationId) || []).slice(); },
      async saveProviderSession(row) { store.providerSessions.set(row.id, row); return row; },
      async appendProviderFrame(frame) {
        const list = store.framesBySession.get(frame.sessionId) || [];
        list.push(frame); store.framesBySession.set(frame.sessionId, list);
        return frame;
      },
      async saveNormalizedMessage(row) {
        const list = store.normalizedByConversation.get(row.conversationId) || [];
        list.push(row); store.normalizedByConversation.set(row.conversationId, list);
        return row;
      },
    };
    const deps = {
      persistence,
      persistConversation: async () => {},
      reportIssue: () => {},
      getAdapter: () => ({ isRawReplayCompatible: () => true }),
      providerConfig: () => ({ provider: 'openai', adapterId: 'openai', dialect: 'openai', apiBase: 'https://x.example/v1', model: 'm1', endpointIdentity: 'https://x.example', protocolVersion: '1' }),
      createProviderIdentity: (config) => ({ provider: config.provider, dialect: config.dialect, endpointIdentity: config.endpointIdentity }),
      projectHistory: (messages) => messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text || '' })),
      validateReplayPrefix: () => ({ valid: true }),
      validateNormalizedPrefix: () => ({ valid: true }),
      durableId: (prefix) => prefix + '-rb13',
      now: () => '2026-10-17T00:00:00.000Z',
    };
    const ps = createProviderSessions(deps);
    const raws = [
      { kind: 'user', raw: { role: 'user', content: 'old task ' + 'x'.repeat(50000) } },
      { kind: 'assistant', raw: { role: 'assistant', content: 'y'.repeat(50000) } },
      { kind: 'user', raw: { role: 'user', content: 'second task' } },
      { kind: 'assistant', raw: { role: 'assistant', content: 'ok' } },
      { kind: 'user', raw: { role: 'user', content: 'third task' } },
      { kind: 'assistant', raw: { role: 'assistant', content: 'ok' } },
    ];
    store.framesBySession.set('ps-1', raws.map((r, i) => ({
      id: 'f' + (i + 1), sessionId: 'ps-1', conversationId: 'conv-1',
      sequence: i + 1, turnId: 'ps-1',
      direction: r.kind === 'assistant' ? 'inbound' : 'outbound',
      role: r.raw.role, kind: r.kind, raw: r.raw,
    })));
    store.providerSessions.set('ps-1', { id: 'ps-1', conversationId: 'conv-1', replayCheckpointSequence: 6 });
    const conv = { id: 'conv-1', activeProviderSessionId: 'ps-1' };
    const { session } = newSession();
    await ps.restoreInto(session, conv);
    const users = session.history.filter((m) => m.role === 'user');
    check('RB13 restored user frames start tasks again; assistant frames do not',
      session.history.length === 6 && users.length === 3
      && users.every((m) => m._taskStart === true)
      && session.history.filter((m) => m.role === 'assistant').every((m) => m._taskStart === undefined),
      JSON.stringify(session.history.map((m) => m.role + ':' + (m._taskStart ? 'T' : 'f'))));
    check('RB13b the stored raw frames were never mutated in place',
      store.framesBySession.get('ps-1').every((f) => f.raw._taskStart === undefined));
    const r = session.enforceHistoryBudget(null, 60000);
    check('RB13c the trim drops the whole first task only',
      r.dropped === 2 && r.elided === 0 && session.history.length === 4
      && session.history[0].content === 'second task',
      JSON.stringify(r) + ' n=' + session.history.length);
  }

  // ---------- RB14. the capability declaration names requestBudget ----------
  check('RB14 harnessCapabilities declares requestBudget',
    harnessCapabilities().capabilities.requestBudget === true);

  console.log('---');
  console.log('request-budget.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
