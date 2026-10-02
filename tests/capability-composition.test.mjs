// Capability Composition Runtime v1 unit tests (node):
// descriptor validators, registry load-time validation, CapabilityManager
// lifecycle (enable/disable/states), TaskEnvironment immutability,
// component semantics (plugins/MCP dedupe by id; skill INSTANCES are
// capability-private and never deduped), MCP requirement states,
// system-prompt capability index (lazy instance paths — bodies NEVER in
// prompt), task VFS mount SPECS (introspection only), the python
// extension payload/key seam.
// M3b migration: from the source repository at 2aec76e
// (tests/capability-composition.test.cjs, blob
// 126f184d0e23997996f04f298221899335e06803). Ownership split applied,
// NO assertion weakened on kept behavior:
//   - the composition-core checks run here over the REAL module;
//   - the durable SkillInstanceStorage (Product storage over the Runtime
//     MemoryWorkspace) became the in-memory port double below, which
//     reproduces the manager's narrow { readBytes, writeBytes, removeDir,
//     stat } contract AND the observation surface (read/exists/remove)
//     the assertions use, byte-for-byte on the same paths;
//   - the PRODUCT adapter block (productTaskVfsMounts over the Runtime
//     VirtualWorkspace/StaticFileWorkspace, F1–F12) and the WORKER
//     install block (W0–W9 over the Runtime PY_WORKER_SOURCE) stayed in
//     the source repository — they test Product/Runtime behavior;
//     the F0 pure-specs check (Harness side) is kept.
// Run: node tests/capability-composition.test.mjs

import {
  CapabilityManager, SkillSourceStore, pythonExtensionKeyOf,
  validatePluginPayload, registerPluginRuntimeProvider,
  unregisterPluginRuntimeProvider,
  EXTENSION_ID_PATTERN, EXTENSION_PY_MODULE_PATTERN,
  CAPABILITY_CATALOG, PLUGIN_CATALOG, SKILL_CATALOG, MCP_CATALOG,
  validatePluginDescriptor, validateSkillDescriptor,
  validateCapabilityDescriptor, validateCatalogSet,
  CAPABILITY_STATES, MCP_STATES, SKILL_INSTANCE_ROOT, skillInstancePath,
} from '../src/extension-composition.js';
import { buildSystemPrompt, AgentSession } from '../src/agent.js';
import { AGENT_TOOL_DEFINITIONS } from './fixtures/product-tool-registry.mjs';
import { readFileSync } from 'node:fs';

// fixture reader (the source suite's helper; the synthetic skill markdown
// ships under tests/fixtures/skills/)
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

// ---- in-memory durable instance storage (the manager's narrow port) ----
// Same paths, same NotFoundError name, same '.skills/…' observation view
// the source suite used through the product storage over MemoryWorkspace.
class MemoryInstanceStore {
  constructor() { this._files = new Map(); this._dirs = new Set(); }
  _key(rel) {
    const norm = String(rel);
    let k = norm.startsWith('.skills/') ? norm.slice('.skills/'.length) : norm;
    if (k.startsWith('/')) k = k.slice(1);
    for (const seg of k.split('/')) {
      if (seg === '..' || seg === '' || seg === '.') throw notFound(rel);
    }
    return k;
  }
  async readBytes(rel) {
    const k = this._key(rel);
    if (!this._files.has(k)) throw notFound(rel);
    return this._files.get(k);
  }
  async writeBytes(rel, bytes) {
    const k = this._key(rel);
    const dir = k.slice(0, k.lastIndexOf('/'));
    if (dir) this._dirs.add(dir);
    this._files.set(k, new Uint8Array(bytes));
  }
  async removeDir(capId) {
    const prefix = this._key(capId) + '/';
    for (const k of [...this._files.keys()]) if (k.startsWith(prefix)) this._files.delete(k);
    for (const d of [...this._dirs]) if (d.startsWith(prefix)) this._dirs.delete(d);
  }
  async stat(rel) {
    const k = this._key(rel);
    if (this._files.has(k)) return { kind: 'file', size: this._files.get(k).byteLength };
    if (this._dirs.has(k)) return { kind: 'directory' };
    throw notFound(rel);
  }
  // ---- observation surface used by the assertions ----
  async read(rel) {
    const bytes = await this.readBytes(rel);
    return new TextDecoder().decode(bytes);
  }
  async exists(rel) {
    try { await this.readBytes(rel); return true; } catch (e) { return false; }
  }
  async remove(rel) {
    const k = this._key(rel);
    this._files.delete(k);
  }
}

