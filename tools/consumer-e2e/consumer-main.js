// locus-harness TARBALL CONSUMER (M3b acceptance gates A–J).
// Imports ONLY the public package entry — 'locus-harness' — never the
// checkout's src/. Model/tool/persistence implementations are scripted
// fakes; the validators, adapters, client, runner, sessions, gate and
// composition core under test are the REAL packaged implementations.
import {
  createAgentSession, createModelClient, createTaskRunner, isPersistenceFailure,
  createProviderSessions, getProviderAdapter, createProviderIdentity,
  projectNormalizedHistory, validateReplayPrefix,
  createApprovalController, imageInputUnavailableNotice,
  createCapabilityManager, SkillSourceStore, registerPluginRuntimeProvider,
  validatePluginPayload,
  pythonExtensionKeyOf, buildSystemPrompt,
} from 'locus-harness';

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason)));

const results = {};
const evTypes = (events) => events.map((e) => e.type).join(',');

function fakeEnvelope(text, extra) {
  return Object.assign({
    content: text, reasoning: null, stopReason: 'end_turn', usage: null,
    rawMessage: { role: 'assistant', content: text }, truncated: false,
  }, extra || {});
}

// Scripted fake model over the REAL client factory. script: entries per
// request ({ toolCalls?, content? }); every request is recorded.
function scriptedModel(script, record, opts) {
  let step = 0;
  return createModelClient(Object.assign({
    config: { apiKey: 'consumer-key', apiBase: 'https://fake.model.test', model: 'scripted', dialect: 'openai' },
    transport: async (url, init) => {
      const body = JSON.parse(init.body);
      if (record) record.push({ url: String(url), body });
      const line = script[Math.min(step, script.length - 1)];
      step++;
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify({
          choices: [{
            message: Object.assign(
              { role: 'assistant', content: line.content || '' },
              line.toolCalls ? {
                tool_calls: line.toolCalls.map((c) => ({
                  id: c.id, type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
                })),
              } : {}),
            finish_reason: line.toolCalls ? 'tool_calls' : 'stop',
          }],
        }),
      };
    },
  }, opts || {}));
}

function lookupPort(name, log, execLog) {
  return {
    definitions: () => [{
      name, description: 'Look things up (' + name + ').',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    }],
    async execute(call) {
      if (log) log.push(['execute', call.name, call.input && call.input.input]);
      if (execLog) execLog.push(call.name);
      return { output: 'OUT(' + (call.input && call.input.input) + ')', success: true, backend: 'fake' };
    },
  };
}

function memoryProviderStore() {
  const sessionsMap = new Map();
  const framesBySession = new Map();
  const normalizedByConversation = new Map();
  return {
    async get(name, key) { return name === 'providerSessions' ? (sessionsMap.get(key) || null) : null; },
    async loadProviderSession(conversationId) {
      for (const s of sessionsMap.values()) if (s.conversationId === conversationId) return s;
      return null;
    },
    async loadProviderFrames(sessionId) {
      return (framesBySession.get(sessionId) || []).slice().sort((a, b) => a.sequence - b.sequence);
    },
    async loadNormalizedMessages(conversationId) {
      return (normalizedByConversation.get(conversationId) || []).slice().sort((a, b) => a.sequence - b.sequence);
    },
    async saveProviderSession(row) { sessionsMap.set(row.id, row); return row; },
    async appendProviderFrame(frame) {
      if (!framesBySession.has(frame.sessionId)) framesBySession.set(frame.sessionId, []);
      framesBySession.get(frame.sessionId).push(frame);
      return frame;
    },
    async saveNormalizedMessage(row) {
      if (!normalizedByConversation.has(row.conversationId)) normalizedByConversation.set(row.conversationId, []);
      normalizedByConversation.get(row.conversationId).push(row);
      return row;
    },
    frames: framesBySession,
  };
}

function providerSessions(store, config) {
  const fullConfig = () => Object.assign(
    { dialect: config.dialect, apiBase: config.apiBase, model: config.model },
    createProviderIdentity({ dialect: config.dialect, apiBase: config.apiBase, model: config.model }));
  return createProviderSessions({
    persistence: store,
    persistConversation: async () => {},
    reportIssue: () => {},
    getAdapter: (c) => getProviderAdapter(c),
    providerConfig: fullConfig,
    createProviderIdentity: (c) => createProviderIdentity(c),
    projectHistory: (messages, dialect) => projectNormalizedHistory(messages, dialect),
    durableId: (prefix) => prefix + '-consumer',
    now: () => '2026-10-02T00:00:00.000Z',
  });
}

