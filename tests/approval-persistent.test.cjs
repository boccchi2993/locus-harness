// Persistent approval grants unit tests (node, C3):
// scope 'persistent' on permission decisions (legality rules mirror session
// scope), the persistentGrants port { load, add, remove }, the decision
// order persistent → session → interactive ask, fail-closed loading,
// the store-failure retraction to a session grant, revoke/clear semantics
// and the sorted listing. The REAL src/approval.js runs unchanged.
// Run: node tests/approval-persistent.test.cjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 300) : '')); }
}

(async () => {
  const { ApprovalController } = await import('../src/approval.js');

  const permSpec = (policyKey, summary) => ({
    kind: 'permission',
    action: { type: 'tool', summary: summary || 'Run tool X' },
    policyKey: policyKey || 'perm:tool:x',
  });

  // A controller over an in-memory durable store with failure seams.
  //   opts.store        — the (shared) Map playing the durable store
  //   opts.noPort       — construct WITHOUT a persistentGrants port
  //   opts.failures     — { load | add | remove: true } → that method throws
  function newController(opts) {
    const o = opts || {};
    const store = o.store || new Map();
    const failures = o.failures || {};
    const calls = { add: [], remove: [], load: 0 };
    const events = [];
    const options = {
      onEvent: (name, data) => events.push({ name, data }),
      onChange: () => {},
    };
    if (!o.noPort) {
      options.persistentGrants = {
        load: async () => {
          calls.load++;
          if (failures.load) throw new Error('load failed');
          return Array.from(store.keys());
        },
        add: async (key) => {
          if (failures.add) throw new Error('add failed');
          calls.add.push(key);
          store.set(key, {});
        },
        remove: async (key) => {
          if (failures.remove) throw new Error('remove failed');
          calls.remove.push(key);
          store.delete(key);
        },
      };
    }
    const c = new ApprovalController(options);
    return { c, events, store, calls };
  }

  // Resolve the current pending request as allow + persistent.
  async function grantPersistent(c, policyKey) {
    const p = c.request(permSpec(policyKey));
    c.resolve(c.pending.id, { outcome: 'allow', scope: 'persistent' });
    await p;
  }

  const expectInvalidScope = async (name, fn) => {
    try {
      await fn();
      check(name, false, 'did not throw');
    } catch (e) {
      check(name, !!e && e.code === 'invalid_scope', e && (e.code + ': ' + e.message));
    }
  };

  // Let a settled store-call rejection run its retraction handler.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // ---------- AP1. allow + persistent, then no more prompts ----------
  {
    const { c, events } = newController();
    const p = c.request(permSpec('perm:github:call'));
    check('AP1 the request first goes pending', c.hasPending());
    c.resolve(c.pending.id, { outcome: 'allow', scope: 'persistent' });
    const d = await p;
    check('AP1 allow + persistent resolves allow/persistent',
      d.outcome === 'allow' && d.scope === 'persistent');
    const again = await c.request(permSpec('perm:github:call'));
    check('AP1 same policyKey auto-allows: scope persistent, viaGrant, no requestId, no UI',
      again.outcome === 'allow' && again.scope === 'persistent'
      && again.viaGrant === true && again.requestId === null && !c.hasPending());
    check('AP1 grant hit reported as a persistent grant hit',
      events.some((e) => e.name === 'approval_grant_hit' && e.data.scope === 'persistent'
        && e.data.policyKey === 'perm:github:call'));
  }

  // ---------- AP2. persistent scope legality (mirrors session scope) ----------
  {
    const { c } = newController();
    const p = c.request(permSpec('perm:deny'));
    await expectInvalidScope('AP2 deny cannot carry persistent scope',
      () => Promise.resolve(c.resolve(c.pending.id, { outcome: 'deny', scope: 'persistent' })));
    c.cancel(c.pending.id, 'cleanup');
    await p;
    const capP = c.request({ kind: 'capability', action: { type: 'input', summary: 'image ok?' }, policyKey: 'cap:k' });
    await expectInvalidScope('AP2 capability kind cannot carry persistent scope',
      () => Promise.resolve(c.resolve(c.pending.id, { outcome: 'confirm', scope: 'persistent' })));
    c.cancel(c.pending.id, 'cleanup');
    await capP;
    const confP = c.request({ kind: 'confirmation', action: { type: 'file', summary: 'overwrite?' } });
    await expectInvalidScope('AP2 confirmation kind cannot carry persistent scope',
      () => Promise.resolve(c.resolve(c.pending.id, { outcome: 'confirm', scope: 'persistent' })));
    c.cancel(c.pending.id, 'cleanup');
    await confP;
    const noKeyP = c.request({ kind: 'capability', action: { type: 'input', summary: 'no policy key' } });
    await expectInvalidScope('AP2 persistent scope without a policyKey is rejected',
      () => Promise.resolve(c.resolve(c.pending.id, { outcome: 'confirm', scope: 'persistent' })));
    c.cancel(c.pending.id, 'cleanup');
    await noKeyP;
  }

  // ---------- AP3. no port → persistent unsupported ----------
  {
    const { c } = newController({ noPort: true });
    const p = c.request(permSpec('perm:noport'));
    await expectInvalidScope('AP3 without the port, persistent scope is invalid_scope',
      () => Promise.resolve(c.resolve(c.pending.id, { outcome: 'allow', scope: 'persistent' })));
    c.cancel(c.pending.id, 'cleanup');
    await p;
  }

  // ---------- AP4. decision order: persistent → session → ask ----------
  {
    // The durable store ALREADY holds 'perm:both'; the controller has not
    // loaded it yet. The interactive path creates a session grant for the
    // same key; loading then makes BOTH grants exist at once.
    const store = new Map([['perm:both', {}]]);
    const { c } = newController({ store });
    const s = c.request(permSpec('perm:both'));
    c.resolve(c.pending.id, { outcome: 'allow', scope: 'session' });
    await s;
    check('AP4 with only a session grant, it resolves session',
      (await c.request(permSpec('perm:both'))).scope === 'session');
    await c.loadPersistentGrants();
    const both = await c.request(permSpec('perm:both'));
    check('AP4 with both grants, persistent wins',
      both.outcome === 'allow' && both.scope === 'persistent' && both.viaGrant === true
      && !c.hasPending());
  }

  // ---------- AP5. loadPersistentGrants: feed from the port; fail closed ----------
  {
    const { c, store } = newController();
    store.set('perm:b', {});
    store.set('perm:a', {});
    const listed = await c.loadPersistentGrants();
    check('AP5 load feeds the in-memory set (sorted)',
      JSON.stringify(listed) === JSON.stringify(['perm:a', 'perm:b'])
      && JSON.stringify(c.listPersistentGrants()) === JSON.stringify(['perm:a', 'perm:b']));
    const d = await c.request(permSpec('perm:a'));
    check('AP5 a loaded grant auto-allows',
      d.outcome === 'allow' && d.scope === 'persistent' && d.viaGrant === true && !c.hasPending());
    const { c: bad, events } = newController({ failures: { load: true } });
    let listed2 = null;
    try { listed2 = await bad.loadPersistentGrants(); } catch (e) { listed2 = 'threw'; }
    check('AP5 a failed load does not throw and fails CLOSED (empty set)',
      Array.isArray(listed2) && listed2.length === 0 && bad.listPersistentGrants().length === 0);
    check('AP5 a failed load emits approval_persistent_load_failed',
      events.some((e) => e.name === 'approval_persistent_load_failed'));
    const p = bad.request(permSpec('perm:x'));
    check('AP5 after a failed load the request still prompts (no silent auto-allow)', bad.hasPending());
    bad.resolve(bad.pending.id, { outcome: 'allow', scope: 'once' });
    await p;
  }

  // ---------- AP6. store failure: retract to session, still allow ----------
  {
    const store = new Map();
    const { c, events } = newController({ store, failures: { add: true } });
    const p = c.request(permSpec('perm:store:fail'));
    c.resolve(c.pending.id, { outcome: 'allow', scope: 'persistent' });
    const d = await p;
    check('AP6 the request stays allowed when the store fails',
      d.outcome === 'allow' && d.scope === 'persistent');
    await settle();
    check('AP6 the memory grant is retracted',
      !c.listPersistentGrants().includes('perm:store:fail'));
    check('AP6 a session grant is recorded as the fallback',
      c.hasSessionGrant('perm:store:fail'));
    check('AP6 approval_persistent_store_failed is emitted',
      events.some((e) => e.name === 'approval_persistent_store_failed'
        && e.data.policyKey === 'perm:store:fail'));
    const again = await c.request(permSpec('perm:store:fail'));
    check('AP6 the same key still auto-allows through the session fallback',
      again.viaGrant === true && again.scope === 'session');
    // "Refresh": a NEW controller over the SAME durable store + load.
    const fresh = newController({ store });
    await fresh.c.loadPersistentGrants();
    check('AP6 after refresh the failed grant is NOT in the persistent set',
      !fresh.c.listPersistentGrants().includes('perm:store:fail'));
    const freshAsk = fresh.c.request(permSpec('perm:store:fail'));
    check('AP6 after refresh the same key prompts again', fresh.c.hasPending());
    fresh.c.resolve(fresh.c.pending.id, { outcome: 'deny', scope: 'once' });
    await freshAsk;
  }

  // ---------- AP7. revokePersistentGrant ----------
  {
    const { c, store, events } = newController();
    await grantPersistent(c, 'perm:revoke');
    check('AP7 the grant is present before revoke',
      c.listPersistentGrants().includes('perm:revoke') && store.has('perm:revoke'));
    await c.revokePersistentGrant('perm:revoke');
    check('AP7 revoke removes from the memory set AND the store',
      !c.listPersistentGrants().includes('perm:revoke') && !store.has('perm:revoke'));
    const q = c.request(permSpec('perm:revoke'));
    check('AP7 the same key prompts again after revoke', c.hasPending());
    c.resolve(c.pending.id, { outcome: 'deny', scope: 'once' });
    await q;
    const { c: bad, events: badEvents } = newController({ failures: { remove: true } });
    await grantPersistent(bad, 'perm:revoke2');
    let threw = false;
    try { await bad.revokePersistentGrant('perm:revoke2'); } catch (e) { threw = true; }
    check('AP7 a storage failure does not throw', !threw);
    check('AP7 a storage-failed revoke still removes from the memory set',
      !bad.listPersistentGrants().includes('perm:revoke2'));
    check('AP7 a storage-failed revoke emits approval_persistent_remove_failed',
      badEvents.some((e) => e.name === 'approval_persistent_remove_failed'
        && e.data.policyKey === 'perm:revoke2'));
    check('AP7 (sanity) events from the first controller stay clean',
      !events.some((e) => e.name === 'approval_persistent_remove_failed'));
  }

  // ---------- AP8. clearPersistentGrants; clearSessionGrants untouched ----------
  {
    const { c, store, calls, events } = newController();
    await grantPersistent(c, 'perm:c1');
    await grantPersistent(c, 'perm:c2');
    await c.clearPersistentGrants();
    check('AP8 the memory set is cleared', c.listPersistentGrants().length === 0);
    check('AP8 remove was called once per entry',
      JSON.stringify(calls.remove.slice().sort()) === JSON.stringify(['perm:c1', 'perm:c2'])
      && store.size === 0);
    check('AP8 the persistent clear emits approval_grants_cleared with scope persistent',
      events.some((e) => e.name === 'approval_grants_cleared' && e.data.scope === 'persistent'));
    const { c: bad } = newController({ failures: { remove: true } });
    await grantPersistent(bad, 'perm:c3');
    await bad.clearPersistentGrants();
    check('AP8 clear clears the set even when every remove fails (reset-all semantics)',
      bad.listPersistentGrants().length === 0);
    // clearSessionGrants does NOT touch persistent grants.
    const { c: mix } = newController();
    await grantPersistent(mix, 'perm:keep');
    const s = mix.request(permSpec('perm:sess'));
    mix.resolve(mix.pending.id, { outcome: 'allow', scope: 'session' });
    await s;
    mix.clearSessionGrants();
    check('AP8 clearSessionGrants leaves persistent grants intact',
      !mix.hasSessionGrant('perm:sess')
      && JSON.stringify(mix.listPersistentGrants()) === JSON.stringify(['perm:keep']));
    const d = await mix.request(permSpec('perm:keep'));
    check('AP8 the persistent grant still hits after clearSessionGrants',
      d.scope === 'persistent' && d.viaGrant === true);
  }

  // ---------- AP9. listPersistentGrants returns a sorted array ----------
  {
    const { c } = newController();
    await grantPersistent(c, 'perm:z');
    await grantPersistent(c, 'perm:a');
    await grantPersistent(c, 'perm:m');
    const listed = c.listPersistentGrants();
    check('AP9 sorted policyKeys',
      JSON.stringify(listed) === JSON.stringify(['perm:a', 'perm:m', 'perm:z']));
    listed.push('perm:sneaky');
    check('AP9 the listing is a copy (no aliasing into the set)',
      c.listPersistentGrants().length === 3);
  }

  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' approval-persistent checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
