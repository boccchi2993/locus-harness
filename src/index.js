// ============================================================
//  LOCUS HARNESS — PUBLIC PACKAGE ENTRY (M3b repository extraction)
//
//  Provenance: evolved from boccchi2993/Locus-browser-agent-runtime
//  (branch refactor/repository-split-m2c) at commit
//  2aec76e78431382873be1db8a6db6310cc89c782, src/harness/index.js
//  (blob ca98615309250b33644a3545b53226dd0ed39b17). Apache-2.0, see
//  LICENSE. The M2b entry resolved a declared __LOCUS_HARNESS_CORE__
//  table (classic pages) or self-assembled one; THIS entry imports the
//  implementations directly — the table, the self-assembly chunk and
//  every page-global publish were deleted at M3b.
//
//  Import-time safety: importing this module performs no fetch, no DOM
//  access, no storage open, no global mutation and starts no task.
//  Every factory below is usable immediately after a plain import —
//  no initialization call is required.
//
//  No HarnessHost/HarnessSession wrappers exist: the entry exposes the
//  existing AgentSession / TaskRunner / provider-sessions surfaces and
//  nothing more.
// ============================================================

// Local bindings: `export { X } from ...` does NOT bind a module-local
// name, and the factories / declaration below reference these values.
import { TASK_OUTCOME_REASONS } from './task-runner.js';
import { AgentSession, HISTORY_BUDGET_BYTES, MAX_TOOL_ITERATIONS } from './agent.js';
import { ApprovalController, APPROVAL_KINDS } from './approval.js';
import { ModelCapabilityRegistry } from './capabilities.js';
import { CapabilityManager } from './extension-composition.js';
export { AgentSession, HISTORY_BUDGET_BYTES, MAX_TOOL_ITERATIONS };
export { ApprovalController, APPROVAL_KINDS };
export { ModelCapabilityRegistry };
export { CapabilityManager };

// ---------- task lifecycle ----------
export {
  createTaskRunner, isPersistenceFailure,
} from './task-runner.js';

// ---------- provider sessions + the REAL replay validators ----------
export { createProviderSessions } from './provider-session.js';
export {
  replayValidationError, validateReplayPrefix, validateNormalizedPrefix,
} from './replay-validation.js';

// ---------- agent loop ----------
export { buildSystemPrompt } from './agent.js';

// The M2b entry exported FACTORIES only (the class resolved through the
// core table at call time). Both surfaces exist here; existing callers
// keep working through the factories.
export function createAgentSession(deps) {
  return new AgentSession(deps);
}

// ---------- model layer ----------
export {
  createModelClient, MODEL_TIMEOUT_MS, MODEL_MAX_RESPONSE_BYTES,
} from './model.js';
export {
  getProviderAdapter, OpenAIAdapter, AnthropicAdapter,
  createProviderIdentity, createCredentialIdentity,
  projectNormalizedHistory, rawReplayIdentityCompatible,
} from './model-adapters.js';

// ---------- approval semantics ----------
export function createApprovalController(opts) {
  return new ApprovalController(opts);
}

// ---------- perception (image capability gating) ----------
export {
  createImageInputGate, runImageInputProbe,
  classifyImageProviderError, imageInputUnavailableNotice,
} from './capabilities.js';
export function createModelCapabilityRegistry(opts) {
  return new ModelCapabilityRegistry(opts);
}

export function createCapabilityManager(opts) {
  return new CapabilityManager(opts);
}

// ---------- capability composition core ----------
export {
  SkillSourceStore, pythonExtensionKeyOf,
  validatePluginPayload, registerPluginRuntimeProvider,
  EXTENSION_ID_PATTERN, EXTENSION_PY_MODULE_PATTERN,
  CAPABILITY_CATALOG, PLUGIN_CATALOG, SKILL_CATALOG, MCP_CATALOG,
} from './extension-composition.js';

// ---------- public descriptor + skill-instance contract (M3b review R1) ----------
// The first-round review audit (EXTRACTION-PLAN §3) found real Product
// consumers of the composition contract that the extraction had left on the
// classic lexical chain and OUT of the public surface: capability-package.js
// normalizes bundle descriptors through the four REAL validators and reads
// the byte bound at module init (its 256 KiB skill contract), and
// extensions.js validates instance paths against skillInstancePath /
// SKILL_INSTANCE_ROOT, hides and refuses the Harness-owned install marker,
// and hashes instance bytes with sha256Hex. These re-exports surface the
// ORIGINAL authoritative definitions (no copies): a consumer that must agree
// with the manager's products — materialized instance paths, the marker
// name, the size bound, descriptor validity, source hashes — reads them
// here, the same values the manager itself uses.
export {
  validateCapabilityDescriptor, validatePluginDescriptor,
  validateSkillDescriptor, validateMcpDescriptor,
  skillInstancePath, SKILL_INSTANCE_ROOT, SKILL_INSTANCE_MARKER,
  SKILL_INSTANCE_MAX_BYTES, sha256Hex,
} from './extension-composition.js';
// Deliberately NOT an entry export: SKILL_DIFF_MAX_CHARS bounds the
// approval-card diff detail — Product presentation policy with no Harness
// consumer (only extensions.js reads it). It moves INTO the Product at M3c
// (EXTRACTION-PLAN §3 caller table), it is not published here.

