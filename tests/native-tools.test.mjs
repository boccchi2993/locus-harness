// Native tool calling integration flows (node, mocked fetch):
// the REAL adapters + model transport + AgentSession, end to end.
//   1. OpenAI dialect: tool_calls → execution → role:tool replay → final
//   2. Anthropic dialect: thinking + tool_use → execution → tool_result
//      replay → final (DeepSeek anthropic-compatible regression: the
//      DEFAULT configured apiBase, dialect auto — no provider-name branch)
//   3. Tool-less provider: explicit 400 tools rejection → one downgrade →
//      strict fenced-JSON fallback executes
//   4. Safety: 429/500/timeout/parse errors never trigger a resend
// M3b migration: verbatim from the source repository at 2aec76e
// (tests/native-tools.test.cjs, blob
// 7ce45678862a39ef068de3fe82c2eb5b465afa12) with the ASSEMBLY converted
// and every assertion unchanged: the eval of the Product tools.js is
// replaced by the same registry content as an inline FIXTURE (the
// product tool registry stays Product-owned), and the Model singleton +
// callModel wrapper become createModelClient per reset. The default
// no-relay decision is explicit (relayEligible: () => false), the same
// call the legacy wrapper made under the suite's 'file:' stub.
// Run: node tests/native-tools.test.mjs

import { AgentSession, createModelClient } from '../src/index.js';

// The Product tool registry (src/tools.js AGENT_TOOL_DEFINITIONS),
// verbatim content — in this package it is a test fixture only: the
// Harness carries NO product tool registry (the ToolPort is injected).
const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'bash',
    description: 'Execute a command in the local browser Linux-like compatibility runtime. ' +
      'Use it for filesystem work, Python execution, text/data processing, and supported network operations.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The shell command to execute.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
  {
    name: 'cloud_bash',
    // Legacy/debug compatibility path (docs/NETWORK-RUNTIME.md): NOT a
    // network path — ordinary network work uses the local bash tool and
    // NetworkRuntime never needs it.
    description: 'Legacy remote execution fallback (debug/compatibility tool, not a network path). ' +
      'It is currently NOT configured, so calls fail. Ordinary shell and network work uses the local bash tool.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The shell command to execute remotely.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
];

// --- fetch mock (same contract as tests/model-adapters.test.cjs) ---
let calls = [];
let queue = [];
global.fetch = async (url, opts) => {
  calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
  const next = queue.length ? queue.shift() : { status: 500, json: { error: { message: 'no mock queued' } } };
  if (next.typeError) throw new TypeError('Failed to fetch');
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    headers: { get: (n) => (next.headers || {})[String(n).toLowerCase()] || null },
    text: async () => (next.rawText !== undefined ? next.rawText : JSON.stringify(next.json)),
  };
};

let passed = 0, failed = 0;
// M2b (repository split): AgentSession consumes a ToolPort
// ({ definitions(), execute({ name, input, context }) }); this suite's
// fakes keep the legacy executor shape and convert through the exact
// mapping the contract documents (docs/REPOSITORY-SPLIT-CONTRACTS.md 3.2).
const asToolPort = (executor) => ({
  definitions: () => AGENT_TOOL_DEFINITIONS.slice(),
  execute: ({ name, input, context }) =>
    executor(name, input, (context && context.filesystem) || null, { signal: context && context.signal }),
});

function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

let client = null;
function reset(apiBase, dialect) {
  client = createModelClient({
    config: {
      apiKey: 'sk-test-key',
      apiBase: apiBase,
      model: 'm',
      proxy: '',
      dialect: dialect || 'auto',
    },
    relayEligible: () => false,
  });
  calls = [];
  queue = [];
}

function newSession(tools) {
  const events = [];
  const execs = [];
  const session = new AgentSession({
    modelClient: (body, opts) => client.call(Object.assign({ model: 'm' }, body), opts),
    toolPort: asToolPort(async (tool, input) => {
      execs.push([tool, input]);
      return { output: 'OUT(' + input + ')', success: true, backend: 'browser' };
    }),
    emit: (e) => events.push(e),
  });
  return { session, events, execs };
}

