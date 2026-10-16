// Context-window budget tests (node, NO DOM / jQuery / terminal): the
// optional user-configured context window (tokens), provider-usage
// unification, usage-calibrated bytes-per-token, effective budget
// = min(transport, context-derived), the task-level snapshot and the
// capability declaration (docs/CONTEXT-MANAGEMENT.md §3.2 stage 4,
// DECISIONS.md D5/D9). Measured, never inferred from a model name.
// Style follows tests/request-budget.test.mjs: the same check()/envelope()/
// asToolPort/newSession() helpers, injected fakes only.
// Run: node tests/context-window.test.mjs

import {
  AgentSession, buildSystemPrompt, usageInputTokens,
} from '../src/agent.js';
import { harnessCapabilities } from '../src/index.js';
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
  const session = new AgentSession(Object.assign({
    modelClient: async () => FINAL,
    toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
    buildSystemPrompt,
    environmentNotes: locusEnvironmentNotes,
    emit: (e) => events.push(e),
  }, overrides || {}));
  return { session, events };
}

const WS_A = { name: 'A' };

async function run() {
  // ---------- CW1. provider-neutral usage unification ----------
  check('CW1 openai dialect prompt_tokens', usageInputTokens({ prompt_tokens: 100 }) === 100);
  check('CW1 anthropic dialect sums the cache fields',
    usageInputTokens({ input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 }) === 95);
  check('CW1 anthropic dialect without cache fields', usageInputTokens({ input_tokens: 10 }) === 10);
  check('CW1 null usage → null', usageInputTokens(null) === null);
  check('CW1 empty usage → null', usageInputTokens({}) === null);
  check('CW1 all-zero usage → null', usageInputTokens({ prompt_tokens: 0, input_tokens: 0 }) === null);
  check('CW1 non-numeric prompt_tokens → null', usageInputTokens({ prompt_tokens: '100' }) === null);

  // ---------- CW2. no window configured: behavior unchanged ----------
  {
    const { session, events } = newSession();
    check('CW2 without a window the effective budget is the transport budget',
      session.effectiveRequestBudgetBytes() === session.requestBudgetBytes());
    session.setRequestBudget(5000);
    check('CW2b still equal after a transport-budget change',
      session.effectiveRequestBudgetBytes() === session.requestBudgetBytes());
    const plain = newSession();
    await plain.session.run('plain task', { workspace: WS_A });
    check('CW2c a plain task behaves as before',
      plain.events.some((e) => e.type === 'task_end' && e.reason === 'completed')
      && !plain.events.some((e) => e.type === 'error'),
      JSON.stringify(plain.events.filter((e) => e.type === 'error')));
  }

  // ---------- CW3. the default ratio before any sample ----------
  {
    const { session } = newSession();
    session.setContextWindow(100000);
    check('CW3 default bytes/token=2 → floor((100000-8192)*2*0.9)',
      session.effectiveRequestBudgetBytes() === 165254,
      'got ' + session.effectiveRequestBudgetBytes());
  }

  // ---------- CW4. calibration from usage samples ----------
  {
    const { session } = newSession();
    check('CW4 no samples → the conservative default', session.bytesPerToken() === 2);
    session._recordTokenSample(3000, false, { prompt_tokens: 1000 });
    check('CW4b one sample sets the ratio (3000/1000)',
      Math.abs(session.bytesPerToken() - 3) <= 1e-9, 'got ' + session.bytesPerToken());
    const low = newSession().session;
    low._recordTokenSample(100, false, { prompt_tokens: 1000 }); // ratio 0.1
    check('CW4c the ratio is clamped below at 1', low.bytesPerToken() === 1, 'got ' + low.bytesPerToken());
    const high = newSession().session;
    high._recordTokenSample(100000, false, { prompt_tokens: 1000 }); // ratio 100
    check('CW4d the ratio is clamped above at 6', high.bytesPerToken() === 6, 'got ' + high.bytesPerToken());
    for (let i = 0; i < 5; i++) session._recordTokenSample(3000, false, { prompt_tokens: 1000 });
    session._recordTokenSample(4000, false, { prompt_tokens: 1000 }); // 6th sample: ratio 4
    check('CW4e the sample window keeps the last 5 (moving average)',
      session._bytesPerTokenSamples.length === 5 && Math.abs(session.bytesPerToken() - 3.2) <= 1e-9,
      'n=' + session._bytesPerTokenSamples.length + ' ratio=' + session.bytesPerToken());
  }

  // ---------- CW5. requests carrying images are never calibration samples ----------
  {
    const { session } = newSession();
    session._recordTokenSample(3000, true, { prompt_tokens: 1000 });
    check('CW5 an image-bearing sample is skipped', session._bytesPerTokenSamples.length === 0);

    const SENTINEL_B64 = 'c2VudGluZWwtcGl4ZWwtcGF5bG9hZC0wMDAx'; // "sentinel-pixel-payload-0001"
    const modelCalls = [];
    const events = [];
    const imageInput = {
      ensureCapability: async () => ({ state: 'supported', source: 'user' }),
      resolveAttachment: async (id) => id === 'att_1' ? { mimeType: 'image/png', dataBase64: SENTINEL_B64 } : null,
      unavailableNotice: () => 'The image was not sent to the model.',
    };
    const imgSession = new AgentSession({
      modelClient: async (body) => {
        modelCalls.push(body);
        return envelope('done', { usage: { prompt_tokens: 500 } });
      },
      toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
      buildSystemPrompt: () => 'SYSTEM',
      emit: (e) => events.push(e),
      imageInput,
    });
    await imgSession.run('看这张图', {
      userContent: [
        { type: 'text', text: '看这张图' },
        { type: 'image', attachmentId: 'att_1', mimeType: 'image/png', sha256: 'aa11', size: 24 },
      ],
    });
    check('CW5b the image run completed and carried the resolved bytes',
      events.some((e) => e.type === 'task_end' && e.reason === 'completed')
      && modelCalls.length === 1
      && modelCalls[0].messages[0].content[1].dataBase64 === SENTINEL_B64,
      JSON.stringify(events.filter((e) => e.type === 'error')));
    check('CW5c no calibration sample from the image request',
      imgSession._bytesPerTokenSamples.length === 0 && imgSession.bytesPerToken() === 2,
      'samples=' + imgSession._bytesPerTokenSamples.length);
  }

  // ---------- CW6. a window at or below max_tokens fails before any model call ----------
  {
    let calls = 0;
    const events = [];
    const { session } = newSession({
      modelClient: async () => { calls++; return FINAL; },
      emit: (e) => events.push(e),
    });
    session.setContextWindow(8192);
    await session.run('hello', { workspace: WS_A });
    const err = events.find((e) => e.type === 'error' && e.code === 'history_budget');
    check('CW6 window <= max_tokens fails with the adjustment hint',
      !!err && err.message.includes('must be larger than max output tokens'), err && err.message);
    check('CW6b no model call is made', calls === 0, 'calls=' + calls);
    check('CW6c the task ends as an error',
      events.some((e) => e.type === 'task_end' && e.reason === 'error'));
  }

  // ---------- CW7. the setter and the constructor validate ----------
  {
    const { session } = newSession();
    const thrown = [];
    for (const bad of [0, -5, 1.5, '1000']) {
      try { session.setContextWindow(bad); } catch (e) { thrown.push(String(bad) + ':' + e.message); }
    }
    check('CW7 invalid setContextWindow values throw', thrown.length === 4
      && thrown.every((t) => t.includes('contextWindowTokens must be a positive integer or null')),
      thrown.join(' | '));
    session.setContextWindow(100000);
    check('CW7b setContextWindow applies', session.contextWindow === 100000);
    session.setContextWindow(null);
    check('CW7c setContextWindow(null) clears the window', session.contextWindow === null);
    let ctorThrew = null;
    try {
      new AgentSession({
        modelClient: async () => FINAL,
        toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
        contextWindowTokens: 0,
      });
    } catch (e) { ctorThrew = e; }
    check('CW7d invalid constructor contextWindowTokens throws', !!ctorThrew
      && ctorThrew.message.includes('contextWindowTokens must be a positive integer or null'),
      ctorThrew && ctorThrew.message);
  }

  // ---------- CW8. a running task keeps its context-window snapshot ----------
  {
    let calls = 0;
    let h = null;
    h = newSession({
      modelClient: async () => {
        calls++;
        if (calls === 1) { h.session.setContextWindow(9000); return TOOL_CALL; }
        return FINAL;
      },
    });
    await h.session.run('snapshot task', { workspace: WS_A });
    check('CW8 no history_budget error while the window changes mid-task',
      !h.events.some((e) => e.type === 'error' && e.code === 'history_budget'),
      JSON.stringify(h.events.filter((e) => e.type === 'error')));
    check('CW8b the task completes',
      h.events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
    // The NEW value applies to the NEXT task: window 9000 > maxTokens 8192
    // passes the gate, but the derived budget (floor(808*2*0.9)=1454) is
    // below the request itself, so the next run fails loudly.
    await h.session.run('next task', { workspace: WS_A });
    check('CW8c the next task is limited by the new window',
      h.events.some((e) => e.type === 'error' && e.code === 'history_budget'
        && e.message.includes('limited by the context window setting')),
      JSON.stringify(h.events.filter((e) => e.type === 'error')));
  }

  // ---------- CW9. calibration reset vs session reset ----------
  {
    const { session } = newSession();
    session._recordTokenSample(3000, false, { prompt_tokens: 1000 });
    check('CW9 a sample moves the ratio', Math.abs(session.bytesPerToken() - 3) <= 1e-9);
    session.resetTokenCalibration();
    check('CW9b resetTokenCalibration restores the conservative default',
      session.bytesPerToken() === 2 && session._bytesPerTokenSamples.length === 0);
    session._recordTokenSample(3000, false, { prompt_tokens: 1000 });
    session.reset();
    check('CW9c session reset keeps the model calibration',
      Math.abs(session.bytesPerToken() - 3) <= 1e-9, 'got ' + session.bytesPerToken());
  }

  // ---------- CW10. trimming under the context-derived budget ----------
  {
    const modelCalls = [];
    const events = [];
    const session = new AgentSession({
      modelClient: async (body) => { modelCalls.push(body); return FINAL; },
      toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
      buildSystemPrompt: () => 'SYSTEM',
      emit: (e) => events.push(e),
    });
    session.setContextWindow(50000); // maxTokens 8192, samples empty → 75254
    check('CW10 the effective budget is the context-derived value',
      session.effectiveRequestBudgetBytes() === 75254,
      'got ' + session.effectiveRequestBudgetBytes());
    for (let i = 0; i < 10; i++) {
      session.history.push({ role: 'user', content: 'old' + i + ' ' + 'x'.repeat(10000), _taskStart: true });
      session.history.push({ role: 'assistant', content: 'y'.repeat(10000) });
    }
    await session.run('short task', { workspace: WS_A });
    check('CW10b no history_budget error under the context-derived budget',
      !events.some((e) => e.type === 'error' && e.code === 'history_budget'),
      JSON.stringify(events.filter((e) => e.type === 'error')));
    check('CW10c the first request already dropped old tasks (< 21 messages)',
      modelCalls.length >= 1 && modelCalls[0].messages.length < 21,
      'messages=' + (modelCalls[0] ? modelCalls[0].messages.length : 'none'));
    check('CW10d the request after the run fits the context-derived budget',
      session._requestBytesFor(null) <= 75254, 'bytes=' + session._requestBytesFor(null));
    check('CW10e the task completes',
      events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
  }

  // ---------- CW11. the error names the context window as the limiter ----------
  {
    const events = [];
    const { session } = newSession({
      emit: (e) => events.push(e),
    });
    session.setContextWindow(8193); // one token above maxTokens → effective budget floor(1*2*0.9)=1
    await session.run('hello', { workspace: WS_A });
    const err = events.find((e) => e.type === 'error' && e.code === 'history_budget');
    check('CW11 the history_budget error names the context window setting',
      !!err && err.message.includes('limited by the context window setting'), err && err.message);
  }

  // ---------- CW12. the capability declaration names contextWindowBudget ----------
  check('CW12 harnessCapabilities declares contextWindowBudget',
    harnessCapabilities().capabilities.contextWindowBudget === true);

  console.log('---');
  console.log('context-window.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
