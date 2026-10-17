// Capability Packages v1 unit tests (node): incremental registerPackage /
// unregisterPackage on CapabilityManager (docs/CAPABILITY-INSTALL.md §6),
// wheel artifacts as the python plugin payload path (metadata-only wheels
// in the TaskEnvironment snapshot and in validatePluginPayload; the bytes
// stay in the manager's artifact registry and travel only in the python
// extension payload), the pythonExtensionKey wheel-sha suffix, and the
// skill instance UPGRADE rule (§6.3) that replaces the old mismatch error
// when the install marker names the SAME capability. The three-layer skill
// model (Definition / SourceStore / Instance) and the install marker
// mechanism itself stay intact (locus-product docs/DECISIONS.md D6).
//
// The instance-storage double mirrors tests/capability-composition.test.mjs
// (same narrow { readBytes, writeBytes, removeDir, stat } port, same
// NotFoundError name, same observation surface); a subclass arms a marker
// write failure for the upgrade-rollback case.
// Run: node tests/capability-packages.test.mjs

import {
  CapabilityManager, SkillSourceStore,
  validatePluginPayload,
} from '../src/extension-composition.js';
import { harnessCapabilities } from '../src/index.js';

// ---- in-memory durable instance storage (the manager's narrow port) ----
// Copied from tests/capability-composition.test.mjs (same paths, same
// NotFoundError name, same observation view).
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