function notFound(rel) {
  const e = new Error('not found: ' + rel);
  e.name = 'NotFoundError';
  return e;
}

let passed = 0, failed = 0;
// AgentSession consumes a ToolPort ({ definitions(), execute(...) }); this
// suite's fakes keep the legacy executor shape and convert through the
// exact mapping the contract documents.
const asToolPort = (executor) => ({
  definitions: () => AGENT_TOOL_DEFINITIONS.slice(),
  execute: ({ name, input, context }) =>
    executor(name, input, (context && context.filesystem) || null, { signal: context && context.signal }),
});

function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
async function throwsWith(name, fn, namePart, msgPart) {
  try {
    await fn();
    check(name, false, 'expected throw');
  } catch (e) {
    const ok = (!namePart || e.name === namePart || String(e.message).includes(namePart))
      && (!msgPart || String(e.message).includes(msgPart));
    check(name, ok, e.name + ': ' + e.message);
  }
}

// ---- synthetic TEST-ONLY catalog (never part of production) ----
// The skill's default Markdown source lives in a real fixture file and is
// injected into the SkillSourceStore — NEVER inline on the descriptor.
const SYNTH_SKILL_BODY = read('tests/fixtures/skills/synthetic-skill/SKILL.md');

const SYNTH_CATALOGS = () => ({
  plugins: [
    {
      id: 'synthetic-python-plugin', version: '1', displayName: 'Synthetic Python Plugin',
      runtime: 'python', authority: 'none',
      provides: { pythonImports: ['locus_test_plugin'] },
    },
    {
      id: 'shared-plugin', version: '2', displayName: 'Shared Plugin',
      runtime: 'python', authority: 'none',
      provides: { pythonImports: [] },
    },
  ],
  skills: [
    { id: 'synthetic-skill', version: '1', displayName: 'Synthetic Skill', description: 'How to use the synthetic capability.' },
    { id: 'shared-skill', version: '1', description: 'Shared guidance.' },
  ],
  mcps: [
    { id: 'synthetic-service', displayName: 'Synthetic Service', description: 'TEST ONLY authority' },
  ],
  capabilities: [
    {
      id: 'synthetic-capability', version: '1', displayName: 'Synthetic Capability',
      description: 'TEST ONLY composition proof.',
      plugins: ['synthetic-python-plugin'],
      skills: ['synthetic-skill'],
      mcps: [],
    },
    {
      id: 'cap-a', version: '1', displayName: 'Capability A',
      description: 'Shares plugin X and the skill definition with B.',
      plugins: ['shared-plugin'], skills: ['shared-skill'], mcps: [],
    },
    {
      id: 'cap-b', version: '1', displayName: 'Capability B',
      description: 'Also shares plugin X and the skill definition.',
      plugins: ['shared-plugin'], skills: ['shared-skill'], mcps: [],
    },
    {
      id: 'synthetic-mcp-capability', version: '1', displayName: 'Synthetic MCP Capability',
      description: 'Requires an external authority.',
      plugins: [], skills: ['synthetic-skill'], mcps: ['synthetic-service'],
    },
  ],
});

function synthSources() {
  const s = new SkillSourceStore();
  s.define('synthetic-skill', '1', SYNTH_SKILL_BODY);
  s.define('shared-skill', '1', '# shared\n');
  return s;
}

