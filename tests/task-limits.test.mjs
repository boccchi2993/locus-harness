// Task-limit configuration tests (2026-10-31 owner decision): the
// per-task tool-call cap and the per-result char cap are session
// configuration (deps.maxToolCalls / deps.toolResultMaxChars + their
// setters), clamped to 8–1000 / 2000–400000 with a one-time diagnostics
// record; a known context window tightens the result cap to a fifth of
// it; the wrap-up reminder is appended to exactly ONE tool result per
// threshold; the abort message states the effective cap and the
// continue-in-same-conversation instruction; a length-truncated reply
// that cut a tool call's arguments gets the actionable error text.
// Run: node tests/task-limits.test.mjs

import {
  AgentSession, MAX_TOOL_ITERATIONS, TOOL_RESULT_MAX_CHARS,
} from '../src/agent.js';
import {
  createAgentSession, maxToolIterations, harnessCapabilities,
} from '../src/index.js';
import { AGENT_TOOL_DEFINITIONS } from './fixtures/product-tool-registry.mjs';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

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

const asToolPort = (executor) => ({
  definitions: () => AGENT_TOOL_DEFINITIONS.slice(),
  execute: ({ name, input, context }) =>
    executor(name, input, (context && context.filesystem) || null, { signal: context && context.signal }),
});

function newSession(overrides) {
  const events = [];
  const session = new AgentSession(Object.assign({
    modelClient: async () => FINAL,
    toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
    buildSystemPrompt: () => 'SYSTEM',
    emit: (e) => events.push(e),
  }, overrides || {}));
  return { session, events };
}

const WS_A = { name: 'A' };
// The exact owner-specified wording (2026-10-31): a wording drift here is
// a regression — user-facing continue/abort flows depend on it.
const REMINDER_10 = '[Locus: 本任务还剩 10 次工具调用。请尽快收尾，并向用户说明已完成和未完成的部分；用户发送“继续”即可在同一对话中接着做。]';
const REMINDER_3 = '[Locus: 本任务还剩 3 次工具调用。请尽快收尾，并向用户说明已完成和未完成的部分；用户发送“继续”即可在同一对话中接着做。]';
const ABORT = (n) => '已达到本任务的工具调用上限（' + n + ' 次），任务已暂停。发送“继续”可以在同一对话里接着做；也可以在设置中调高上限。';
const TRUNCATED_ARGS = '工具调用参数不完整：本轮输出达到了输出上限（max_tokens），参数被截断。'
  + '请把大文件分多次写入（每次一个较小的文件或片段），或在设置中调高“单次回复输出上限”。';
const isReminder = (e) => e.type === 'tool_result' && String(e.output).includes('[Locus: 本任务还剩');

