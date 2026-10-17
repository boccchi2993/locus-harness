// Wheel-only plugins gate (locus-product docs/DECISIONS.md D10 §6, as
// implemented in docs/CAPABILITY-INSTALL.md §6.2/§6.3): a plugin enters
// Python ONLY as a verified wheel artifact registered with its capability
// package via registerPackage. The source-text (files) payload path and
// the PluginRuntimeProvider seam are deleted, so this suite pins:
//   WO1  enable() of a catalog plugin with NO registered wheel artifact
//        fails loudly into state "error" (never a silent skip),
//   WO2  validatePluginPayload rejects source-text payloads outright and
//        demands wheels,
//   WO3  the public entry no longer exports the provider seam,
//   WO4  neither the TaskEnvironment snapshot nor the python extension
//        payload carries a `files` field anywhere,
//   WO5  harnessCapabilities() declares wheelOnlyPlugins.
// Run: node tests/wheel-only-plugins.test.mjs

import * as entry from '../src/index.js';
import {
  CapabilityManager, validatePluginPayload,
} from '../src/extension-composition.js';
import { harnessCapabilities } from '../src/index.js';

// ---- in-memory durable instance storage (the manager's narrow port) ----
// Copied from tests/capability-packages.test.mjs (same narrow contract).
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
}

function notFound(rel) {
  const e = new Error('not found: ' + rel);
  e.name = 'NotFoundError';
  return e;
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const WHEEL = new Uint8Array(48).map((_, i) => (i * 7 + 3) & 0xff);

// Catalogs whose capability declares a python plugin, with NO package
// (and therefore NO verified wheel artifact) registered for it.
function artifactlessCatalogs() {
  return {
    plugins: [{
      id: 'wo-plug', version: '1', displayName: 'WO Plug',
      runtime: 'python', authority: 'none', provides: { pythonImports: ['wo_plug'] },
    }],
    skills: [], mcps: [],
    capabilities: [{
      id: 'wo-cap', version: '1', displayName: 'WO Cap', description: 'declares a plugin, ships no package',
      plugins: ['wo-plug'], skills: [], mcps: [],
    }],
  };
}

// The same capability arriving the ONLY allowed way: a package with the
// verified wheel artifact.
async function woPkg() {
  return {
    capability: {
      id: 'wo-cap', version: '1', displayName: 'WO Cap', description: 'registered from a package',
      plugins: ['wo-plug'], skills: [], mcps: [],
    },
    plugins: [{
      id: 'wo-plug', version: '1', displayName: 'WO Plug',
      runtime: 'python', authority: 'none', provides: { pythonImports: ['wo_plug'] },
    }],
    skills: [], mcps: [],
    sources: {},
    artifacts: {
      'wo-plug': {
        filename: 'wo_plug-1.0-py3-none-any.whl',
        format: 'python-wheel',
        size: WHEEL.byteLength,
        sha256: await sha256hex(WHEEL),
        bytes: WHEEL,
      },
    },
  };
}

// True when NO key named `wanted` exists anywhere in the value graph
// (typed arrays are skipped — they carry the wheel bytes).
function hasKeyDeep(value, wanted, seen) {
  const s = seen || new Set();
  if (!value || typeof value !== 'object' || s.has(value)) return false;
  s.add(value);
  for (const k of Object.keys(value)) {
    if (k === wanted) return true;
    if (hasKeyDeep(value[k], wanted, s)) return true;
  }
  return false;
}

async function run() {
  // ================= WO1. enable without a registered artifact fails loudly =================
  const m1 = new CapabilityManager({ catalogs: artifactlessCatalogs(), instances: new MemoryInstanceStore() });
  check('WO1 enable of a plugin without a registered wheel artifact is error',
    await m1.enable('wo-cap') === 'error');
  check('WO1 the error names the missing wheel artifact',
    /no verified wheel artifact is registered/.test(m1.listCapabilities().find((c) => c.id === 'wo-cap').error || ''));
  check('WO1 the error capability contributes nothing to the task environment',
    m1.buildTaskEnvironment().plugins.length === 0
      && m1.buildTaskEnvironment().capabilities[0].pluginIds.length === 0);

  // Positive control: the SAME capability registered as a package enables.
  const m1b = new CapabilityManager({ catalogs: { plugins: [], skills: [], mcps: [], capabilities: [] }, instances: new MemoryInstanceStore() });
  await m1b.registerPackage(await woPkg());
  check('WO1 positive control: the package-registered capability is ready',
    await m1b.enable('wo-cap') === 'ready');

  // ================= WO2. validatePluginPayload: source text is gone =================
  const probe = { id: 'wo-plug' };
  let filesError = null;
  try {
    validatePluginPayload(probe, { files: { 'wo_plug.py': 'x = 1\n' }, imports: [] });
  } catch (e) { filesError = e; }
  check('WO2 a files payload is rejected with the wheel-only message',
    !!filesError && /source-text payloads are no longer supported/.test(filesError.message),
    filesError && filesError.message);
  let emptyError = null;
  try {
    validatePluginPayload(probe, { imports: [] });
  } catch (e) { emptyError = e; }
  check('WO2 a payload without wheels is rejected',
    !!emptyError && /payload must carry exactly one wheel/.test(emptyError.message),
    emptyError && emptyError.message);
  let nullError = null;
  try {
    validatePluginPayload(probe, null);
  } catch (e) { nullError = e; }
  check('WO2 a null payload is rejected', !!nullError);
  const ok = validatePluginPayload(probe, {
    wheels: [{
      filename: 'wo_plug-1.0-py3-none-any.whl',
      format: 'python-wheel',
      size: WHEEL.byteLength,
      sha256: await sha256hex(WHEEL),
    }],
    imports: [],
  });
  check('WO2 positive control: a metadata-only wheels payload still validates',
    ok.wheels.length === 1 && !('bytes' in ok.wheels[0]) && !('files' in ok));

  // ================= WO3. the provider seam left the public entry =================
  const gone = ['registerPluginRuntimeProvider', 'pluginRuntimeProvider', 'unregisterPluginRuntimeProvider']
    .filter((n) => n in entry);
  check('WO3 the entry no longer exports the PluginRuntimeProvider seam',
    gone.length === 0, JSON.stringify(gone));
  check('WO3 positive control: the entry still exports the composition surface',
    'validatePluginPayload' in entry && 'CapabilityManager' in entry && 'harnessCapabilities' in entry);

  // ================= WO4. no `files` field anywhere in the task surfaces =================
  const m4 = new CapabilityManager({ catalogs: { plugins: [], skills: [], mcps: [], capabilities: [] }, instances: new MemoryInstanceStore() });
  await m4.registerPackage(await woPkg());
  await m4.enable('wo-cap');
  const env = m4.buildTaskEnvironment();
  const payload = m4.pythonExtensionPayload(env);
  check('WO4 the TaskEnvironment snapshot carries no files field',
    !hasKeyDeep(env, 'files'));
  check('WO4 the snapshot payload is wheels-shaped',
    env.plugins.length === 1 && env.plugins[0].payload.wheels.length === 1
      && !('files' in env.plugins[0].payload));
  check('WO4 the python extension payload carries no files field',
    !hasKeyDeep(payload, 'files') && payload.modules.length === 1
      && payload.modules[0].wheels.length === 1 && !('files' in payload.modules[0]));

  // ================= WO5. the capability declaration =================
  check('WO5 harnessCapabilities declares wheelOnlyPlugins',
    harnessCapabilities().capabilities.wheelOnlyPlugins === true);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