// One manager = one fresh memory store + source store, so lifecycle tests
// never observe each other's files. The store IS the home view (the
// manager sees the narrow port; assertions read the same files through
// the observation API, exactly as they did through the product storage).
function newManager(catalogs, opts) {
  const o = opts || {};
  const home = o.home || new MemoryInstanceStore();
  const sources = o.sources === undefined ? synthSources() : o.sources;
  const instances = o.instances === undefined ? home : o.instances;
  const m = new CapabilityManager({ catalogs: catalogs || SYNTH_CATALOGS(), sources, instances });
  m._testHome = home;
  return m;
}

function synthProvider() {
  return {
    runtime: 'python',
    async prepare(plugin) {
      if (plugin.id === 'synthetic-python-plugin') {
        return {
          files: { 'locus_test_plugin.py': 'def answer():\n    return 42\n' },
          imports: ['locus_test_plugin'],
        };
      }
      return { files: { ['shared_' + plugin.id.replace(/[^a-z0-9]/g, '_') + '.py']: 'x = 1\n' }, imports: [] };
    },
  };
}

async function run() {
  // ================= production catalogs =================
  check('P1 production capability catalog is empty', CAPABILITY_CATALOG.length === 0);
  check('P2 production plugin catalog is empty', PLUGIN_CATALOG.length === 0);
  check('P3 production skill catalog is empty', SKILL_CATALOG.length === 0);
  check('P4 production mcp catalog is empty', MCP_CATALOG.length === 0);
  check('P5 production catalogs are frozen', Object.isFrozen(CAPABILITY_CATALOG) && Object.isFrozen(PLUGIN_CATALOG));
  const prod = newManager({});
  check('P6 empty production manager lists nothing', prod.listCapabilities().length === 0);
  check('P7 empty environment has no python key', prod.buildTaskEnvironment().pythonExtensionKey === null);
  check('P8 empty environment mounts nothing (pure specs — the provider adapter is Product-side)',
    prod.taskVfsMountSpecs(prod.buildTaskEnvironment()).length === 0);
  check('P9 state vocabularies', CAPABILITY_STATES.join(',') === 'disabled,needs-connection,ready,error'
    && MCP_STATES.join(',') === 'connected,needs-connection,unavailable');

  // ================= descriptor validation =================
  await throwsWith('V1 plugin authority other than none is rejected',
    () => validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'network', provides: { pythonImports: [] } }),
    'authority');
  await throwsWith('V2 plugin authority undefined is rejected',
    () => validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python' }),
    'authority');
  await throwsWith('V3 unsupported plugin runtime is rejected',
    () => validatePluginDescriptor({ id: 'p', version: '1', runtime: 'java', authority: 'none' }),
    'runtime');
  await throwsWith('V4 python plugin without pythonImports is rejected',
    () => validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'none' }),
    'pythonImports');
  await throwsWith('V5 plugin with non-array provides entry is rejected',
    () => validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'none', provides: { pythonImports: 'x' } }),
    'provides');
  await throwsWith('V6 plugin with bad module name is rejected',
    () => validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'none', provides: { pythonImports: ['bad name'] } }),
    'module name');
  check('V7 valid plugin descriptor normalizes', (() => {
    const p = validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'none', provides: { pythonImports: ['m'] } });
    return p.authority === 'none' && p.runtime === 'python' && p.displayName === 'p';
  })());
  // SkillDefinition = metadata ONLY. Inline source fields are rejected
  // loudly (never silently ignored), and the old VFS path field is gone —
  // instance paths are derived from capabilityId + skillId.
  await throwsWith('V8 skill inline body is rejected',
    () => validateSkillDescriptor({ id: 's', version: '1', description: 'd', body: 'b' }),
    '"body" is not allowed');
  await throwsWith('V9 skill inline content is rejected',
    () => validateSkillDescriptor({ id: 's', version: '1', description: 'd', content: 'b' }),
    '"content" is not allowed');
  await throwsWith('V9b skill inline markdown is rejected',
    () => validateSkillDescriptor({ id: 's', version: '1', description: 'd', markdown: 'b' }),
    '"markdown" is not allowed');
  await throwsWith('V9c skill inlineSource is rejected',
    () => validateSkillDescriptor({ id: 's', version: '1', description: 'd', inlineSource: 'b' }),
    '"inlineSource" is not allowed');
  await throwsWith('V10 skill descriptor path field is rejected (instance paths are derived)',
    () => validateSkillDescriptor({ id: 's', version: '1', description: 'd', path: '/usr/local/share/locus/skills/s/SKILL.md' }),
    '"path" is not allowed');
  check('V11 valid skill descriptor is metadata only', (() => {
    const s = validateSkillDescriptor({ id: 's', version: '1', description: 'd', displayName: 'S' });
    return JSON.stringify(Object.keys(s)) === JSON.stringify(['kind', 'id', 'version', 'displayName', 'description'])
      && !('body' in s) && !('path' in s);
  })());
  check('V12 instance path contract is capability-private and derived',
    skillInstancePath('a-cap', 'x') === '/home/locus/.skills/a-cap/x.skill'
    && skillInstancePath('b-cap', 'x') === '/home/locus/.skills/b-cap/x.skill');
  await throwsWith('V13 capability referencing unknown plugin fails catalog load',
    () => validateCatalogSet({ capabilities: [{ id: 'c', version: '1', displayName: 'C', description: 'd', plugins: ['nope'] }] }),
    'unknown plugin');
  await throwsWith('V14 capability referencing unknown skill fails catalog load',
    () => validateCatalogSet({ capabilities: [{ id: 'c', version: '1', displayName: 'C', description: 'd', skills: ['nope'] }] }),
    'unknown skill');
  await throwsWith('V15 duplicate plugin id fails catalog load',
    () => validateCatalogSet({ plugins: [{ id: 'p', version: '1', runtime: 'python', authority: 'none', provides: { pythonImports: [] } }, { id: 'p', version: '2', runtime: 'python', authority: 'none', provides: { pythonImports: [] } }] }),
    'duplicate plugin id');
  await throwsWith('V16 duplicate capability id fails catalog load',
    () => validateCatalogSet({ capabilities: [{ id: 'c', version: '1', displayName: 'C', description: 'd' }, { id: 'c', version: '2', displayName: 'C2', description: 'd' }] }),
    'duplicate capability id');
  await throwsWith('V17 invalid mcp ref id fails capability validation',
    () => validateCapabilityDescriptor({ id: 'c', version: '1', displayName: 'C', description: 'd', mcps: ['../evil'] }),
    'valid ids');
  check('V18 duplicate component refs normalize/dedupe', (() => {
    const c = validateCapabilityDescriptor({
      id: 'c', version: '1', displayName: 'C', description: 'd',
      plugins: ['p', 'p'], skills: ['s', 's', 's'],
    });
    return c.plugins.length === 1 && c.skills.length === 1;
  })());
  await throwsWith('V19 missing version fails validation',
    () => validateCapabilityDescriptor({ id: 'c', displayName: 'C', description: 'd' }),
    'version');
  await throwsWith('V20 skill source store rejects oversized sources', () => {
    const st = new SkillSourceStore();
    st.define('s', '1', 'x'.repeat(256 * 1024 + 1));
  }, 'skill source limit');
  check('V21 skill source store hands out byte copies (no aliasing)', (() => {
    const st = new SkillSourceStore();
    st.define('s', '1', '# hi\n');
    const a = st.sourceOf('s', '1');
    const b = st.sourceOf('s', '1');
    return a.bytes !== b.bytes && Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)) === 0
      && st.sourceOf('s', '2') === null && st.has('s', '1');
  })());

  // ================= manager lifecycle =================
  // NOTE: the "no provider" case runs BEFORE any provider registration.
  const bare = newManager();
  const bareState = await bare.enable('synthetic-capability');
  check('M1 python plugin without runtime provider -> capability state error', bareState === 'error', bareState);
  check('M2 error capability names the missing provider', /no runtime provider registered for "python"/.test(bare.listCapabilities().find((c) => c.id === 'synthetic-capability').error || ''));
  const bareEnv = bare.buildTaskEnvironment();
  const bareCap = bareEnv.capabilities.find((c) => c.id === 'synthetic-capability');
  check('M3 error capability contributes no components to the environment',
    bareCap && bareCap.state === 'error' && bareCap.pluginIds.length === 0 && bareCap.skillIds.length === 0
    && bareEnv.plugins.length === 0 && bareEnv.skills.length === 0);

  registerPluginRuntimeProvider('python', synthProvider());
  const m4 = newManager();
  check('M4 provider (re-)registration enables resolution', await m4.enable('synthetic-capability') === 'ready');

  const mgr = newManager();
  const list0 = mgr.listCapabilities();
  check('M5 all catalog capabilities start disabled', list0.length === 4 && list0.every((c) => c.state === 'disabled' && !c.enabled));
  check('M6 includes counts come from the descriptor refs', (() => {
    const c = list0.find((x) => x.id === 'synthetic-capability');
    return c.includes.plugins === 1 && c.includes.skills === 1 && c.includes.mcps === 0;
  })());

  const st = await mgr.enable('synthetic-capability');
  check('M7 enable resolves local components + materializes -> ready', st === 'ready', st);
  check('M7b enable materialized the capability-private instance',
    (await mgr._testHome.read('/home/locus/../.skills/synthetic-capability/synthetic-skill.skill').catch(() => null)) === null
    && (await mgr._testHome.read('.skills/synthetic-capability/synthetic-skill.skill')) === SYNTH_SKILL_BODY);
  check('M7c install marker written LAST (after the default instance)',
    await mgr._testHome.exists('.skills/synthetic-capability/.locus-installed.json'));
  check('M7d the durable instance does NOT enter listCapabilities metadata',
    JSON.stringify(mgr.listCapabilities().find((c) => c.id === 'synthetic-capability').skills[0])
      === JSON.stringify({ id: 'synthetic-skill', displayName: 'Synthetic Skill', version: '1' }));
  check('M8 enable of unknown id throws', await (async () => {
    try { await mgr.enable('nope'); return false; } catch (e) { return /unknown capability/.test(e.message); }
  })());

  const env = mgr.buildTaskEnvironment();
  check('M9 environment carries the capability (ready)', env.capabilities.length === 1 && env.capabilities[0].state === 'ready');
  check('M10 environment carries the plugin descriptor (authority none)',
    env.plugins.length === 1 && env.plugins[0].id === 'synthetic-python-plugin' && env.plugins[0].authority === 'none');
  check('M11 environment carries the prepared payload',
    env.plugins[0].payload.files['locus_test_plugin.py'].includes('return 42')
    && env.plugins[0].payload.imports.join() === 'locus_test_plugin');
  check('M12 environment carries the skill INSTANCE (metadata + derived path, never a body)',
    env.skills.length === 1
    && env.skills[0].capabilityId === 'synthetic-capability'
    && env.skills[0].skillId === 'synthetic-skill'
    && env.skills[0].path === '/home/locus/.skills/synthetic-capability/synthetic-skill.skill'
    && env.skills[0].present === true
    && !('body' in env.skills[0]) && !('content' in env.skills[0]) && !('source' in env.skills[0]));
  check('M13 environment carries the instance path per capability', env.capabilities[0].skillPaths.join() === env.skills[0].path);
  check('M14 pythonExtensionKey identifies the payload set', env.pythonExtensionKey === 'synthetic-python-plugin@1');

  // ---- frozen TaskEnvironment ----
  const envFrozen = Object.isFrozen(env) && Object.isFrozen(env.capabilities) && Object.isFrozen(env.plugins)
    && Object.isFrozen(env.skills) && Object.isFrozen(env.mcps) && Object.isFrozen(env.capabilities[0])
    && Object.isFrozen(env.plugins[0]) && Object.isFrozen(env.plugins[0].payload)
    && Object.isFrozen(env.plugins[0].payload.files) && Object.isFrozen(env.skills[0]);
  check('M15 TaskEnvironment is deeply frozen', envFrozen);
  const mutationOK = await (async () => {
    'use strict';
    try {
      const e = mgr.buildTaskEnvironment();
      e.capabilities.push({ id: 'intruder' });
      e.plugins[0].authority = 'network';
      return false;
    } catch (e) {
      return e instanceof TypeError;
    }
  })();
  check('M16 mutating a frozen environment throws (strict mode)', mutationOK);
  const env2 = mgr.buildTaskEnvironment();
  check('M17 after mutation attempt a fresh build is unchanged',
    env2.capabilities.length === 1 && env2.plugins[0].authority === 'none');

  // ---- dedupe / reference semantics (C1/C2/C3) ----
  // Plugins and MCP requirements dedupe by id. Skill INSTANCES do NOT:
  // the same definition referenced by two capabilities yields two
  // capability-private entries with two independent paths.
  await mgr.enable('cap-a');
  await mgr.enable('cap-b');
  const dedupe = mgr.buildTaskEnvironment();
  check('M18 C1: shared plugin resolves once across capabilities',
    dedupe.plugins.length === 2 && dedupe.plugins.filter((p) => p.id === 'shared-plugin').length === 1, JSON.stringify(dedupe.plugins.map((p) => p.id)));
  check('M19 skill instances are NEVER deduped: shared definition -> two private entries',
    dedupe.skills.length === 3
    && dedupe.skills.filter((s) => s.skillId === 'shared-skill').length === 2
    && dedupe.skills.filter((s) => s.skillId === 'shared-skill').every((s) => s.path.endsWith('/shared-skill.skill'))
    && dedupe.skills.find((s) => s.skillId === 'shared-skill').path === '/home/locus/.skills/cap-a/shared-skill.skill'
    && dedupe.skills.find((s) => s.capabilityId === 'cap-b' && s.skillId === 'shared-skill').path === '/home/locus/.skills/cap-b/shared-skill.skill',
    JSON.stringify(dedupe.skills));
  check('M19b each capability materialized its OWN instance file',
    (await mgr._testHome.read('.skills/cap-a/shared-skill.skill')) === '# shared\n'
    && (await mgr._testHome.read('.skills/cap-b/shared-skill.skill')) === '# shared\n');
  await mgr.disable('cap-a');
  const afterA = mgr.buildTaskEnvironment();
  check('M20 C2: disabling A keeps the shared plugin while B needs it',
    !afterA.capabilities.some((c) => c.id === 'cap-a') && afterA.capabilities.some((c) => c.id === 'cap-b')
    && afterA.plugins.some((p) => p.id === 'shared-plugin')
    && afterA.skills.some((s) => s.capabilityId === 'cap-b'));
  await mgr.disable('cap-b');
  const afterB = mgr.buildTaskEnvironment();
  check('M21 C3: disabling B removes the shared components',
    afterB.capabilities.length === 1 && afterB.capabilities[0].id === 'synthetic-capability'
    && afterB.plugins.length === 1 && afterB.plugins[0].id === 'synthetic-python-plugin');
  await throwsWith('M22 disable of unknown id throws', () => mgr.disable('nope'), 'unknown capability');
  check('M23 disable is idempotent for disabled ids', (await mgr.disable('cap-a'), await mgr.disable('cap-a'), true));
  const synthetic = mgr.buildTaskEnvironment();
  check('M24 old snapshot (cap-a+cap-b era) was never mutated by disables',
    synthetic.capabilities.length === 1 && synthetic.capabilities[0].id === 'synthetic-capability');
  check('M25 disable removed ONLY the removed capability\'s instance directory',
    !(await mgr._testHome.exists('.skills/cap-a')) && !(await mgr._testHome.exists('.skills/cap-b'))
    && (await mgr._testHome.exists('.skills/synthetic-capability/synthetic-skill.skill')));

  // ---- MCP requirement semantics ----
  const mmgr = newManager();
  await mmgr.enable('synthetic-mcp-capability');
  check('M26 unconnected MCP requirement -> needs-connection (never ready)',
    mmgr.capabilityState('synthetic-mcp-capability') === 'needs-connection');
  const mEnv1 = mmgr.buildTaskEnvironment();
  check('M27 environment carries the requirement state',
    mEnv1.mcps.length === 1 && mEnv1.mcps[0].id === 'synthetic-service' && mEnv1.mcps[0].state === 'needs-connection');
  check('M28 needs-connection snapshot is frozen too', Object.isFrozen(mEnv1.mcps[0]));
  mmgr.setMcpState('synthetic-service', 'connected');
  check('M29 explicit connection flips the manager state to ready',
    mmgr.capabilityState('synthetic-mcp-capability') === 'ready');
  const mEnv2 = mmgr.buildTaskEnvironment();
  check('M30 connected status appears only in the NEXT snapshot',
    mEnv2.mcps[0].state === 'connected' && mEnv1.mcps[0].state === 'needs-connection');
  await throwsWith('M31 invalid MCP state is rejected', () => mmgr.setMcpState('synthetic-service', 'authorized'), 'invalid MCP state');
  const umgr = newManager();
  await umgr.enable('synthetic-mcp-capability');
  umgr.setMcpState('synthetic-service', 'unavailable');
  check('M32 unavailable authority also keeps needs-connection', umgr.capabilityState('synthetic-mcp-capability') === 'needs-connection');

  // ---- catalog replacement (test/e2e injection path) ----
  const rmgr = newManager();
  await rmgr.enable('synthetic-capability');
  rmgr.replaceCatalogs({ capabilities: [] });
  check('M33 replaceCatalogs resets enabled-state', rmgr.listCapabilities().length === 0 && rmgr.buildTaskEnvironment().capabilities.length === 0);
  await throwsWith('M34 broken replacement catalog fails loudly and keeps state', async () => {
    try {
      rmgr.replaceCatalogs({ capabilities: [{ id: 'x', version: '1', displayName: 'X', description: 'd', plugins: ['ghost'] }] });
    } finally {
      if (rmgr.listCapabilities().length !== 0) throw new Error('state was mutated by a failed replace');
    }
  }, 'unknown plugin');

  // ================= system prompt =================
  const readyMgr = newManager();
  await readyMgr.enable('synthetic-capability');
  const readyEnv = readyMgr.buildTaskEnvironment();
  const pMgr = newManager();
  await pMgr.enable('synthetic-capability');
  await pMgr.enable('synthetic-mcp-capability');
  const pEnv = pMgr.buildTaskEnvironment();
  const promptReady = buildSystemPrompt({ workspace: null, taskEnvironment: readyEnv });
  check('S1 prompt contains the capability display name', promptReady.includes('Synthetic Capability'));
  check('S2 prompt contains the capability-private instance path', promptReady.includes('/home/locus/.skills/synthetic-capability/synthetic-skill.skill'));
  check('S2b prompt points at NO other skill location', !promptReady.includes('/usr/local/share/locus/skills'));
  check('S3 prompt tells the model to read the guidance on demand', /read a file with cat only when/i.test(promptReady));
  check('S3b prompt states the behavior-mutation rule', /customized when the user asks/i.test(promptReady)
    && /explicit user confirmation/i.test(promptReady));
  check('S4 prompt does NOT contain the skill body marker', !promptReady.includes('SHOULD_ONLY_APPEAR_AFTER_SKILL_READ_7F91'));
  check('S5 prompt does NOT contain plugin ids', !promptReady.includes('synthetic-python-plugin'));
  check('S6 prompt does NOT contain internal APIs', !promptReady.includes('CapabilityManager') && !promptReady.includes('TaskEnvironment')
    && !promptReady.includes('SkillSourceStore') && !promptReady.includes('install marker'));
  const promptMcp = buildSystemPrompt({ workspace: null, taskEnvironment: pEnv });
  check('S7 needs-connection capability is NOT claimed available', promptMcp.includes('NOT connected') || promptMcp.includes('are not connected'));
  const promptNone = buildSystemPrompt({ workspace: null });
  check('S8 no capabilities -> no extension section at all', !promptNone.includes('## Capabilities'));
  const promptEmpty = buildSystemPrompt({ workspace: null, taskEnvironment: prod.buildTaskEnvironment() });
  check('S9 empty environment -> no extension section', !promptEmpty.includes('## Capabilities'));
  // a deliberately deleted instance must not be advertised (present=false)
  await readyMgr._testHome.remove('.skills/synthetic-capability/synthetic-skill.skill');
  await readyMgr.refreshSkillPresence();
  const presentEnv = readyMgr.buildTaskEnvironment();
  check('S10 deleted instance drops out of the prompt index (capability stays listed)',
    presentEnv.capabilities[0].skillPaths.length === 0
    && presentEnv.skills.length === 1 && presentEnv.skills[0].present === false
    && !buildSystemPrompt({ workspace: null, taskEnvironment: presentEnv }).includes('synthetic-skill.skill')
    && buildSystemPrompt({ workspace: null, taskEnvironment: presentEnv }).includes('Synthetic Capability'));
  // error-state capability stays out of the prompt (S11 below)
  const errMgr = newManager();
  unregisterPluginRuntimeProvider('python');
  await errMgr.enable('synthetic-capability');
  const errPrompt = buildSystemPrompt({ workspace: null, taskEnvironment: errMgr.buildTaskEnvironment() });
  check('S11 error-state capability adds no prompt section', !errPrompt.includes('## Capabilities'));
  registerPluginRuntimeProvider('python', synthProvider());

  // budget integration: the index is inside the counted system prompt
  const session = new AgentSession({
    modelClient: async () => ({ content: 'done', rawMessage: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', truncated: false }),
    toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
  });
  const bytesWithout = await session.historyRequestBytes(null, null);
  const bytesWith = await session.historyRequestBytes(null, pEnv);
  check('S12 capability index counts into the request byte budget', bytesWith > bytesWithout && bytesWith - bytesWithout < 4096,
    String(bytesWith - bytesWithout));

  // ================= task VFS mount SPECS (Harness-owned half) =================
  const vEnv = readyEnv;
  // M2b: the manager returns pure SPECS; the product adapter (Product-side
  // suite) builds the providers from them.
  const specProbe = readyMgr.taskVfsMountSpecs(vEnv);
  check('F0 mount specs are pure data (no provider objects from the composition core)',
    specProbe.every((s) => !('provider' in s) && typeof s.path === 'string' && typeof s.files === 'object'));

  // ================= python extension payload/key =================
  const payload = newManager().pythonExtensionPayload(vEnv);
  check('K1 payload key matches the environment', payload.key === vEnv.pythonExtensionKey);
  check('K2 payload carries files + imports', payload.modules.length === 1
    && payload.modules[0].pluginId === 'synthetic-python-plugin'
    && payload.modules[0].files['locus_test_plugin.py'].includes('return 42')
    && payload.modules[0].imports.join() === 'locus_test_plugin');
  check('K3 payload is frozen', Object.isFrozen(payload) && Object.isFrozen(payload.modules) && Object.isFrozen(payload.modules[0]));
  check('K4 key is null without python plugins', prod.buildTaskEnvironment().pythonExtensionKey === null);
  check('K5 key changes with plugin version', (async () => {
    const c = SYNTH_CATALOGS();
    c.plugins[0].version = '2';
    const m = newManager(c);
    await m.enable('synthetic-capability');
    return m.buildTaskEnvironment().pythonExtensionKey === 'synthetic-python-plugin@2';
  })());

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