// CP15: same store, but marker writes fail once armed (the first install
// must succeed, so the failure is armed only for the UPGRADE attempt).
class ArmedMarkerFailStore extends MemoryInstanceStore {
  constructor() { super(); this.armed = false; }
  async writeBytes(rel, bytes) {
    if (this.armed && String(rel).includes('.locus-installed.json')) {
      throw new Error('marker write refused');
    }
    return super.writeBytes(rel, bytes);
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

// ---- package fixtures ----
async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const WHEEL_A = new Uint8Array(48).map((_, i) => (i * 7 + 3) & 0xff);
const WHEEL_B = new Uint8Array(48).map((_, i) => (i * 11 + 5) & 0xff);

async function artifactFor(bytes, filename) {
  return {
    filename: filename || 'plug_a-1.0-py3-none-any.whl',
    format: 'python-wheel',
    size: bytes.byteLength,
    sha256: await sha256hex(bytes),
    bytes: bytes,
  };
}

const plugADescriptor = () => ({
  id: 'plug-a', version: '1', displayName: 'Plug A',
  runtime: 'python', authority: 'none', provides: { pythonImports: ['plug_a'] },
});
const skillDescriptor = (id, version) => ({
  id: id, version: version, displayName: 'Skill ' + id.slice(6).toUpperCase(),
  description: 'package skill ' + id,
});

// The canonical package: capability cap-a with one python plugin (wheel)
// and two skills. Sources/artifacts/skill set/version are overridable so
// the upgrade and rejection scenarios can derive variants from ONE shape.
function pkgA(opts) {
  const o = opts || {};
  const version = o.version || '1';
  const id = o.id || 'cap-a';
  const skills = o.skills || ['skill-a', 'skill-b'];
  const sources = o.sources || Object.fromEntries(skills.map((id) => [id, {
    version: version,
    source: id === 'skill-a' ? (o.aSrc || 'A1') : id === 'skill-b' ? (o.bSrc || 'B1') : (o.cSrc || 'C1'),
  }]));
  return {
    capability: {
      id: id, version: version, displayName: 'Package Capability A',
      description: 'registered from a package', plugins: ['plug-a'], skills: skills, mcps: [],
    },
    plugins: [plugADescriptor()],
    skills: skills.map((id) => skillDescriptor(id, version)),
    mcps: [],
    sources: sources,
    artifacts: o.artifacts || { 'plug-a': o.artifact },
  };
}

// pkgB: capability cap-b sharing plug-a and skill-a with pkgA — the shared
// descriptors and the skill source must be IDENTICAL for co-registration.
function pkgB(artifact) {
  return {
    capability: {
      id: 'cap-b', version: '1', displayName: 'Package Capability B',
      description: 'shares plug-a and skill-a with cap-a', plugins: ['plug-a'], skills: ['skill-a'], mcps: [],
    },
    plugins: [plugADescriptor()],
    skills: [skillDescriptor('skill-a', '1')],
    mcps: [],
    sources: { 'skill-a': { version: '1', source: 'A1' } },
    artifacts: { 'plug-a': artifact },
  };
}

function emptyCatalogs() {
  return { capabilities: [], plugins: [], skills: [], mcps: [] };
}

function newPackageManager(home, catalogs) {
  const m = new CapabilityManager({ catalogs: catalogs || emptyCatalogs(), instances: home });
  m._home = home;
  return m;
}

// A second package shape (D10 §6: packages are the only way a plugin
// enters the manager) — capability syn-cap with one python plugin wheel.
// Used to prove package registration is additive.
const WHEEL_SYN = new Uint8Array(40).map((_, i) => (i * 13 + 1) & 0xff);

async function pkgSyn() {
  return {
    capability: {
      id: 'syn-cap', version: '1', displayName: 'Syn Cap', description: 'synthetic package capability',
      plugins: ['syn-plug'], skills: [], mcps: [],
    },
    plugins: [{
      id: 'syn-plug', version: '1', displayName: 'Syn Plug',
      runtime: 'python', authority: 'none', provides: { pythonImports: ['syn_plug'] },
    }],
    skills: [], mcps: [],
    sources: {},
    artifacts: { 'syn-plug': await artifactFor(WHEEL_SYN, 'syn_plug-1.0-py3-none-any.whl') },
  };
}

async function run() {
  // ================= CP17. capability declaration =================
  check('CP17 harnessCapabilities declares capabilityPackages',
    harnessCapabilities().capabilities.capabilityPackages === true);

  // ================= CP1. registration is additive and starts disabled =================
  const m1 = newPackageManager(new MemoryInstanceStore());
  await m1.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
  const l1 = m1.listCapabilities();
  check('CP1 registered package capability is listed and disabled',
    l1.some((c) => c.id === 'cap-a') && l1.find((c) => c.id === 'cap-a').state === 'disabled'
      && !l1.find((c) => c.id === 'cap-a').enabled);
  check('CP1 isPackage names the registered package',
    m1.isPackage('cap-a') === true && m1.isPackage('nope') === false);

  // ================= CP2. registration leaves other capabilities untouched =================
  const m2 = newPackageManager(new MemoryInstanceStore());
  await m2.registerPackage(await pkgSyn());
  check('CP2 synthetic package capability enables through its registered wheel',
    await m2.enable('syn-cap') === 'ready');
  await m2.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
  check('CP2 package registration keeps the enabled capability enabled',
    m2.isEnabled('syn-cap') && m2.capabilityState('syn-cap') === 'ready'
      && m2.isPackage('cap-a') && m2.capabilityState('cap-a') === 'disabled');

  // ================= CP5. package plugins enable — registered wheel artifacts are the only path =================
  // (the PluginRuntimeProvider seam this block used to contrast against is
  // deleted; see tests/wheel-only-plugins.test.mjs for the wheel-only gate)
  const m5 = newPackageManager(new MemoryInstanceStore());
  await m5.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
  check('CP5 enable of a package capability is ready with no other resolution path',
    await m5.enable('cap-a') === 'ready');

  // ================= CP3. registration rejections leave no half state =================
  const m3 = newPackageManager(new MemoryInstanceStore());
  const goodA = await artifactFor(WHEEL_A);
  const badArtifact = (mutate) => {
    const a = { filename: goodA.filename, format: goodA.format, size: goodA.size, sha256: goodA.sha256, bytes: WHEEL_A };
    mutate(a);
    return a;
  };
  await m3.registerPackage(pkgA({ artifact: goodA }));
  const rejections = [
    ['duplicate capability id', () => m3.registerPackage(pkgA({ artifact: goodA })), 'capability already registered'],
    ['capability references a plugin the package does not ship',
      () => m3.registerPackage({
        capability: { id: 'cap-x', version: '1', displayName: 'X', description: 'd', plugins: ['plug-a', 'plug-ghost'], skills: [], mcps: [] },
        plugins: [plugADescriptor()], skills: [], mcps: [], sources: {}, artifacts: { 'plug-a': goodA },
      }), 'does not ship referenced plugin'],
    ['capability references a skill the package does not ship',
      () => m3.registerPackage({
        capability: { id: 'cap-x', version: '1', displayName: 'X', description: 'd', plugins: ['plug-a'], skills: ['skill-a', 'skill-ghost'], mcps: [] },
        plugins: [plugADescriptor()], skills: [skillDescriptor('skill-a', '1')], mcps: [],
        sources: { 'skill-a': { version: '1', source: 'A1' } }, artifacts: { 'plug-a': goodA },
      }), 'does not ship referenced skill'],
    ['skill without a default source',
      () => m3.registerPackage(pkgA({ id: 'cap-x', artifact: goodA, sources: { 'skill-a': { version: '1', source: 'A1' } } })), 'needs a default source'],
    ['skill source version mismatch',
      () => m3.registerPackage(pkgA({
        id: 'cap-x', artifact: goodA,
        sources: { 'skill-a': { version: '9', source: 'A1' }, 'skill-b': { version: '1', source: 'B1' } },
      })), 'needs a default source'],
    ['plugin without a wheel artifact',
      () => m3.registerPackage(pkgA({ id: 'cap-x', artifact: goodA, artifacts: {} })), 'has no wheel artifact'],
    ['artifact filename is not a plain .whl basename',
      () => m3.registerPackage(pkgA({ id: 'cap-x', artifact: badArtifact((a) => { a.filename = 'plug-a.tar.gz'; }) })), 'plain .whl basename'],
    ['artifact format is not python-wheel',
      () => m3.registerPackage(pkgA({ id: 'cap-x', artifact: badArtifact((a) => { a.format = 'wheel'; }) })), 'format must be "python-wheel"'],
    ['artifact size does not match its bytes',
      () => m3.registerPackage(pkgA({ id: 'cap-x', artifact: badArtifact((a) => { a.size = a.size + 1; }) })), 'bytes do not match the declared size'],
    ['artifact sha256 does not match its bytes',
      () => m3.registerPackage(pkgA({ id: 'cap-x', artifact: badArtifact((a) => { a.sha256 = '0'.repeat(64); }) })), 'sha256 does not match its bytes'],
    ['non-python plugin runtime is not installable from a package',
      () => m3.registerPackage({
        capability: { id: 'cap-x', version: '1', displayName: 'X', description: 'd', plugins: ['plug-js'], skills: [], mcps: [] },
        plugins: [{ id: 'plug-js', version: '1', runtime: 'javascript', authority: 'none', provides: {} }],
        skills: [], mcps: [], sources: {}, artifacts: {},
      }), 'is not installable from a package'],
  ];
  for (let i = 0; i < rejections.length; i++) {
    const [label, fn, msgPart] = rejections[i];
    const before = JSON.stringify(m3.listCapabilities());
    await throwsWith('CP3.' + (i + 1) + ' rejected: ' + label, fn, 'ExtensionDescriptorError', msgPart);
    check('CP3.' + (i + 1) + ' no half registration after: ' + label,
      JSON.stringify(m3.listCapabilities()) === before && m3.isPackage('cap-x') === false);
  }

  // ================= CP4. same-id component conflicts =================
  const m4 = newPackageManager(new MemoryInstanceStore());
  await m4.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
  await throwsWith('CP4.a conflicting wheel bytes for the same plugin id are refused',
    async () => m4.registerPackage(pkgB(await artifactFor(WHEEL_B))),
    'ExtensionDescriptorError', 'conflicts with an already registered plugin');
  await m4.registerPackage(pkgB(await artifactFor(WHEEL_A)));
  check('CP4.b identical shared components co-register',
    m4.listCapabilities().some((c) => c.id === 'cap-b') && m4.isPackage('cap-b'));

  // ================= CP6. the task snapshot carries wheel METADATA only =================
  const m6 = newPackageManager(new MemoryInstanceStore());
  await m6.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
  await m6.enable('cap-a');
  let env6 = null;
  let buildThrew = null;
  try { env6 = m6.buildTaskEnvironment(); } catch (e) { buildThrew = e; }
  check('CP6.a snapshot build does not throw', !buildThrew, buildThrew && String(buildThrew));
  const w0 = env6.plugins[0].payload.wheels[0];
  check('CP6.b snapshot payload has wheels with exactly the safe metadata fields',
    env6.plugins[0].payload.wheels.length === 1
      && JSON.stringify(Object.keys(w0)) === JSON.stringify(['filename', 'format', 'size', 'sha256'])
      && w0.filename === 'plug_a-1.0-py3-none-any.whl' && w0.format === 'python-wheel'
      && w0.size === WHEEL_A.byteLength && w0.sha256 === await sha256hex(WHEEL_A));
  check('CP6.c snapshot wheel carries no bytes', !('bytes' in w0) && w0.bytes === undefined);
  check('CP6.d the snapshot is deeply frozen (wheels included)',
    Object.isFrozen(env6) && Object.isFrozen(env6.plugins) && Object.isFrozen(env6.plugins[0])
      && Object.isFrozen(env6.plugins[0].payload) && Object.isFrozen(env6.plugins[0].payload.wheels)
      && Object.isFrozen(env6.plugins[0].payload.wheels[0]));

  // ================= CP7. python payload carries fresh byte copies =================
  const pay7 = m6.pythonExtensionPayload(env6);
  const bytes7 = pay7.modules[0].wheels[0].bytes;
  const stored7 = m6._artifacts.get('plug-a').bytes;
  check('CP7.a payload wheel bytes equal the registered bytes byte for byte',
    bytes7.byteLength === stored7.byteLength && Array.from(bytes7).every((b, i) => b === stored7[i]));
  check('CP7.b payload bytes are a COPY, not the stored view', bytes7 !== stored7 && bytes7 !== WHEEL_A);
  bytes7[0] = 0xff;
  const pay7b = m6.pythonExtensionPayload(env6);
  check('CP7.c mutating a handed-out copy never affects the next payload',
    pay7b.modules[0].wheels[0].bytes[0] === WHEEL_A[0] && pay7b.modules[0].wheels[0].bytes[0] !== 0xff);
  check('CP7.d payload module keeps pluginId and imports',
    pay7.modules[0].pluginId === 'plug-a' && pay7.modules[0].imports.join() === 'plug_a');

  // ================= CP8. pythonExtensionKey =================
  const kA = newPackageManager(new MemoryInstanceStore());
  await kA.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
  await kA.enable('cap-a');
  const kB = newPackageManager(new MemoryInstanceStore());
  await kB.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_B) }));
  await kB.enable('cap-a');
  const keyA = kA.buildTaskEnvironment().pythonExtensionKey;
  const keyB = kB.buildTaskEnvironment().pythonExtensionKey;
  check('CP8.a same id+version with different wheel bytes yields different keys',
    keyA !== keyB && /^plug-a@1#[0-9a-f]{64}$/.test(keyA) && keyA.startsWith('plug-a@1#'));

  // ================= CP9. validatePluginPayload: wheels only — source text rejected =================
  const plugProbe = plugADescriptor();
  const wheelMeta = { filename: 'plug_a-1.0-py3-none-any.whl', format: 'python-wheel', size: WHEEL_A.byteLength, sha256: await sha256hex(WHEEL_A) };
  await throwsWith('CP9.a payload carrying files is rejected (source text unsupported)',
    () => validatePluginPayload(plugProbe, { files: { 'a.py': 'x' }, wheels: [wheelMeta], imports: [] }),
    'ExtensionResolutionError', 'source-text payloads are no longer supported');
  await throwsWith('CP9.b payload without wheels is rejected',
    () => validatePluginPayload(plugProbe, { imports: [] }),
    'ExtensionResolutionError', 'payload must carry exactly one wheel');
  await throwsWith('CP9.c wheels carrying bytes are rejected',
    () => validatePluginPayload(plugProbe, { wheels: [Object.assign({ bytes: WHEEL_A }, wheelMeta)], imports: [] }),
    'ExtensionResolutionError', 'wheel bytes never travel');
  await throwsWith('CP9.d wheels holding two entries are rejected',
    () => validatePluginPayload(plugProbe, { wheels: [wheelMeta, wheelMeta], imports: [] }),
    'ExtensionResolutionError', 'must hold exactly one wheel');
  const okPayload = validatePluginPayload(plugProbe, { wheels: [wheelMeta], imports: ['plug_a'] });
  check('CP9.e a metadata-only wheels payload validates and normalizes',
    okPayload.wheels.length === 1 && okPayload.wheels[0].sha256 === wheelMeta.sha256
      && !('bytes' in okPayload.wheels[0]) && okPayload.imports.join() === 'plug_a');

  // ================= CP10. unregister with keepInstances =================
  const m10 = newPackageManager(new MemoryInstanceStore());
  await m10.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
  await m10.enable('cap-a');
  await m10.unregisterPackage('cap-a', { keepInstances: true });
  check('CP10.a the capability leaves the list and the package registry',
    !m10.listCapabilities().some((c) => c.id === 'cap-a') && m10.isPackage('cap-a') === false
      && m10.isEnabled('cap-a') === false);
  check('CP10.b the skill instance files and marker survive (keepInstances)',
    (await m10._home.read('cap-a/skill-a.skill')) === 'A1'
      && (await m10._home.read('cap-a/skill-b.skill')) === 'B1'
      && JSON.parse(await m10._home.read('cap-a/.locus-installed.json')).capabilityVersion === '1');

  // ================= CP11. unregister without keepInstances =================
  const m11 = newPackageManager(new MemoryInstanceStore());
  await m11.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
  await m11.enable('cap-a');
  await m11.unregisterPackage('cap-a');
  check('CP11 the capability-private instance directory is deleted',
    !(await m11._home.exists('cap-a/skill-a.skill'))
      && !(await m11._home.exists('cap-a/skill-b.skill'))
      && !(await m11._home.exists('cap-a/.locus-installed.json')));
  await throwsWith('CP11.b unregistering a non-package id throws',
    () => m11.unregisterPackage('cap-a'), 'not a registered package');

  // ================= CP12. shared components survive one package's unregister =================
  const m12 = newPackageManager(new MemoryInstanceStore());
  await m12.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
  await m12.registerPackage(pkgB(await artifactFor(WHEEL_A)));
  await m12.enable('cap-a');
  await m12.unregisterPackage('cap-a', { keepInstances: true });
  check('CP12.a cap-b still enables after cap-a was unregistered (shared skill-a)',
    await m12.enable('cap-b') === 'ready');
  check('CP12.b cap-b materialized its OWN instance from the retained source',
    (await m12._home.read('cap-b/skill-a.skill')) === 'A1');

  // ================= CP13. the skill instance upgrade rule =================
  // (a) untouched user files are overwritten with the new defaults.
  {
    const home = new MemoryInstanceStore();
    const m = newPackageManager(home);
    await m.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
    await m.enable('cap-a');
    await m.unregisterPackage('cap-a', { keepInstances: true });
    await m.registerPackage(pkgA({ version: '2', aSrc: 'A2', bSrc: 'B2', artifact: await artifactFor(WHEEL_A) }));
    check('CP13.a enable after version bump is ready',
      await m.enable('cap-a') === 'ready');
    check('CP13.a untouched files were overwritten with the new defaults',
      (await home.read('cap-a/skill-a.skill')) === 'A2' && (await home.read('cap-a/skill-b.skill')) === 'B2');
    const marker = JSON.parse(await home.read('cap-a/.locus-installed.json'));
    check('CP13.a the marker was rewritten with the new version',
      marker.capabilityVersion === '2' && marker.capabilityId === 'cap-a' && marker.skills.length === 2);
  }
  // (b) a user-customized file survives EVERY upgrade (v1->v2 and v2->v3).
  {
    const home = new MemoryInstanceStore();
    const m = newPackageManager(home);
    await m.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
    await m.enable('cap-a');
    await m.unregisterPackage('cap-a', { keepInstances: true });
    await home.writeBytes('cap-a/skill-b.skill', new TextEncoder().encode('B-custom'));
    await m.registerPackage(pkgA({ version: '2', aSrc: 'A2', bSrc: 'B2', artifact: await artifactFor(WHEEL_A) }));
    check('CP13.b.v2 enable with a customized skill is ready',
      await m.enable('cap-a') === 'ready');
    check('CP13.b.v2 the untouched file upgraded, the customized file kept',
      (await home.read('cap-a/skill-a.skill')) === 'A2' && (await home.read('cap-a/skill-b.skill')) === 'B-custom');
    await m.unregisterPackage('cap-a', { keepInstances: true });
    await m.registerPackage(pkgA({ version: '3', aSrc: 'A3', bSrc: 'B3', artifact: await artifactFor(WHEEL_A) }));
    check('CP13.b.v3 the v2->v3 upgrade is ready too',
      await m.enable('cap-a') === 'ready');
    check('CP13.b.v3 the customized file is still recognized as edited and kept',
      (await home.read('cap-a/skill-a.skill')) === 'A3' && (await home.read('cap-a/skill-b.skill')) === 'B-custom');
  }
  // (c) a deliberately deleted file stays deleted across the upgrade.
  {
    const home = new MemoryInstanceStore();
    const m = newPackageManager(home);
    await m.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
    await m.enable('cap-a');
    await m.unregisterPackage('cap-a', { keepInstances: true });
    home.remove('cap-a/skill-a.skill');
    await m.registerPackage(pkgA({ version: '2', aSrc: 'A2', bSrc: 'B2', artifact: await artifactFor(WHEEL_A) }));
    check('CP13.c enable after a user deletion is ready',
      await m.enable('cap-a') === 'ready');
    check('CP13.c the deleted file stays absent, the other file upgraded',
      !(await home.exists('cap-a/skill-a.skill')) && (await home.read('cap-a/skill-b.skill')) === 'B2');
  }

  // ================= CP14. added and removed skills =================
  {
    const home = new MemoryInstanceStore();
    const m = newPackageManager(home);
    await m.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
    await m.enable('cap-a');
    await m.unregisterPackage('cap-a', { keepInstances: true });
    await m.registerPackage(pkgA({
      version: '2', aSrc: 'A2', cSrc: 'C2', skills: ['skill-a', 'skill-c'],
      artifact: await artifactFor(WHEEL_A),
    }));
    check('CP14 enable with a new skill set is ready', await m.enable('cap-a') === 'ready');
    check('CP14 the new skill got its default, the removed skill stays on disk as an orphan',
      (await home.read('cap-a/skill-c.skill')) === 'C2'
        && (await home.read('cap-a/skill-b.skill')) === 'B1');
    const env = m.buildTaskEnvironment();
    const capSkills = env.skills.filter((s) => s.capabilityId === 'cap-a').map((s) => s.skillId).sort();
    check('CP14 the orphan skill is absent from the task environment',
      JSON.stringify(capSkills) === JSON.stringify(['skill-a', 'skill-c'])
        && !env.skills.some((s) => s.skillId === 'skill-b'));
  }

  // ================= CP15. a failed upgrade rolls back =================
  {
    const home = new ArmedMarkerFailStore();
    const m = newPackageManager(home);
    await m.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
    await m.enable('cap-a');
    await m.unregisterPackage('cap-a', { keepInstances: true });
    home.armed = true; // only the marker write fails from here on
    await m.registerPackage(pkgA({ version: '2', aSrc: 'A2', bSrc: 'B2', artifact: await artifactFor(WHEEL_A) }));
    check('CP15.a the failed upgrade puts the capability into error state',
      await m.enable('cap-a') === 'error');
    check('CP15.b the error names the upgrade failure',
      /skill instance upgrade failed/.test(m.listCapabilities().find((c) => c.id === 'cap-a').error || ''));
    check('CP15.c overwritten files were restored to their pre-upgrade content',
      (await home.read('cap-a/skill-a.skill')) === 'A1' && (await home.read('cap-a/skill-b.skill')) === 'B1');
    check('CP15.d the old marker is still in place',
      JSON.parse(await home.read('cap-a/.locus-installed.json')).capabilityVersion === '1');
  }

  // ================= CP16. a foreign marker still fails like before =================
  {
    const home = new MemoryInstanceStore();
    const m = newPackageManager(home);
    await m.registerPackage(pkgA({ artifact: await artifactFor(WHEEL_A) }));
    await m.enable('cap-a');
    const marker = JSON.parse(await home.read('cap-a/.locus-installed.json'));
    marker.capabilityId = 'some-other-capability';
    await home.writeBytes('cap-a/.locus-installed.json', new TextEncoder().encode(JSON.stringify(marker)));
    await m.unregisterPackage('cap-a', { keepInstances: true });
    await m.registerPackage(pkgA({ version: '2', aSrc: 'A2', bSrc: 'B2', artifact: await artifactFor(WHEEL_A) }));
    check('CP16 a marker naming a DIFFERENT capability still reports the old mismatch error',
      await m.enable('cap-a') === 'error'
        && /do not match the current catalog/.test(m.listCapabilities().find((c) => c.id === 'cap-a').error || ''));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
