// ============================================================
//  APPROVAL FRAMEWORK v1 (UI-independent)
//  Provenance: extracted from boccchi2993/Locus-browser-agent-runtime
//  (branch refactor/repository-split-m2c) at commit
//  2aec76e78431382873be1db8a6db6310cc89c782, src/approval.js
//  (blob 7e3189181332a35855996c12e2a24f63ba74cf71). Apache-2.0, see LICENSE. M3b conversion: real ESM
//  exports replace the classic globalThis publishes / declared core
//  table; the algorithmic content is unchanged.
//
//  A suspendable approval primitive: the Harness asks, the current
//  async execution PAUSES on a pending Promise, the UI renders a card,
//  a human decides, and the SAME Promise resolves so the SAME task
//  continues. Approval is suspension, never task termination — a deny
//  only rejects the current action; cancelling the task flows through
//  the AbortSignal and resolves the request as 'cancelled'.
//
//  Two separate layers (docs/APPROVALS.md):
//    Authority — what the runtime can technically access (VFS mounts,
//                workspace permissions, provider boundaries). Owned
//                elsewhere; never touched by this module.
//    Approval  — whether an action the Harness already judged technically
//                executable needs human consent first.
//
//  Invariants enforced here:
//    - Hard authority cannot be bypassed by approval. Approval can reduce
//      autonomy; it cannot manufacture authority.
//    - Requests are constructed by the Harness. The model cannot supply
//      policy keys, buttons, or HTML — every request field is validated
//      and carried as plain text.
//    - At most ONE pending interactive request. A second request while
//      one is unresolved fails loudly (ApprovalBusyError) instead of
//      queueing or overwriting.
//    - Every request has a unique id; resolving/cancelling a stale id is
//      a no-op. Old UI decisions can never land on a newer request.
//    - Session grants are exact-normalized-policyKey matches held in
//      memory only ("Allow for this session" = this page session). They
//      never persist and never widen authority.
//    - C3: persistent grants are exact-normalized-policyKey matches held
//      in memory AND mirrored to the persistentGrants port ("Allow
//      always" survives the page). Decision order: persistent grant →
//      session grant → interactive ask. Without the port, scope
//      'persistent' is unsupported (invalid_scope) — never downgraded.
//      A failed durable store retracts the persistent grant to a session
//      grant (the user's allow stands); a failed load fails CLOSED.
//    - Decisions are structured ({ outcome, scope, requestId }), never a
//      bare boolean: 'allow once' and 'allow for session' differ, and
//      'deny' is distinct from 'cancelled'.
//    - Observer callbacks (onChange/onEvent) are presentation/debug
//      surfaces, never control flow: a throwing observer is contained
//      and reported console-only. It cannot decide outcomes, block
//      Promise settlement, strand pending state or auto-allow.
//    - An allow decision authorizes an ACTION, not task liveness. What
//      happens between decision delivery and the start of the protected
//      side effect is known only to the consumer, which MUST re-check
//      the task AbortSignal immediately before that side effect
//      (docs/APPROVALS.md, "Consumer execution contract"). This
//      controller deliberately does not enforce task liveness.
//
//  The controller is framework/DOM/Vue/provider/tool independent. The
//  pending state owner is this class; UI stores are projections via the
//  onChange callback.
// ============================================================

function approvalMakeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function ApprovalError(message, code) {
  const e = new Error(message);
  e.name = 'ApprovalError';
  e.code = code || 'approval_error';
  return e;
}

function ApprovalBusyError(message) {
  const e = ApprovalError(message, 'approval_busy');
  e.name = 'ApprovalBusyError';
  return e;
}

// kind → fixed decision schema. UI choice sets are derived from the kind,
// never from caller/model data. 'permission' is the only kind v1 consumes;
// 'capability' (e.g. image-input: yes/no/unsure) and 'confirmation' are
// reserved schemas so the controller is not hardwired to allow/deny.
// C3: persistentScope marks the kinds whose allow decisions may carry
// scope 'persistent' (a durable grant), mirroring sessionScope.
const APPROVAL_KINDS = {
  permission: { outcomes: ['allow', 'deny'], sessionScope: true, persistentScope: true },
  capability: { outcomes: ['confirm', 'decline', 'unsure'], sessionScope: false, persistentScope: false },
  confirmation: { outcomes: ['confirm', 'cancel'], sessionScope: false, persistentScope: false },
};

