// Import purity gate (M3b): importing the public entry performs NO side
// effects — no DOM/storage access, no fetch, no global mutation, no task
// start — even with the browser globals poisoned. Adapted from the
// source repository's import-purity discipline (the runtime package's
// runtime-import-purity.test.mjs) for the harness package.
// Run: node tests/import-purity.test.mjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const globalBefore = new Set(Object.getOwnPropertyNames(globalThis));
// Poison the browser globals: any access during import throws.
for (const name of ['window', 'document', 'location', 'localStorage', 'indexedDB', 'caches']) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() { throw new Error('import purity: ' + name + ' was accessed'); },
  });
}
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async (...args) => { fetchCalls++; return realFetch(...args); };

try {
  const mod = await import('../src/index.js?import-purity');

  check('P1 the entry imports cleanly with window/document/localStorage/indexedDB poisoned',
    typeof mod.createAgentSession === 'function');

  const added = Object.getOwnPropertyNames(globalThis).filter((k) => !globalBefore.has(k));
  check('P2 the import adds nothing to globalThis (and poisoning left nothing behind)',
    added.filter((k) => !['window', 'document', 'location', 'localStorage', 'indexedDB', 'caches'].includes(k)).length === 0,
    JSON.stringify(added));

  check('P3 the import performed no fetch', fetchCalls === 0, String(fetchCalls));

  // The factories are usable IMMEDIATELY after the plain import (no
  // initialization call) — a full fake-model task runs on this import.
  const events = [];
  const scripted = mod.createModelClient({
    config: { apiKey: 'k', apiBase: 'https://purity.test', model: 'm', dialect: 'openai' },
    transport: async (url, init) => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pure' }, finish_reason: 'stop' }] }),
    }),
  });
  const session = mod.createAgentSession({
    modelClient: (body, opts) => scripted.call(body, opts),
    toolPort: {
      definitions: () => [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } }],
      execute: async () => { throw new Error('never executed'); },
    },
    emit: (e) => events.push(e),
  });
  await session.run('purity task', {});
  check('P4 a full task runs straight off the import (no ensureHarnessCore required)',
    events.some((e) => e.type === 'task_end' && e.reason === 'completed'),
    events.map((e) => e.type).join(','));
  check('P5 the no-assembly compat shim resolves without touching anything',
    (await mod.ensureHarnessCore()) === undefined);
} catch (e) {
  check('P1 the entry imports cleanly with the browser globals poisoned', false,
    (e && e.stack || String(e)).slice(0, 300));
}

// Restore the real globals for the process exit.
for (const name of ['window', 'document', 'location', 'localStorage', 'indexedDB', 'caches']) {
  delete globalThis[name];
}
globalThis.fetch = realFetch;

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
