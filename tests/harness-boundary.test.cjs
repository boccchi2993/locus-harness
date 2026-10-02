// Harness boundary gate (M3b — package edition, rewritten from the source
// repository's tests/harness-boundary.test.cjs at 2aec76e, blob
// 986b2a64f108b4130f49517cf9cf4fa046e5b0a9). The M2b gate scanned the
// classic/globalThis assembly pattern; THIS gate enforces its DELETION:
// the public entry's transitive ESM import closure stays inside the
// package-owned file set, the sources read no Runtime/Product/DOM/
// telemetry globals, and the classic compat surfaces (the declared core
// table, the replay-validation global publish, the legacy Model/callModel
// wrappers, every globalThis publish) are GONE. Paired with the real
// execution proof in tests/harness-standalone.test.mjs (structure +
// behavior, never grep alone).
// Run: node tests/harness-boundary.test.cjs

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + ' | ' + detail); }
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// Comment-stripped, CRLF-normalized source (same normalization as the
// runtime boundary gate — M2a's CRLF lesson).
function clean(rel) {
  const src = read(rel).replace(/\r\n/g, '\n');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------- B1. the entry's transitive ESM import closure ----------
const ENTRY = 'src/index.js';
const PACKAGE_OWNED = new Set([
  'src/index.js',
  'src/task-runner.js',
  'src/provider-session.js',
  'src/replay-validation.js',
  'src/model-adapters.js',
  'src/model.js',
  'src/capabilities.js',
  'src/extension-composition.js',
  'src/approval.js',
  'src/agent.js',
]);
const CLOSURE_REQUIRED = [
  'src/task-runner.js',
  'src/provider-session.js',
  'src/replay-validation.js',
  'src/model-adapters.js',
  'src/model.js',
  'src/capabilities.js',
  'src/extension-composition.js',
  'src/approval.js',
  'src/agent.js',
];

function importSpecifiers(rel) {
  const src = clean(rel);
  const out = [];
  for (const m of src.matchAll(/import\s+[^'"]*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/export\s+[^'"]*from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

function resolveRel(fromRel, spec) {
  if (!spec.startsWith('.')) return null; // bare package (none expected)
  const dir = path.dirname(path.join(root, fromRel));
  let p = path.resolve(dir, spec).replace(/\\/g, '/');
  if (!p.endsWith('.js')) p += '.js';
  const rootSlash = root.replace(/\\/g, '/') + '/';
  return p.startsWith(rootSlash) ? p.slice(rootSlash.length) : p;
}

{
  const seen = new Set([ENTRY]);
  const queue = [ENTRY];
  let foreign = [];
  let bareSpecifiers = [];
  while (queue.length) {
    const rel = queue.shift();
    for (const spec of importSpecifiers(rel)) {
      if (!spec.startsWith('.')) { bareSpecifiers.push(rel + ' -> ' + spec); continue; }
      const resolved = resolveRel(rel, spec);
      if (!resolved || !PACKAGE_OWNED.has(resolved)) foreign.push(rel + ' -> ' + spec);
      if (resolved && PACKAGE_OWNED.has(resolved) && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  check('B1 entry import closure stays inside the package-owned set',
    foreign.length === 0, JSON.stringify(foreign));
  check('B1 no bare-package imports in the closure (zero runtime dependencies)',
    bareSpecifiers.length === 0, JSON.stringify(bareSpecifiers));
  check('B1 the closure covers the whole harness core',
    CLOSURE_REQUIRED.every((f) => seen.has(f)), JSON.stringify([...seen].sort()));
  check('B1 the product tool layer is NOT in the closure (tools.js is Product)',
    !seen.has('src/tools.js') && !fs.existsSync(path.join(root, 'src', 'tools.js')));
}

// ---------- B2. no Runtime/Product/DOM/telemetry references ----------
{
  const findings = [];
  for (const rel of PACKAGE_OWNED) {
    const src = clean(rel);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const where = rel + ':' + (i + 1);
      // Runtime coupling
      // NOTE: `describeCommands` is the DESCRIPTION PORT's method name —
      // a port the HARNESS defines and consumes (the Runtime implements
      // it on the other side of the boundary), so its name is harness
      // vocabulary, not a Runtime reference. Calling it through the
      // injected port is the contract; only a direct/global runtime read
      // would violate it (covered by the other patterns).
      if (/__LOCUS_RUNTIME_CORE__|shellSystemPromptSection|runShellCommand|runPythonCode|createPythonRuntime/.test(line)) {
        findings.push(where + ' runtime ref: ' + line.trim().slice(0, 90));
      }
      if (/runtime\/(index|core|worker-assets)\.js/.test(line)) {
        findings.push(where + ' runtime import: ' + line.trim().slice(0, 90));
      }
      // Product coupling
      if (/executeTool|AGENT_TOOL_DEFINITIONS|PersistenceServiceInstance|AttachmentStore|renderDebugPanel|Telemetry\b|LocusMutationPolicy/.test(line)) {
        findings.push(where + ' product/telemetry ref: ' + line.trim().slice(0, 90));
      }
      if (/(src\/)?tools\.js|ui\/store|persistence\.js|attachments\.js|mutation-policy|product\/|from '\.\.\/ui\//.test(line)) {
        findings.push(where + ' product import: ' + line.trim().slice(0, 90));
      }
      // DOM / framework / hosting. NO declared exceptions remain: the
      // legacy window.location relay guard was deleted with the wrappers.
      if (/document\.|getElementById|window\.|location\.protocol/.test(line)) {
        findings.push(where + ' DOM/hosting ref: ' + line.trim().slice(0, 90));
      }
      if (/\bVue\b|from 'vue'/.test(line)) {
        findings.push(where + ' vue ref: ' + line.trim().slice(0, 90));
      }
      // Worker-source reads (the runtime's own assets never enter the harness)
      if (/pyWorkerSource|grepWorkerSource|PY_WORKER_SOURCE|GREP_WORKER_SOURCE/.test(line)) {
        findings.push(where + ' runtime worker asset ref: ' + line.trim().slice(0, 90));
      }
    });
  }
  check('B2 harness sources read no Runtime/Product/DOM/telemetry globals',
    findings.length === 0, JSON.stringify(findings.slice(0, 8)));
}

// ---------- B3. the classic compat surfaces are DELETED (M3b evidence) ----------
{
  let publishes = [];
  for (const rel of PACKAGE_OWNED) {
    const src = clean(rel);
    if (/globalThis\.\w+\s*=/.test(src)) publishes.push(rel + ' globalThis publish');
    if (/__LOCUS_HARNESS_CORE__/.test(src)) publishes.push(rel + ' core table');
    if (/__LOCUS_HARNESS_REPLAY_VALIDATION__/.test(src)) publishes.push(rel + ' replay table');
  }
  check('B3 no globalThis publishes / declared tables remain in src/',
    publishes.length === 0, JSON.stringify(publishes));

  const model = clean('src/model.js');
  check('B3 the legacy Model singleton and callModel wrappers are gone',
    !/legacyModelClient/.test(model) && !/^function callModel/m.test(model)
    && !/^const Model\s*=/m.test(model) && !/verifyConnection/.test(model));
  const idx = clean('src/index.js');
  check('B3 the entry reads no core table and fabricates no registryVersion',
    !/readCoreTable|__LOCUS_HARNESS_CORE__/.test(idx));
  const pkg = JSON.parse(read('package.json'));
  check('B3 the package exposes ONLY the "." entry (no ./src/* wildcard)',
    Object.keys(pkg.exports).length === 1 && pkg.exports['.'] === './src/index.js',
    JSON.stringify(pkg.exports));
  check('B3 the package declares zero runtime dependencies',
    (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0)
      && (!pkg.peerDependencies || Object.keys(pkg.peerDependencies).length === 0));
}

// ---------- B4. probe deps are explicit (no global fallbacks) ----------
{
  const caps = clean('src/capabilities.js');
  check('B4 ModelCapabilityRegistry requires its persistence dependency',
    /persistence backend is required/.test(caps));
  check('B4 the image probe takes an explicit model client (no callModel fallback)',
    !/typeof callModel/.test(caps) && /typeof o\.callModelFn === 'function'/.test(caps));
}

// ---------- B5. the public surface covers the reviewed consumers ----------
{
  const idx = clean('src/index.js');
  const requiredExports = [
    'createAgentSession', 'AgentSession', 'buildSystemPrompt',
    'historyBudgetBytes', 'maxToolIterations', 'HISTORY_BUDGET_BYTES', 'MAX_TOOL_ITERATIONS',
    'createTaskRunner', 'isPersistenceFailure', 'TASK_OUTCOME_REASONS',
    'createProviderSessions',
    'replayValidationError', 'validateReplayPrefix', 'validateNormalizedPrefix',
    'createModelClient', 'MODEL_TIMEOUT_MS', 'MODEL_MAX_RESPONSE_BYTES',
    'getProviderAdapter', 'OpenAIAdapter', 'AnthropicAdapter',
    'createProviderIdentity', 'createCredentialIdentity', 'projectNormalizedHistory',
    'createApprovalController', 'ApprovalController', 'APPROVAL_KINDS',
    'createModelCapabilityRegistry', 'createImageInputGate', 'runImageInputProbe',
    'classifyImageProviderError', 'imageInputUnavailableNotice',
    'createCapabilityManager', 'CapabilityManager', 'SkillSourceStore',
    'pythonExtensionKeyOf', 'validatePluginPayload', 'registerPluginRuntimeProvider',
    'EXTENSION_ID_PATTERN', 'EXTENSION_PY_MODULE_PATTERN',
    'CAPABILITY_CATALOG', 'PLUGIN_CATALOG', 'SKILL_CATALOG', 'MCP_CATALOG',
    // M3b review R1 (F1): the descriptor validators and the skill-instance
    // contract data with real Product consumers at 2aec76e
    // (capability-package.js, extensions.js) — see EXTRACTION-PLAN §3.
    'validateCapabilityDescriptor', 'validatePluginDescriptor',
    'validateSkillDescriptor', 'validateMcpDescriptor',
    'skillInstancePath', 'SKILL_INSTANCE_ROOT', 'SKILL_INSTANCE_MARKER',
    'SKILL_INSTANCE_MAX_BYTES', 'sha256Hex',
    'harnessCapabilities', 'ensureHarnessCore',
  ];
  const missing = requiredExports.filter((name) =>
    !new RegExp('\\b' + name + '\\b').test(idx));
  check('B5 the entry exports the reviewed public surface',
    missing.length === 0, JSON.stringify(missing));
  check('B5 harnessCapabilities declares contractVersion 1 and no registryVersion',
    /contractVersion: 1/.test(idx) && !/registryVersion/.test(idx));
}

// ---------- B6. behavior pairing: the entry really runs ----------
check('B6 structural gate paired with tests/harness-standalone.test.mjs (real execution)',
  fs.existsSync(path.join(root, 'tests', 'harness-standalone.test.mjs')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