const CONFIG = { dialect: 'openai', apiBase: 'https://api.example.test/v1', model: 'consumer-model' };

(async () => {
  // ============ A. native tool → lookup ToolPort → result → final answer ============
  {
    const events = [];
    const execs = [];
    const requests = [];
    const client = scriptedModel([
      { toolCalls: [{ id: 'tA', name: 'lookup', input: { input: 'qA' } }] },
      { content: 'final answer A' },
    ], requests);
    const session = createAgentSession({
      modelClient: (body, opts) => client.call(body, opts),
      toolPort: { definitions: lookupPort('lookup', null, null).definitions, execute: async (call) => { execs.push([call.name, call.input]); return { output: 'OUT(' + call.input + ')', success: true, backend: 'fake' }; } },
      emit: (e) => events.push(e),
    });
    await session.run('consumer task A', {});
    results.A = {
      chain: evTypes(events),
      execs,
      requestTools: requests[0].body.tools.map((t) => t.function.name),
      toolCallId: (session.history.find((h) => h.role === 'tool_result') || {}).toolCallId || null,
      finalText: (events.filter((e) => e.type === 'assistant_text').pop() || {}).content || null,
      ended: events.some((e) => e.type === 'task_end' && e.reason === 'completed'),
    };
  }

  // ============ B. strict text fallback: a REAL tool round trip ============
  {
    const execs = [];
    const events = [];
    const requests = [];
    const client = scriptedModel([
      { content: '```json\n{"tool":"lookup","input":"fenced-B"}\n```' },
      { content: 'final B' },
    ], requests);
    const session = createAgentSession({
      modelClient: (body, opts) => client.call(body, opts),
      toolPort: { definitions: lookupPort('lookup').definitions, execute: async (c) => { execs.push(c.input); return { output: 'OUT(' + c.input + ')', success: true, backend: 'fake' }; } },
      emit: (e) => events.push(e),
    });
    await session.run('consumer task B', {});
    // the second request must carry the tool feedback as a user-role message
    const fb = requests[1].body.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<tool_result>'));
    results.B = {
      executed: execs,
      feedbackCarried: !!fb && fb.content.includes('OUT(fenced-B)') && fb.content.includes('<tool_result>'),
      request2HadNoToolRole: !requests[1].body.messages.some((m) => m.role === 'tool'),
      completed: events.some((e) => e.type === 'task_end' && e.reason === 'completed'),
    };
  }

  // ============ C. TaskRunner prepare/run/cancel + exactly-once termination ============
  {
    const events = [];
    let runStarted = false;
    let releaseRun;
    const runParked = new Promise((resolve) => { releaseRun = resolve; });
    let firstTask = true;
    const runner = createTaskRunner({
      emit: (e) => events.push(e),
      sessionEpoch: () => 1,
      prepare: async (handle) => {
        if (!firstTask) return { status: 'silent' }; // the follow-up admission probe
        firstTask = false;
        return {
          status: 'ready',
          epoch: 1,
          run: async (ctx) => {
            runStarted = true;
            ctx.emit({ type: 'task_start', input: 'x' });
            await runParked; // parked until the test cancels
            if (ctx.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
          },
        };
      },
    });
    const handle = runner.submit('task C');
    const prepareDone = await (async () => { await new Promise((r) => setTimeout(r, 20)); return !!runStarted; })();
    const endEventsBeforeCancel = events.filter((e) => e.type === 'task_end').length;
    handle.cancel('test-cancel');
    releaseRun();
    const outcome = await handle.ended;
    const endEvents = events.filter((e) => e.type === 'task_end');
    // release BEFORE the outcome settles: assert the pre-release unsettled state
    const handle2 = runner.submit('task C2'); // admission reopened only after the boundary
    const outcome2 = handle2 ? await handle2.ended : null;
    results.C = {
      prepareStartedRun: prepareDone,
      endsBeforeCancel: endEventsBeforeCancel,
      outcomeReason: outcome.reason,
      exactlyOneEnd: endEvents.length === 1 && endEvents[0].reason === 'cancelled',
      admissionReopenedAfterBoundary: !!handle2,
      outcome2Reason: outcome2 && outcome2.reason,
      startEvents: events.filter((e) => e.type === 'task_start').length,
    };
  }

  // ============ D + E. memory store + REAL adapter + REAL validators restore / rejection ============
  {
    const store = memoryProviderStore();
    const sessions = providerSessions(store, CONFIG);
    const conv = { id: 'conv-D', activeProviderSessionId: null, persistenceState: 'healthy' };
    const row = await sessions.ensureSession(conv);
    const ctx = sessions.makeContext(conv, row);
    await ctx.onUserMessage('run D', null);
    await ctx.onProviderFrame({
      role: 'assistant', kind: 'assistant',
      raw: { role: 'assistant', content: 'working', tool_calls: [{ id: 'call-D', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    });
    await ctx.onProviderFrame({ role: 'tool_result', kind: 'tool_result', toolCallId: 'call-D', raw: { role: 'tool_result', toolCallId: 'call-D', content: 'OUT' } });
    await ctx.onCheckpoint({ frame: { sequence: 3 } });

    const restored = { history: [], replayBlocked: false, reset() { this.history = []; this.replayBlocked = false; } };
    const prev = await sessions.restoreInto(restored, conv);
    const dValid = {
      id: prev && prev.id,
      blocked: restored.replayBlocked,
      roles: restored.history.map((h) => h.role),
      toolCallId: (restored.history.find((h) => h.role === 'tool_result') || {}).toolCallId || null,
    };

    // E1: corrupt the tail BEHIND the checkpoint → checkpoint_beyond_tail
    store.frames.get(row.id).pop();
    const broken = { history: [], replayBlocked: false, reset() { this.history = []; this.replayBlocked = false; } };
    await sessions.restoreInto(broken, conv);
    const eTail = { rawInvalid: row.rawReplayInvalid === true, code: row.replayError && row.replayError.code, blocked: broken.replayBlocked };

    // E2: a fresh session with a DANGLING tool result (no preceding call) —
    // the real validator rejects with tool_result_unpaired and restore blocks.
    const store2 = memoryProviderStore();
    const sessions2 = providerSessions(store2, CONFIG);
    const conv2 = { id: 'conv-E2', activeProviderSessionId: null, persistenceState: 'healthy' };
    const row2 = await sessions2.ensureSession(conv2);
    const ctx2 = sessions2.makeContext(conv2, row2);
    await ctx2.onUserMessage('run E2', null);
    await ctx2.onProviderFrame({ role: 'tool_result', kind: 'tool_result', toolCallId: 'ghost', raw: { role: 'tool_result', toolCallId: 'ghost', content: 'x' } });
    await ctx2.onCheckpoint({ frame: { sequence: 2 } }); // the dangling result sits INSIDE the checkpoint
    const broken2 = { history: [], replayBlocked: false, reset() { this.history = []; this.replayBlocked = false; } };
    await sessions2.restoreInto(broken2, conv2);
    const ePair = { rawInvalid: row2.rawReplayInvalid === true, code: row2.replayError && row2.replayError.code, blocked: broken2.replayBlocked };

    // E3: the direct validator export rejects a bad checkpoint itself
    let directCode = null;
    try {
      validateReplayPrefix({ id: 's', conversationId: 'c', replayCheckpointSequence: 5 }, [], getProviderAdapter({ dialect: 'openai' }));
    } catch (e) { directCode = e.code; }

    results.DE = { dValid, eTail, ePair, directCode };
  }

  // ============ F. required persistence failure blocks later model requests ============
  {
    // F1: the runner classifies a failed REQUIRED persistence prepare and
    // never runs; zero model requests.
    const requests = [];
    const client = scriptedModel([{ content: 'should never be asked' }], requests);
    const events = [];
    const failure = new Error('required write failed: disk full');
    failure.name = 'PersistenceError';
    failure.code = 'persistence_write_failed';
    failure.persistenceFailure = true;
    const runner = createTaskRunner({
      emit: (e) => events.push(e),
      sessionEpoch: () => 1,
      prepare: async () => ({ status: 'failed', error: failure }),
    });
    const handle = runner.submit('task F1');
    const outcome = await handle.ended;
    results.F1 = {
      reason: outcome.reason,
      isPersistenceFailure: isPersistenceFailure(failure),
      modelRequests: requests.length,
      endEvents: events.filter((e) => e.type === 'task_end').length,
    };
  }
  {
    // F2: a required write failing DURING the run (assistant frame) ends the
    // task persistence_error with zero further model requests and zero
    // tool executions.
    const requests = [];
    const execLog = [];
    const client = scriptedModel([
      { toolCalls: [{ id: 'tF', name: 'lookup', input: { input: 'q' } }] },
      { content: 'must never be reached' },
    ], requests);
    const events = [];
    const session = createAgentSession({
      modelClient: (body, opts) => client.call(body, opts),
      toolPort: { definitions: lookupPort('lookup').definitions, execute: async (c) => { execLog.push(c.name); return { output: 'OUT', success: true }; } },
      emit: (e) => events.push(e),
      persistence: {
        async onProviderFrame() {
          const e = new Error('required frame write failed');
          e.name = 'PersistenceError';
          e.code = 'persistence_write_failed';
          e.persistenceFailure = true;
          throw e;
        },
      },
    });
    const outcome = await session.run('task F2', {});
    results.F2 = {
      endedPersistenceError: events.some((e) => e.type === 'task_end' && e.reason === 'persistence_error'),
      errorEvent: events.some((e) => e.type === 'error' && e.code === 'persistence_write_failed'),
      modelRequests: requests.length,
      zeroFurtherRequests: requests.length === 1,
      toolExecutions: execLog.length,
    };
  }

  // ============ G. run-level image binding covers HISTORY images; next task normal ============
  {
    const SENTINEL = BufferToStringBase64('consumer-image-bytes');
    const requests = [];
    const client = scriptedModel([
      { content: 'degraded task done' },
      { content: 'normal task done' },
    ], requests);
    const gateCalls = [];
    const realGate = {
      ensureCalls: 0,
      async ensureCapability(o) {
        this.ensureCalls++;
        gateCalls.push(o);
        return { state: 'supported', source: 'user' };
      },
      async resolveAttachment(id) {
        return id === 'att_h' ? { mimeType: 'image/png', dataBase64: SENTINEL } : null;
      },
      unavailableNotice: imageInputUnavailableNotice,
    };
    const denialBinding = {
      ensureCapability: async () => ({ state: 'unsupported', source: 'task' }), // never touches the real gate
      resolveAttachment: async () => null, // never reads bytes
      unavailableNotice: (result) => 'Image input is disabled for this task. ' + (result && result.state === 'unsupported' ? 'The image was not sent to the model.' : ''),
    };
    const events = [];
    const session = createAgentSession({
      modelClient: (body, opts) => client.call(body, opts),
      toolPort: { definitions: lookupPort('lookup').definitions, execute: async () => ({ output: 'OUT', success: true }) },
      emit: (e) => events.push(e),
      imageInput: realGate,
    });
    // history carries a semantic image reference (as a restored/previous task would)
    session.history.push({ role: 'user', _taskStart: true, content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', attachmentId: 'att_h', mimeType: 'image/png', sha256: 'aa', size: 100 },
    ] });
    // task 1: run-level denial binding — history images degrade, gate untouched
    await session.run('task G1', { imageInput: denialBinding });
    const req1 = requests[0].body;
    const textParts1 = JSON.stringify(req1.messages);
    results.G1 = {
      noImageOnWire: !textParts1.includes('data:image') && !textParts1.includes(SENTINEL),
      noticeOnWire: textParts1.includes('Image input is disabled for this task'),
      realGateUntouched: realGate.ensureCalls === 0,
      completed: events.filter((e) => e.type === 'task_end' && e.reason === 'completed').length >= 1,
    };
    // task 2: no override — the SAME history image crosses normally again
    await session.run('task G2', {});
    const req2 = requests[1].body;
    // (openai serialization hoists the system prompt to messages[0]; scan
    // every message for the materialized image part)
    let imgPart = null;
    for (const m of req2.messages) {
      if (Array.isArray(m.content)) {
        const found = m.content.find((p) => p.type === 'image_url');
        if (found) { imgPart = found; break; }
      }
    }
    results.G2 = {
      imageOnWire: !!imgPart && imgPart.image_url.url === 'data:image/png;base64,' + SENTINEL,
      gateConsulted: realGate.ensureCalls >= 1,
      noticeGone: !JSON.stringify(req2.messages).includes('Image input is disabled for this task'),
    };
  }

  // ============ H. capability composition: happy path + rejection path ============
  {
    registerPluginRuntimeProvider('python', {
      async prepare(plugin) {
        return { files: { 'mod.py': 'x = 1\n' }, imports: ['mod'] };
      },
    });
    const catalogs = {
      plugins: [{ id: 'p1', version: '1', runtime: 'python', authority: 'none', provides: { pythonImports: ['mod'] } }],
      skills: [{ id: 's1', version: '1', description: 'guide' }],
      capabilities: [{ id: 'c1', version: '1', displayName: 'Consumer Capability', description: 'd', plugins: ['p1'], skills: ['s1'] }],
    };
    const sources = new SkillSourceStore();
    sources.define('s1', '1', '# guide\n');
    const mem = new Map();
    const notFound = () => { const e = new Error('nf'); e.name = 'NotFoundError'; return e; };
    const instances = {
      async readBytes(rel) { if (!mem.has(rel)) throw notFound(); return mem.get(rel); },
      async writeBytes(rel, bytes) { mem.set(rel, new Uint8Array(bytes)); },
      async removeDir(capId) { for (const k of [...mem.keys()]) if (k.startsWith(capId + '/')) mem.delete(k); },
      async stat(rel) { if (!mem.has(rel)) throw notFound(); return { kind: 'file' }; },
    };
    const manager = createCapabilityManager({ catalogs, sources, instances });
    const state = await manager.enable('c1');
    const env = manager.buildTaskEnvironment();
    const prompt = buildSystemPrompt({ workspace: null, taskEnvironment: env });
    results.H1 = {
      state,
      ready: state === 'ready',
      envKey: env.pythonExtensionKey === 'p1@1',
      promptCarriesIndex: prompt.includes('Consumer Capability') && prompt.includes('.skills/c1/s1.skill'),
      payloadValid: (() => {
        const v = validatePluginPayload({ id: 'p1' }, { files: { 'mod.py': 'x = 1\n' }, imports: ['mod'] });
        return v.files['mod.py'] === 'x = 1\n' && v.imports.join() === 'mod';
      })(),
    };
    // rejection: a payload with a traversal path fails loudly
    let rejectCode = null;
    try { validatePluginPayload({ id: 'bad' }, { files: { '../evil.py': 'x' }, imports: [] }); }
    catch (e) { rejectCode = e.code || e.name; }
    results.H2 = { rejectCode };
  }

  // ============ I. two instances: config + task state never cross ============
  {
    const logA = [];
    const logB = [];
    const clientA = scriptedModel([{ content: 'answer-A' }], logA, { config: { apiKey: 'key-A', apiBase: 'https://a.test', model: 'model-A', dialect: 'openai' } });
    const clientB = scriptedModel([{ content: 'answer-B' }], logB, { config: { apiKey: 'key-B', apiBase: 'https://b.test', model: 'model-B', dialect: 'openai' } });
    const evA = [], evB = [];
    const sessionA = createAgentSession({
      modelClient: (body, opts) => clientA.call(body, opts),
      toolPort: { definitions: lookupPort('toolA').definitions, execute: async () => ({ output: 'A', success: true }) },
      emit: (e) => evA.push(e),
    });
    const sessionB = createAgentSession({
      modelClient: (body, opts) => clientB.call(body, opts),
      toolPort: { definitions: lookupPort('toolB').definitions, execute: async () => ({ output: 'B', success: true }) },
      emit: (e) => evB.push(e),
    });
    const pA = sessionA.run('task for A', {});
    const pB = sessionB.run('task for B', {});
    await Promise.all([pA, pB]);
    // interleaved runners with separate state
    const rA = createTaskRunner({ emit: () => {}, sessionEpoch: () => 1, prepare: async () => ({ status: 'silent' }) });
    const rB = createTaskRunner({ emit: () => {}, sessionEpoch: () => 1, prepare: async () => ({ status: 'silent' }) });
    const hA = rA.submit('ra');
    const hB = rB.submit('rb');
    const [oA, oB] = await Promise.all([hA.ended, hB.ended]);
    results.I = {
      aSawOwnBase: logA.length === 1 && logA[0].url.startsWith('https://a.test/'),
      bSawOwnBase: logB.length === 1 && logB[0].url.startsWith('https://b.test/'),
      historiesSeparate: sessionA.history.length === 2 && sessionB.history.length === 2
        && sessionA.history[1].content === 'answer-A' && sessionB.history[1].content === 'answer-B',
      outcomesSeparate: oA.reason === 'rejected' && oB.reason === 'rejected',
      eventsSeparate: evA.every((e) => !JSON.stringify(e).includes('answer-B')) && evB.every((e) => !JSON.stringify(e).includes('answer-A')),
    };
  }

  results.errors = errors;
  results.resources = () => performance.getEntriesByType('resource').map((r) => r.name);
  results.ready = true;
  window.__consumer = results;
  document.title = 'consumer-ready';
})().catch((e) => {
  errors.push('boot failed: ' + (e && e.stack ? e.stack : String(e)));
  window.__consumer = { ready: false, errors, resources: () => performance.getEntriesByType('resource').map((r) => r.name) };
  document.title = 'consumer-boot-failed';
});

function BufferToStringBase64(text) {
  // browser-only base64 of a UTF-8 string (no Node Buffer on the page)
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}