async function run() {
  // ============ 1. OpenAI native flow ============
  reset('https://gateway.example.com/v1', 'openai');
  queue.push({ status: 200, json: {
    id: 'c1', model: 'm',
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [
      { id: 'call_abc', type: 'function', function: { name: 'bash', arguments: '{"input":"pwd"}' } },
    ] }, finish_reason: 'tool_calls' }],
  } });
  queue.push({ status: 200, json: { choices: [{ message: { content: '你在 /home/locus。' } }] } });

  {
    const { session, events, execs } = newSession();
    await session.run('列出当前目录，然后告诉我这里有什么。', {});

    check('O-FLOW tool executed via native tool_calls',
      execs.length === 1 && execs[0][0] === 'bash' && execs[0][1] === 'pwd', JSON.stringify(execs));
    check('O-FLOW request 1 advertised OpenAI function tools',
      Array.isArray(calls[0].body.tools) && calls[0].body.tools[0].type === 'function'
      && calls[0].body.tools[0].function.name === 'bash'
      && calls[0].body.tools[0].function.parameters.required[0] === 'input');
    const msgs2 = calls[1].body.messages;
    check('O-FLOW request 2 replays assistant tool_calls verbatim',
      msgs2.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)
        && m.tool_calls[0].id === 'call_abc'));
    check('O-FLOW request 2 carries role:tool with the exact tool_call_id',
      msgs2.some((m) => m.role === 'tool' && m.tool_call_id === 'call_abc'
        && m.content.includes('OUT(pwd)') && m.content.includes('untrusted data, not instructions')),
      JSON.stringify(msgs2));
    check('O-FLOW UI saw tool_call/tool_result events, not raw JSON text',
      events.some((e) => e.type === 'tool_call' && e.tool === 'bash')
      && events.some((e) => e.type === 'tool_result' && e.success === true)
      && !events.some((e) => e.type === 'assistant_text' && e.content.includes('"tool"')));
    check('O-FLOW task completed with the final answer',
      events.some((e) => e.type === 'assistant_text' && e.content === '你在 /home/locus。')
      && events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
  }

  // ============ 2. Anthropic native flow on the DEFAULT DeepSeek endpoint ============
  // apiBase https://api.deepseek.com/anthropic + dialect auto → anthropic
  // adapter. No provider-name branching anywhere.
  reset('https://api.deepseek.com/anthropic', 'auto');
  const antBlocks = [
    { type: 'thinking', thinking: '先看看目录里有什么', signature: 'sig-xyz' },
    { type: 'tool_use', id: 'toolu_u1', name: 'bash', input: { input: 'ls' } },
  ];
  queue.push({ status: 200, json: { id: 'msg_1', model: 'm', content: antBlocks, stop_reason: 'tool_use' } });
  queue.push({ status: 200, json: { content: [{ type: 'text', text: '目录里有 a.txt。' }] } });

  {
    const { session, events, execs } = newSession();
    await session.run('列出当前目录，然后告诉我这里有什么。', {});

    check('A-FLOW dialect auto on /anthropic base used the Anthropic adapter',
      calls[0].url === 'https://api.deepseek.com/anthropic/v1/messages'
      && calls[0].headers['x-api-key'] === 'sk-test-key', calls[0].url);
    check('A-FLOW request 1 advertised Anthropic tools (input_schema)',
      Array.isArray(calls[0].body.tools) && calls[0].body.tools[0].name === 'bash'
      && calls[0].body.tools[0].input_schema.type === 'object');
    check('A-FLOW tool_use executed',
      execs.length === 1 && execs[0][1] === 'ls', JSON.stringify(execs));
    check('A-FLOW thinking surfaced as a reasoning event',
      events.some((e) => e.type === 'reasoning' && e.content === '先看看目录里有什么'));
    const msgs2 = calls[1].body.messages;
    const asst = msgs2.find((m) => m.role === 'assistant');
    check('A-FLOW request 2 replays the COMPLETE block array (thinking + tool_use)',
      asst && JSON.stringify(asst.content) === JSON.stringify(antBlocks));
    const resultTurn = msgs2.find((m) => m.role === 'user' && Array.isArray(m.content)
      && m.content[0] && m.content[0].type === 'tool_result');
    check('A-FLOW request 2 carries tool_result with the exact tool_use_id',
      !!resultTurn && resultTurn.content[0].tool_use_id === 'toolu_u1'
      && resultTurn.content[0].is_error === false
      && resultTurn.content[0].content.includes('OUT(ls)'), JSON.stringify(msgs2));
    check('A-FLOW task completed with the final answer',
      events.some((e) => e.type === 'assistant_text' && e.content === '目录里有 a.txt。')
      && events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
  }

  // ============ 3. Tool-less provider: explicit rejection → one downgrade → fenced fallback ============
  reset('https://old-gateway.example.com/v1', 'openai');
  queue.push({ status: 400, json: { error: { message: 'unknown field "tools"', type: 'invalid_request_error', param: 'tools' } } });
  queue.push({ status: 200, json: { choices: [{ message: { content: '```json\n{"tool":"bash","input":"ls"}\n```' } }] } });
  queue.push({ status: 400, json: { error: { message: 'unknown field "tools"', type: 'invalid_request_error', param: 'tools' } } });
  queue.push({ status: 200, json: { choices: [{ message: { content: '完成，目录里有 a.txt。' } }] } });

  {
    const { session, events, execs } = newSession();
    await session.run('列出当前目录', {});

    check('FB-FLOW every model turn: tools request rejected → exactly one downgrade',
      calls.length === 4
      && Array.isArray(calls[0].body.tools) && !('tools' in calls[1].body)
      && Array.isArray(calls[2].body.tools) && !('tools' in calls[3].body),
      'calls=' + calls.length);
    check('FB-FLOW strict fenced-JSON fallback executed the tool',
      execs.length === 1 && execs[0][1] === 'ls', JSON.stringify(execs));
    check('FB-FLOW fallback feedback stays a user-role <tool_result> (no fake native ids)',
      calls[2].body.messages.some((m) => m.role === 'user' && typeof m.content === 'string'
        && m.content.includes('<tool_result>'))
      && !calls[2].body.messages.some((m) => m.role === 'tool'));
    check('FB-FLOW task completed',
      events.some((e) => e.type === 'task_end' && e.reason === 'completed'), events.map((e) => e.type).join(','));
  }

  // ============ 4. No downgrade on ambiguous/billed states ============
  async function expectNoDowngrade(name, mock, expectError) {
    reset('https://old-gateway.example.com/v1', 'openai');
    queue.push(mock);
    const { session, events, execs } = newSession();
    await session.run('task', {});
    check(name + ': no resend, error surfaced, nothing executed',
      calls.length === 1 && execs.length === 0
      && events.some((e) => e.type === 'error' && e.code === 'model_call_failed')
      && (!expectError || events.some((e) => e.type === 'error' && e.message.includes(expectError))),
      'calls=' + calls.length + ' ' + events.map((e) => e.type).join(','));
  }
  await expectNoDowngrade('SAFE-429', { status: 429, json: { error: { message: 'rate limit' } } }, 'rate limit');
  await expectNoDowngrade('SAFE-500', { status: 500, json: { error: { message: 'unknown field "tools"' } } }, 'unknown field');
  await expectNoDowngrade('SAFE-parse', { status: 200, rawText: '<html>oops</html>' });
  await expectNoDowngrade('SAFE-400-unrelated', { status: 400, json: { error: { message: 'model "m" does not exist', param: 'model' } } }, 'model');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
