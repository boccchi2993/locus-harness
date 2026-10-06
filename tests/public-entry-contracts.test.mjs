// Public-entry contract test (M3b review round 1 — F1).
//
// The extraction-plan §3 audit promised the skill-instance contract data
// (SKILL_INSTANCE_MAX_BYTES) and the descriptor validators through the
// PUBLIC entry, and the first-round review found real Product callers the
// audit had missed (capability-package.js normalizeDescriptor + the 256 KiB
// init read; extensions.js SkillInstanceWorkspace path/marker/identity and
// hashing) — all consumed through the classic lexical chain at 2aec76e,
// none reachable from 'locus-harness' at eb70f85.
//
// THIS suite imports ONLY the public entry ('../src/index.js' — the file
// the package exports map points '.' at). It must never fall back to an
// internal module path: a missing ENTRY export is exactly the defect this
// suite exists to catch. C5 enforces that discipline on the file itself.
//
// First-failure record: on unmodified eb70f85 the dynamic entry import
// resolves but every symbol group below is absent (evidence captured in
// docs/M3B-VERIFICATION.md §1); a static named import fails at module
// linkage, which is what breaks a real consumer build (proven out of
// checkout with the eb70f85 tarball — same document).
// Run: node tests/public-entry-contracts.test.mjs

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// C5 first: this file's ONLY package import is the public entry.
{
  const self = readFileSync(new URL(import.meta.url), 'utf8');
  const specs = [...self.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    .concat([...self.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]));
  const internal = specs.filter((s) => s.startsWith('../src/') && s !== '../src/index.js');
  check('C5 this suite imports only the public entry (no internal module path)',
    internal.length === 0, JSON.stringify({ specs, internal }));
}

const entry = await import('../src/index.js');

// ---------- C1. the documented contract symbols exist at the entry ----------
{
  const fns = [
    'validateCapabilityDescriptor', 'validatePluginDescriptor',
    'validateSkillDescriptor', 'validateMcpDescriptor',
    'skillInstancePath', 'sha256Hex',
  ];
  const missingFns = fns.filter((n) => typeof entry[n] !== 'function');
  check('C1 the four descriptor validators + skill path + sha256Hex are entry functions',
    missingFns.length === 0, JSON.stringify(missingFns));
  check('C1 SKILL_INSTANCE_MAX_BYTES is an entry constant (the 256 KiB skill contract)',
    typeof entry.SKILL_INSTANCE_MAX_BYTES === 'number' && entry.SKILL_INSTANCE_MAX_BYTES > 0,
    String(entry.SKILL_INSTANCE_MAX_BYTES));
  check('C1 SKILL_INSTANCE_ROOT is an entry constant (the instance tree root)',
    typeof entry.SKILL_INSTANCE_ROOT === 'string' && entry.SKILL_INSTANCE_ROOT.length > 0,
    JSON.stringify(entry.SKILL_INSTANCE_ROOT));
  check('C1 SKILL_INSTANCE_MARKER is an entry constant (the install-marker file name)',
    typeof entry.SKILL_INSTANCE_MARKER === 'string'
    && entry.SKILL_INSTANCE_MARKER.length > 0 && entry.SKILL_INSTANCE_MARKER.startsWith('.'),
    JSON.stringify(entry.SKILL_INSTANCE_MARKER));
}

// ---------- C2/C3. the entry validators are the REAL descriptor schema ----------
const descriptorError = (e) =>
  !!e && e.name === 'ExtensionDescriptorError' && e.code === 'extension_descriptor_invalid';

{
  const cap = entry.validateCapabilityDescriptor({
    id: 'entry-cap', version: '1.0', displayName: 'Entry Capability',
    description: 'from the public entry',
    plugins: ['p1'], skills: ['s1'], mcps: ['m1'],
  });
  check('C2 a legal capability descriptor normalizes through the entry validator',
    cap.kind === 'capability' && cap.id === 'entry-cap' && cap.version === '1.0'
    && cap.plugins.join() === 'p1' && cap.skills.join() === 's1' && cap.mcps.join() === 'm1',
    JSON.stringify(cap));

  let capBad = null;
  try { entry.validateCapabilityDescriptor({ id: 'entry-cap', version: '1.0', description: 'x' }); }
  catch (e) { capBad = e; }
  check('C2 an illegal capability descriptor (missing displayName) fails loudly',
    descriptorError(capBad), capBad && (capBad.name + ': ' + capBad.message));

  const plugin = entry.validatePluginDescriptor({
    id: 'entry-plugin', version: '1', runtime: 'python', authority: 'none',
    provides: { pythonImports: ['mod'] },
  });
  check('C3 a legal plugin descriptor keeps v1 authority "none"',
    plugin.kind === 'plugin' && plugin.authority === 'none'
    && plugin.provides.pythonImports.join() === 'mod',
    JSON.stringify(plugin));

  let pluginBad = null;
  try { entry.validatePluginDescriptor({ id: 'entry-plugin', version: '1', runtime: 'python', authority: 'network' }); }
  catch (e) { pluginBad = e; }
  check('C3 a plugin descriptor with v1-forbidden authority fails loudly',
    descriptorError(pluginBad), pluginBad && (pluginBad.name + ': ' + pluginBad.message));

  const skill = entry.validateSkillDescriptor({ id: 'entry-skill', version: '2', description: 'guide' });
  check('C3 a legal skill descriptor normalizes (metadata only)',
    skill.kind === 'skill' && skill.id === 'entry-skill' && skill.version === '2',
    JSON.stringify(skill));

  let skillBad = null;
  try { entry.validateSkillDescriptor({ id: 'entry-skill', version: '2', description: 'g', body: 'smuggled' }); }
  catch (e) { skillBad = e; }
  check('C3 a skill descriptor smuggling an inline body fails loudly',
    descriptorError(skillBad), skillBad && (skillBad.name + ': ' + skillBad.message));

  const mcp = entry.validateMcpDescriptor({ id: 'entry-mcp', displayName: 'Entry MCP' });
  check('C3 a legal MCP requirement descriptor normalizes',
    mcp.kind === 'mcp' && mcp.id === 'entry-mcp', JSON.stringify(mcp));

  let mcpBad = null;
  try { entry.validateMcpDescriptor({ id: '../traversal' }); }
  catch (e) { mcpBad = e; }
  check('C3 an MCP descriptor with a non-path-safe id fails loudly',
    descriptorError(mcpBad), mcpBad && (mcpBad.name + ': ' + mcpBad.message));
}