async function run() {
  // ---------- TL1. defaults + the exported surface keeps its names ----------
  {
    const { session } = newSession({});
    check('TL1 defaults: maxToolCalls 128 / toolResultMaxChars 40000, empty diagnostics',
      session.maxToolCalls === 128 && session.toolResultMaxChars === 40000 && session.diagnostics.length === 0,
      JSON.stringify(session.diagnostics));
    check('TL1b exported defaults kept under the original constant names (128 / 40000)',
      MAX_TOOL_ITERATIONS === 128 && TOOL_RESULT_MAX_CHARS === 40000
      && maxToolIterations() === 128
      && harnessCapabilities().ports.taskLifecycle.maxToolIterations === 128,
      'max=' + MAX_TOOL_ITERATIONS + ' chars=' + TOOL_RESULT_MAX_CHARS);
    const viaFactory = createAgentSession({
      modelClient: async () => FINAL,
      toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
      maxToolCalls: 20, toolResultMaxChars: 5000,
    });
    check('TL1c createAgentSession (the Product construction entry) accepts the new options',
      viaFactory.maxToolCalls === 20 && viaFactory.toolResultMaxChars === 5000,
      'max=' + viaFactory.maxToolCalls + ' chars=' + viaFactory.toolResultMaxChars);
  }

  // ---------- TL2. a configured cap takes effect; abort message states it ----------
  {
    let modelCalls = 0;
    let toolExecs = 0;
    const { session, events } = newSession({
      maxToolCalls: 20,
      modelClient: async () => { modelCalls++; return TOOL_CALL; },
      toolPort: asToolPort(async () => { toolExecs++; return { output: 'ok', success: true }; }),
    });
    await session.run('loop', { workspace: WS_A });
    check('TL2 a configured cap of 20 stops the loop at exactly 20 calls',
      modelCalls === 20 && toolExecs === 20, 'model=' + modelCalls + ' tools=' + toolExecs);
    const limitWarn = events.find((e) => e.type === 'warning' && e.code === 'iteration_limit');
    check('TL2b abort message states the effective cap and the continue instruction, verbatim',
      !!limitWarn && limitWarn.message === ABORT(20), limitWarn && limitWarn.message);
    check('TL2c task_end reason iteration_limit',
      events.some((e) => e.type === 'task_end' && e.reason === 'iteration_limit'), '');
    const reminded = events.filter(isReminder);
    check('TL2d the remaining-10 reminder still fires once under a 20-cap (20 is not < 20, so only that one)',
      reminded.length === 1 && reminded[0].output === 'ok\n' + REMINDER_10,
      JSON.stringify(reminded.map((e) => e.output)));
  }

  // ---------- TL3. a configured result cap truncates with the actual limit in the marker ----------
  {
    const { session } = newSession({
      toolResultMaxChars: 3000,
      modelClient: (() => { let n = 0; return async () => { n++; return n === 1 ? TOOL_CALL : FINAL; }; })(),
      toolPort: asToolPort(async () => ({ output: 'X'.repeat(5000), success: true })),
    });
    await session.run('task', { workspace: WS_A });
    const entry = session.history.find((h) => h.role === 'user' && String(h.content).includes('<tool_result>'));
    check('TL3 the configured result cap truncates and the marker states the actual limit',
      !!entry && entry.content.includes('\n... [truncated 2000 chars in the middle; 本轮工具结果上限：3000 字符] ...\n'),
      entry && entry.content.slice(0, 220));
  }

  // ---------- TL4. clamping + one-time diagnostics ----------
  {
    const { session } = newSession({ maxToolCalls: 5, toolResultMaxChars: 100 });
    check('TL4 below-range values clamp to the lower edges (8 / 2000)',
      session.maxToolCalls === 8 && session.toolResultMaxChars === 2000,
      JSON.stringify(session.diagnostics));
    const { session: s2 } = newSession({ maxToolCalls: 2000, toolResultMaxChars: 999999 });
    check('TL4b above-range values clamp to the upper edges (1000 / 400000)',
      s2.maxToolCalls === 1000 && s2.toolResultMaxChars === 400000,
      JSON.stringify(s2.diagnostics));
    check('TL4c exactly one diagnostics record per clamped setting, naming received → applied',
      session.diagnostics.length === 2
      && session.diagnostics[0].code === 'setting_clamped' && session.diagnostics[0].setting === 'maxToolCalls'
      && session.diagnostics[0].received === 5 && session.diagnostics[0].applied === 8
      && session.diagnostics[1].code === 'setting_clamped' && session.diagnostics[1].setting === 'toolResultMaxChars'
      && session.diagnostics[1].received === 100 && session.diagnostics[1].applied === 2000,
      JSON.stringify(session.diagnostics));
    const { session: s3 } = newSession({ maxToolCalls: '50' });
    check('TL4d a non-integer falls back to the default, recorded once as setting_invalid',
      s3.maxToolCalls === 128 && s3.diagnostics.length === 1 && s3.diagnostics[0].code === 'setting_invalid',
      JSON.stringify(s3.diagnostics));
    s3.setMaxToolCalls(1);
    s3.setToolResultMaxChars(10000000);
    check('TL4e the setters clamp and record the same way',
      s3.maxToolCalls === 8 && s3.toolResultMaxChars === 400000 && s3.diagnostics.length === 3,
      JSON.stringify(s3.diagnostics));
  }

  // ---------- TL5. default cap: exactly one reminder, after the 118th call ----------
  {
    let toolCalls = 0;
    const { session, events } = newSession({
      modelClient: async () => TOOL_CALL, // never answers → runs to the cap
      toolPort: asToolPort(async () => { toolCalls++; return { output: 'ok', success: true }; }),
    });
    await session.run('loop', { workspace: WS_A });
    const reminded = events.filter(isReminder);
    check('TL5 the reminder is appended exactly once, to the result of the 118th call (128 − 10), verbatim',
      reminded.length === 1 && toolCalls === 128 && reminded[0].output === 'ok\n' + REMINDER_10,
      'calls=' + toolCalls + ' reminded=' + reminded.length);
    const feedback = session.history.filter((h) => h.role === 'user' && String(h.content).includes('<tool_result>'));
    check('TL5b exactly one model-visible feedback turn carries the reminder',
      feedback.filter((h) => String(h.content).includes('[Locus: 本任务还剩')).length === 1,
      'feedback=' + feedback.length);
    check('TL5c the abort after the 128th call states 128, verbatim',
      events.some((e) => e.type === 'warning' && e.code === 'iteration_limit' && e.message === ABORT(128)),
      events.filter((e) => e.code === 'iteration_limit').map((e) => e.message).join(''));
  }

  // ---------- TL6. a small cap (< 20) also reminds at 3 remaining ----------
  {
    const { session, events } = newSession({
      maxToolCalls: 12,
      modelClient: async () => TOOL_CALL,
      toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
    });
    await session.run('loop', { workspace: WS_A });
    const reminded = events.filter(isReminder);
    check('TL6 a 12-cap reminds at 10 remaining AND at 3 remaining, once each, in that order',
      reminded.length === 2
      && reminded[0].output === 'ok\n' + REMINDER_10
      && reminded[1].output === 'ok\n' + REMINDER_3,
      JSON.stringify(reminded.map((e) => e.output)));
    check('TL6b the abort after the 12th call states 12, verbatim',
      events.some((e) => e.type === 'warning' && e.code === 'iteration_limit' && e.message === ABORT(12)), '');
  }

  // ---------- TL7. a known context window tightens the result cap to a fifth of it ----------
  {
    let n = 0;
    const { session } = newSession({
      contextWindowTokens: 50000, // min(40000, floor(50000 × 0.2) = 10000) → 10000
      modelClient: async () => { n++; return n === 1 ? TOOL_CALL : FINAL; },
      toolPort: asToolPort(async () => ({ output: 'Y'.repeat(20000), success: true })),
    });
    await session.run('task', { workspace: WS_A });
    const entry = session.history.find((h) => h.role === 'user' && String(h.content).includes('<tool_result>'));
    check('TL7 a 50000-token window tightens the result cap to 10000 chars, stated in the marker',
      !!entry && entry.content.includes('\n... [truncated 10000 chars in the middle; 本轮工具结果上限：10000 字符] ...\n'),
      entry && entry.content.slice(0, 220));
    let m = 0;
    const { session: s2 } = newSession({
      modelClient: async () => { m++; return m === 1 ? TOOL_CALL : FINAL; },
      toolPort: asToolPort(async () => ({ output: 'Z'.repeat(20000), success: true })),
    });
    await s2.run('task', { workspace: WS_A });
    const entry2 = s2.history.find((h) => h.role === 'user' && String(h.content).includes('<tool_result>'));
    check('TL7b without a window the same 20000-char result stays untruncated at the default cap',
      !!entry2 && !entry2.content.includes('[truncated'),
      entry2 && entry2.content.slice(0, 120));
  }

  // ---------- TL8. length-truncated tool-call arguments get the actionable error ----------
  {
    // OpenAI-dialect length truncation (finish_reason 'length').
    const { events } = await runTaskEvents(() => envelope('', {
      toolCalls: [{ id: 'c1', name: 'bash', input: null, argumentsError: 'tool arguments are not valid JSON' }],
      truncated: true, stopReason: 'length',
    }));
    const res = events.find((e) => e.type === 'tool_result' && e.success === false);
    check('TL8 a length-truncated unparseable tool call gets the actionable message, verbatim',
      !!res && res.output === TRUNCATED_ARGS, res && res.output);
  }

  {
    // Anthropic-dialect max_tokens + a MISSING "input" string (not a parse failure).
    const { events } = await runTaskEvents(() => envelope('', {
      toolCalls: [{ id: 'c1', name: 'bash', input: { wrong: 1 } }],
      truncated: true, stopReason: 'max_tokens',
    }));
    const res = events.find((e) => e.type === 'tool_result' && e.success === false);
    check('TL8b a max_tokens-truncated call missing the "input" string gets the same message',
      !!res && res.output === TRUNCATED_ARGS, res && res.output);
  }

  {
    // NOT length-truncated → the original invalid-arguments text is kept.
    const { events } = await runTaskEvents(() => envelope('', {
      toolCalls: [{ id: 'c1', name: 'bash', input: null, argumentsError: 'tool arguments are not valid JSON' }],
    }));
    const res = events.find((e) => e.type === 'tool_result' && e.success === false);
    check('TL8c a non-length params error keeps the original message',
      !!res && res.output === 'invalid tool arguments: tool arguments are not valid JSON',
      res && res.output);
  }

  {
    // Length truncation never touches VALID calls.
    let execs = 0;
    const { events } = await runTaskEvents(() => envelope('', {
      toolCalls: [{ id: 'c1', name: 'bash', input: { input: 'ls' } }],
      truncated: true, stopReason: 'length',
    }), asToolPort(async () => { execs++; return { output: 'ok', success: true }; }));
    check('TL8d a length-truncated reply with VALID arguments still executes the call',
      execs === 1 && events.some((e) => e.type === 'tool_result' && e.success === true), 'execs=' + execs);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

// Small helper: one task whose first turn returns the given envelope,
// the second turn FINAL.
async function runTaskEvents(firstEnvelope, toolPort) {
  const events = [];
  let n = 0;
  const session = new AgentSession({
    modelClient: async () => { n++; return n === 1 ? firstEnvelope() : FINAL; },
    toolPort: toolPort || asToolPort(async () => ({ output: 'ok', success: true })),
    buildSystemPrompt: () => 'SYSTEM',
    emit: (e) => events.push(e),
  });
  await session.run('task', { workspace: WS_A });
  return { session, events };
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