// Constant accessors (the M2b entry surfaced the two core constants as
// functions because they resolved lazily through the core table; they
// are static module constants here, and the accessor form is kept for
// callers that still call them).
export function historyBudgetBytes() {
  return HISTORY_BUDGET_BYTES;
}

export function maxToolIterations() {
  return MAX_TOOL_ITERATIONS;
}

// ============================================================
//  ensureHarnessCore — NO-ASSEMBLY COMPATIBILITY SHIM (M3b).
//
//  The M2b entry required standalone hosts to `await ensureHarnessCore()`
//  before the factories (it resolved the declared core table or
//  self-assembled it). THIS package has no registry and nothing to
//  assemble: every factory works immediately after `import`. The
//  function remains ONLY so an existing caller that still awaits it
//  keeps working; it performs no work, initializes no registry and
//  resolves to undefined. It must not be called by new code, and it
//  deliberately does NOT return the old internal implementation table.
// ============================================================
export async function ensureHarnessCore() {
  return undefined;
}

// ============================================================
//  M2c: the PUBLIC capability declaration (contract §5), now read from
//  the real implementations DIRECTLY (no table). Every declared item
//  maps to a live implementation and a behavior suite; nothing is
//  declared from presence-sniffing anymore because the implementations
//  are the module graph itself.
//
//  TWO VERSION CONCEPTS, never merged (contract §5):
//    contractVersion — the PUBLIC harness protocol version. 1.
//    registryVersion — the DELETED __LOCUS_HARNESS_CORE__ table's
//                      internal registry version. THE FIELD IS GONE:
//                      with the registry removed there is no honest
//                      value for it, and none is fabricated. A
//                      consumer that required it must adapt (the
//                      Product's supportedRegistryVersions check reads
//                      this field and treats absence as
//                      `capability_missing` — recorded as an M3c
//                      adaptation item in docs/EXTRACTION-PLAN.md).
// Declaring is not checking: the Product owns compatibility decisions;
// this function never judges a consumer.
// ============================================================
function legalKindsList(v) {
  return Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === 'string' && k)
    ? Object.freeze(v.slice()) : null;
}

export function harnessCapabilities() {
  const declaration = {
    contractVersion: 1,
    ports: {},
    capabilities: {},
  };

  // taskLifecycle — the runner's own constants (real enum + real caps).
  declaration.ports.taskLifecycle = Object.freeze({
    version: 1,
    outcomeReasons: TASK_OUTCOME_REASONS,
    maxToolIterations: MAX_TOOL_ITERATIONS,
    historyBudgetBytes: HISTORY_BUDGET_BYTES,
  });

  // toolPort — the per-task frozen transportable-JSON definition snapshot
  // (pinned by the harness-standalone F1/F1b blocks).
  declaration.ports.toolPort = Object.freeze({
    version: 1,
    snapshot: 'per-task-frozen-transportable-json',
  });

  // descriptionPort — OPTIONAL consumer: a session without one simply
  // prompts with no capability claims.
  declaration.ports.descriptionPort = Object.freeze({ version: 1, optional: true });

  // modelClient — captured config/transport/relay per request
  // (pinned by the F2 capture checks + the model/adapter suites).
  declaration.ports.modelClient = Object.freeze({ version: 1, configCaptured: true });

  // approval — kinds declared only when they form a legal string array
  // (the M2c shape rule, kept verbatim: the real APPROVAL_KINDS is the
  // kind→schema table, not a string array, so `kinds` stays OMITTED —
  // exactly as the source entry declared it).
  const kinds = legalKindsList(APPROVAL_KINDS);
  const approval = { version: 1, sessionGrants: true };
  if (kinds) approval.kinds = kinds;
  declaration.ports.approval = Object.freeze(approval);

  // persistencePort — replay validation is Harness-owned and a
  // required-write failure ends the task persistence_error (§4 taxonomy).
  declaration.ports.persistencePort = Object.freeze({
    version: 1,
    replayValidators: 'harness-owned',
    requiredWriteOutcome: 'persistence_error',
  });

  // Semantic capabilities — implementation facts, each pinned by suites.
  declaration.capabilities.nativeToolCalls = true;      // native tool round trip
  declaration.capabilities.textFallbackStrict = true;   // strict fence rules
  declaration.capabilities.taskEventIdentity = true;    // runner identity stamping
  declaration.capabilities.providerReplay = true;       // real validators
  declaration.capabilities.imageInputGate = true;       // the gate trio ships here
  declaration.capabilities.capabilityComposition = true; // the composition core ships here

  return deepFreezeDeclaration(declaration);
}

function deepFreezeDeclaration(value) {
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreezeDeclaration(value[k]);
    Object.freeze(value);
  }
  return value;
}