// ---------- C4. the public skill contract agrees with the REAL manager ----------
// No hand-copied numbers or paths: the marker name, tree root, size bound
// and path function all come from the entry, and the comparison target is
// what a real CapabilityManager materializes into the instance-storage port.
{
  const sources = new entry.SkillSourceStore();
  let tooBig = null;
  try { sources.define('too-big', '1', 'x'.repeat(entry.SKILL_INSTANCE_MAX_BYTES + 1)); }
  catch (e) { tooBig = e; }
  check('C4 SkillSourceStore rejects a source over the ENTRY byte contract',
    descriptorError(tooBig) && tooBig.message.includes(String(entry.SKILL_INSTANCE_MAX_BYTES)),
    tooBig && tooBig.message);

  const skillText = '# entry contract skill\nreal manager materializes this\n';
  const skillBytes = new TextEncoder().encode(skillText);
  sources.define('entry-skill', '1', skillText);

  const files = new Map(); // rel (root-relative) -> Uint8Array
  const notFound = () => { const e = new Error('nf'); e.name = 'NotFoundError'; return e; };
  const instances = {
    async readBytes(rel) { if (!files.has(rel)) throw notFound(); return files.get(rel); },
    async writeBytes(rel, bytes) { files.set(rel, new Uint8Array(bytes)); },
    async removeDir(capId) { for (const k of [...files.keys()]) if (k.startsWith(capId + '/')) files.delete(k); },
    async stat(rel) { if (!files.has(rel)) throw notFound(); return { kind: 'file' }; },
  };
  const manager = entry.createCapabilityManager({
    catalogs: {
      capabilities: [{ id: 'entry-cap', version: '1.0', displayName: 'Entry Capability',
        description: 'd', skills: ['entry-skill'] }],
      skills: [{ id: 'entry-skill', version: '1', description: 'guide' }],
    },
    sources,
    instances,
  });
  const state = await manager.enable('entry-cap');
  check('C4 the manager enables the entry-validated catalog to ready',
    state === 'ready', String(state));

  // The materialized instance sits at EXACTLY the public path function's
  // value, relative to the public root — not at a test-copied path.
  const expectedAbs = entry.skillInstancePath('entry-cap', 'entry-skill');
  check('C4 skillInstancePath derives <root>/<capabilityId>/<skillId>.skill',
    expectedAbs === entry.SKILL_INSTANCE_ROOT + '/entry-cap/entry-skill.skill', expectedAbs);
  const expectedRel = expectedAbs.slice(entry.SKILL_INSTANCE_ROOT.length + 1);
  check('C4 the manager materialized the instance at the public path',
    files.has(expectedRel), JSON.stringify([...files.keys()]));

  // The install marker sits at the public marker name; its recorded source
  // hash equals what the PUBLIC sha256Hex computes over the same bytes.
  const markerRel = 'entry-cap/' + entry.SKILL_INSTANCE_MARKER;
  const markerBytes = files.get(markerRel);
  check('C4 the install marker is written at the public marker name',
    markerBytes instanceof Uint8Array, JSON.stringify([...files.keys()]));
  let marker = null;
  try { marker = JSON.parse(new TextDecoder().decode(markerBytes)); } catch (e) { marker = null; }
  const publicHash = await entry.sha256Hex(skillBytes);
  check('C4 the marker records the source hash the public sha256Hex computes',
    !!marker && Array.isArray(marker.skills) && marker.skills.length === 1
    && marker.skills[0].id === 'entry-skill' && marker.skills[0].sourceHash === publicHash,
    JSON.stringify(marker));

  // The TaskEnvironment carries the same identity.
  const env = manager.buildTaskEnvironment();
  check('C4 the TaskEnvironment instance path equals the public path function',
    env.skills.length === 1 && env.skills[0].path === expectedAbs && env.skills[0].present === true,
    JSON.stringify(env.skills));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