// Grants match the EXACT normalized policy key: trim, require non-empty.
// Model-supplied strings ("*", "allow everything") are just keys that were
// never granted — only a Harness-constructed request can create a grant.
function normalizePolicyKey(key) {
  if (typeof key !== 'string') return null;
  const k = key.trim();
  return k ? k : null;
}

function normalizeText(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

// Observer failure containment (docs/APPROVALS.md, "Observer failures"):
// onChange/onEvent are best-effort presentation/debug observers. A throw
// from either must NEVER re-enter approval control flow — it cannot
// settle, reject or strand a request, cannot mint or drop a grant and
// cannot auto-allow. Failures are reported console-only: never as a
// semantic Agent event and never into provider/model history.
function safeNotify(label, invoke) {
  try {
    invoke();
  } catch (error) {
    try {
      console.error('ApprovalController: ' + label + ' observer threw (contained):', error);
    } catch (ignored) {}
  }
}

function normalizeAction(action) {
  const a = action && typeof action === 'object' ? action : {};
  return {
    type: normalizeText(a.type),
    summary: normalizeText(a.summary),
    detail: normalizeText(a.detail),
  };
}

function normalizeResource(resource) {
  if (!resource || typeof resource !== 'object') return null;
  const r = {
    type: normalizeText(resource.type),
    key: normalizeText(resource.key),
    label: normalizeText(resource.label),
  };
  return (r.type || r.key || r.label) ? r : null;
}

// ------------------------------------------------------------
//  ApprovalController
//
//  new ApprovalController({ onChange, onEvent })
//    onChange(pending | null) — projection hook for UI stores. The
//                  controller stays the canonical pending-state owner.
//                  Best-effort: a throwing projection is contained and
//                  never blocks settlement or strands pending state.
//    onEvent(name, data)    — lightweight debug hook (best-effort, same
//                  containment):
//                  approval_requested / approval_resolved /
//                  approval_cancelled / approval_grant_added /
//                  approval_grant_hit / approval_grants_cleared /
//                  approval_persistent_load_failed /
//                  approval_persistent_store_failed /
//                  approval_persistent_remove_failed
//
//  request(spec, { signal }) → Promise<decision>
//    spec: { kind, action: { type, summary, detail },
//            resource: { type, key, label }, policyKey,
//            conversationId, taskGeneration }
//    decision: { outcome: 'allow'|'deny'|'cancelled', scope: 'once'|'session'|'persistent',
//                requestId, reason? }
//  request() NEVER rejects — including when an observer callback throws.
//  A delivered decision authorizes the action only; task liveness after
//  delivery is the consumer's responsibility (final AbortSignal recheck
//  immediately before the protected side effect — docs/APPROVALS.md,
//  "Consumer execution contract").
//  resolve(requestId, decision) / cancel(requestId, reason) /
//  cancelAll(reason) / clearSessionGrants() / hasPending() /
//  loadPersistentGrants() / listPersistentGrants() /
//  revokePersistentGrant(policyKey) / clearPersistentGrants()   (C3)
// ------------------------------------------------------------
class ApprovalController {
  constructor(options) {
    const o = options || {};
    this._onChange = typeof o.onChange === 'function' ? o.onChange : function () {};
    this._onEvent = typeof o.onEvent === 'function' ? o.onEvent : function () {};
    this._pending = null;        // canonical request while unresolved
    this._resolvePending = null; // resolves the request() Promise
    this._signal = null;
    this._signalHandler = null;
    this._grants = new Map();    // normalized policyKey → { requestId, createdAt }
    // C3: optional durable-grant port { load, add, remove } — every method
    // may return a Promise. The port counts only COMPLETE (all three
    // functions); anything else is "no port", and scope 'persistent' is
    // then unsupported (invalid_scope), never silently downgraded. The
    // in-memory set is the decision authority for this page session; the
    // port only feeds it (load) and mirrors it (add/remove).
    const port = o.persistentGrants;
    this._persistentPort = port && typeof port === 'object'
      && typeof port.load === 'function'
      && typeof port.add === 'function'
      && typeof port.remove === 'function' ? port : null;
    this._persistent = new Set(); // normalized policyKeys with a durable grant
    this._seq = 0;
  }

  // Canonical pending request (read-only projection source).
  get pending() { return this._pending; }

  hasPending() { return !!this._pending; }

  hasSessionGrant(policyKey) {
    const k = normalizePolicyKey(policyKey);
    return !!k && this._grants.has(k);
  }

  clearSessionGrants() {
    this._grants.clear();
    safeNotify('onEvent', () => this._onEvent('approval_grants_cleared', {}));
  }

  // ---- persistent grants (C3) ----
  // Durable "allow" decisions for exact normalized policyKeys, held in the
  // in-memory set (decision authority for this page session) and mirrored
  // to the persistentGrants port (the durable store — Product-owned).
  // Decision order: persistent grant → session grant → interactive ask.

  // Feed the in-memory set from the port. Fail CLOSED: a failed load
  // leaves (and resets to) an EMPTY set — durable grants must never keep
  // auto-allowing over an unknown storage state — and the failure
  // surfaces as an event, never a rejection.
  async loadPersistentGrants() {
    this._persistent = new Set();
    if (!this._persistentPort) return [];
    let loaded = null;
    try {
      loaded = await this._persistentPort.load();
    } catch (error) {
      safeNotify('onEvent', () => this._onEvent('approval_persistent_load_failed', {
        error: (error && error.message) || String(error),
      }));
      return [];
    }
    for (const key of (Array.isArray(loaded) ? loaded : [])) {
      const k = normalizePolicyKey(key);
      if (k) this._persistent.add(k);
    }
    return this.listPersistentGrants();
  }

  // Sorted snapshot of the policyKeys currently held as durable grants.
  listPersistentGrants() {
    return Array.from(this._persistent).sort();
  }

  // Remove one durable grant from the memory set FIRST (it is the decision
  // authority — a failed storage remove must not keep auto-allowing), then
  // from the port. A storage failure is contained and surfaced as an event.
  async revokePersistentGrant(policyKey) {
    const k = normalizePolicyKey(policyKey);
    if (!k) {
      throw ApprovalError('revokePersistentGrant requires a non-empty policyKey', 'missing_policy_key');
    }
    this._persistent.delete(k);
    if (!this._persistentPort) return;
    try {
      await this._persistentPort.remove(k);
    } catch (error) {
      safeNotify('onEvent', () => this._onEvent('approval_persistent_remove_failed', {
        policyKey: k, error: (error && error.message) || String(error),
      }));
    }
  }

  // "Reset all data" seam: remove EVERY durable grant from the port (per
  // entry) and clear the memory set. Per-entry storage failures are
  // contained (one event each); the memory set clears regardless.
  // clearSessionGrants() deliberately does NOT touch these.
  async clearPersistentGrants() {
    const keys = this.listPersistentGrants();
    this._persistent = new Set();
    safeNotify('onEvent', () => this._onEvent('approval_grants_cleared', { scope: 'persistent' }));
    if (!this._persistentPort) return;
    for (const k of keys) {
      try {
        await this._persistentPort.remove(k);
      } catch (error) {
        safeNotify('onEvent', () => this._onEvent('approval_persistent_remove_failed', {
          policyKey: k, error: (error && error.message) || String(error),
        }));
      }
    }
  }

  // Ask for human approval. Resolves when the UI (or an abort, or a
  // session grant) decides. NEVER rejects: callers check decision.outcome,
  // so no unhandled rejections and no dangling promises.
  request(spec, options) {
    if (this._pending) {
      throw new ApprovalBusyError(
        'ApprovalController: another approval request is already pending (id ' + this._pending.id + ')');
    }
    const s = spec && typeof spec === 'object' ? spec : {};
    const kindSpec = APPROVAL_KINDS[s.kind];
    if (!kindSpec) {
      throw ApprovalError('unknown approval kind: ' + String(s.kind), 'unknown_kind');
    }
    const policyKey = normalizePolicyKey(s.policyKey);
    if (s.kind === 'permission' && !policyKey) {
      throw ApprovalError('permission requests require a Harness-constructed policyKey', 'missing_policy_key');
    }

    // C3 decision order: persistent grant → session grant → interactive
    // ask. A durable grant covers this exact policy key: resolve
    // immediately — no pending state, no UI, no busy interaction.
    if (policyKey && this._persistent.has(policyKey)) {
      safeNotify('onEvent', () => this._onEvent('approval_grant_hit', { policyKey: policyKey, scope: 'persistent' }));
      return Promise.resolve({ outcome: 'allow', scope: 'persistent', requestId: null, viaGrant: true });
    }

    // A session grant covers this exact policy key: resolve immediately —
    // no pending state, no UI, no busy interaction.
    if (policyKey && this._grants.has(policyKey)) {
      safeNotify('onEvent', () => this._onEvent('approval_grant_hit', { policyKey: policyKey }));
      return Promise.resolve({ outcome: 'allow', scope: 'session', requestId: null, viaGrant: true });
    }

    const id = 'apr-' + (++this._seq).toString(36) + '-' + approvalMakeId();
    const request = {
      id: id,
      kind: s.kind,
      action: normalizeAction(s.action),
      resource: normalizeResource(s.resource),
      policyKey: policyKey,
      conversationId: normalizeText(s.conversationId),
      // F-A34: INFORMATIONAL CONTEXT ONLY — debugging, UI diagnostics and
      // future audit events. Never a security enforcement token, never an
      // authorization identity and never a replacement for the AbortSignal:
      // runtime liveness enforcement relies on requestId + AbortSignal +
      // the caller's final liveness recheck (docs/APPROVALS.md).
      taskGeneration: Number.isFinite(s.taskGeneration) ? s.taskGeneration : null,
      createdAt: new Date().toISOString(),
    };
    if (!request.action.summary) {
      throw ApprovalError('approval request requires a non-empty action.summary', 'missing_summary');
    }

    const signal = options && options.signal ? options.signal : null;
    if (signal && signal.aborted) {
      // Task already cancelled before the ask: nothing to show, nothing pending.
      return Promise.resolve({ outcome: 'cancelled', scope: 'once', requestId: id, reason: 'aborted' });
    }

    return new Promise((resolve) => {
      this._pending = request;
      this._resolvePending = resolve;
      if (signal) {
        this._signal = signal;
        this._signalHandler = () => { this.cancel(id, 'aborted'); };
        signal.addEventListener('abort', this._signalHandler, { once: true });
      }
      // Canonical pending state is registered ABOVE, before the observers
      // run: even a throwing projection can never leave a half-created
      // request, and these contained throws can never reject this Promise
      // (request() never rejects).
      safeNotify('onEvent', () => this._onEvent('approval_requested', { id: id, kind: request.kind, policyKey: request.policyKey }));
      safeNotify('onChange', () => this._onChange(request));
    });
  }

  // Apply a UI decision to the CURRENT pending request. A stale id (old
  // card, old handler, late click) is a no-op — it can never resolve a
  // newer request. Invalid decision shapes fail loudly: that is a caller
  // bug, not a user choice.
  resolve(requestId, decision) {
    const pending = this._pending;
    if (!pending || pending.id !== requestId) return false;
    const kindSpec = APPROVAL_KINDS[pending.kind];
    const d = decision && typeof decision === 'object' ? decision : {};
    if (kindSpec.outcomes.indexOf(d.outcome) === -1) {
      throw ApprovalError(
        'invalid outcome "' + String(d.outcome) + '" for approval kind "' + pending.kind + '"',
        'invalid_decision');
    }
    const scope = d.scope || 'once';
    if (scope !== 'once' && scope !== 'session' && scope !== 'persistent') {
      throw ApprovalError('invalid decision scope: ' + String(scope), 'invalid_scope');
    }
    if (scope === 'session') {
      // Session scope exists to GRANT: only a positive outcome may carry it
      // (spec: deny is always scope 'once' — a deny never creates a rule).
      const grantOutcome = d.outcome === 'allow' || d.outcome === 'confirm';
      if (!grantOutcome || !kindSpec.sessionScope || !pending.policyKey) {
        throw ApprovalError('decision outcome "' + String(d.outcome) + '" cannot carry session scope', 'invalid_scope');
      }
    }
    if (scope === 'persistent') {
      // Same legality rules as session scope (only a positive outcome may
      // carry it, kind must support it, policyKey required) plus: a
      // persistentGrants port must exist. No port → 'persistent' is
      // unsupported, not silently downgraded to 'session'.
      const grantOutcome = d.outcome === 'allow' || d.outcome === 'confirm';
      if (!grantOutcome || !kindSpec.persistentScope || !pending.policyKey || !this._persistentPort) {
        throw ApprovalError('decision outcome "' + String(d.outcome) + '" cannot carry persistent scope', 'invalid_scope');
      }
    }
    this._finish(pending.id, { outcome: d.outcome, scope: scope, requestId: pending.id }, 'approval_resolved');
    if (scope === 'session' && pending.policyKey) {
      this._grants.set(pending.policyKey, { requestId: pending.id, createdAt: new Date().toISOString() });
      safeNotify('onEvent', () => this._onEvent('approval_grant_added', { policyKey: pending.policyKey }));
    }
    if (scope === 'persistent' && pending.policyKey) {
      // Memory FIRST — the grant is effective in this page session
      // immediately — then the port. A failed store retracts the memory
      // entry and falls back to a session grant: the user said allow, so
      // the request stays allowed; only the durability failed.
      const policyKey = pending.policyKey;
      this._persistent.add(policyKey);
      safeNotify('onEvent', () => this._onEvent('approval_grant_added', { policyKey: policyKey, scope: 'persistent' }));
      Promise.resolve(this._persistentPort.add(policyKey)).then(undefined, () => {
        if (!this._persistent.has(policyKey)) return; // revoked/cleared meanwhile — never resurrect
        this._persistent.delete(policyKey);
        this._grants.set(policyKey, { requestId: pending.id, createdAt: new Date().toISOString() });
        safeNotify('onEvent', () => this._onEvent('approval_persistent_store_failed', { policyKey: policyKey }));
      });
    }
    return true;
  }

  // Close one request without a user decision (task cancel, session
  // boundary, abort). Resolves 'cancelled' — distinct from 'deny'.
  cancel(requestId, reason) {
    const pending = this._pending;
    if (!pending || pending.id !== requestId) return false;
    this._finish(pending.id, {
      outcome: 'cancelled', scope: 'once', requestId: pending.id, reason: reason || 'cancelled',
    }, 'approval_cancelled');
    return true;
  }

  cancelAll(reason) {
    if (!this._pending) return false;
    return this.cancel(this._pending.id, reason);
  }

  _finish(requestId, decision, eventName) {
    const pending = this._pending;
    if (!pending || pending.id !== requestId) return;
    if (this._signal && this._signalHandler) {
      this._signal.removeEventListener('abort', this._signalHandler);
    }
    const resolve = this._resolvePending;
    // Canonical cleanup happens FIRST and exactly once (the id guard above
    // makes every later finish/resolve/cancel for this id a no-op).
    this._pending = null;
    this._resolvePending = null;
    this._signal = null;
    this._signalHandler = null;
    try {
      // Observers stay best-effort: each is individually contained, so the
      // UI projection still clears BEFORE the awaiting continuation resumes
      // and an observer throw can never prevent settlement.
      safeNotify('onEvent', () => this._onEvent(eventName, { id: pending.id, outcome: decision.outcome, scope: decision.scope }));
      safeNotify('onChange', () => this._onChange(null));
    } finally {
      // Unconditional exactly-once settlement — the invariant observers
      // must never be able to break.
      resolve(decision);
    }
  }
}
export { ApprovalController, APPROVAL_KINDS, ApprovalError, ApprovalBusyError };
