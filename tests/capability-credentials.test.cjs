// Capability credentials unit tests (node, C3):
// credential BINDINGS in capability descriptors (validation + normalization),
// credential-name uniqueness across capabilities (catalog load AND
// registerPackage), the registration-scoped credential connection state
// (setCredentialState + notifications, enable/disable independence,
// unregisterPackage release), the TaskEnvironment credentials entries,
// and the pure credentialBindingChanged comparison the Product uses on
// version replacement. The REAL src/extension-composition.js runs unchanged.
// Run: node tests/capability-credentials.test.cjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 300) : '')); }
}

async function throwsWith(name, fn, needle) {
  try {
    await fn();
    check(name, false, 'did not throw');
  } catch (e) {
    const msg = (e && e.message) || String(e);
    check(name, !needle || msg.indexOf(needle) !== -1,
      needle ? ('threw without ' + JSON.stringify(needle) + ': ' + msg) : msg);
  }
}

(async () => {
  const {
    CapabilityManager, validateCapabilityDescriptor, validateCatalogSet,
    credentialBindingChanged, CREDENTIAL_STATES,
  } = await import('../src/extension-composition.js');

  // A minimal valid capability descriptor. Credentials only — no plugins /
  // skills / mcps, so no artifacts or instance storage are needed.
  const cap = (id, credentials) => ({
    id: id, version: '1', displayName: 'Cap ' + id, description: 'd',
    plugins: [], skills: [], mcps: [],
    ...(credentials !== undefined ? { credentials } : {}),
  });
  const credential = (over) => Object.assign({
    name: 'GITHUB_TOKEN', label: 'GitHub token', origin: 'https://api.github.com',
    pathPrefix: '/repos/', header: 'Authorization',
  }, over || {});

  // Build + enable a manager over the given capabilities; returns the
  // manager and its TaskEnvironment.
  const buildEnv = async (capabilities) => {
    const mgr = new CapabilityManager({ catalogs: { capabilities } });
    for (const c of capabilities) await mgr.enable(c.id);
    return { mgr, env: mgr.buildTaskEnvironment() };
  };

  // ---------- CC1. a legal declaration is accepted and normalized ----------
  {
    const d = validateCapabilityDescriptor(cap('cap-a', [credential({
      name: 'GITHUB_TOKEN', header: 'Authorization', label: 'GitHub token',
    })]));
    check('CC1 legal credential accepted and normalized', d.credentials.length === 1);
    const c = d.credentials[0];
    check('CC1 header normalized to lowercase', c.header === 'authorization');
    check('CC1 missing scheme normalized to null', c.scheme === null);
    check('CC1 identity fields carried through',
      c.name === 'GITHUB_TOKEN' && c.label === 'GitHub token'
      && c.origin === 'https://api.github.com' && c.pathPrefix === '/repos/');
    check('CC1 credentials array is frozen',
      Object.isFrozen(d.credentials) && Object.isFrozen(d.credentials[0]));
    check('CC1 every normalized field is present',
      JSON.stringify(Object.keys(c)) === JSON.stringify(
        ['name', 'label', 'description', 'origin', 'pathPrefix', 'header', 'scheme']));
    const noCreds = validateCapabilityDescriptor(cap('cap-b'));
    check('CC1 missing credentials defaults to an empty frozen array',
      Array.isArray(noCreds.credentials) && noCreds.credentials.length === 0
      && Object.isFrozen(noCreds.credentials));
    check('CC1 credentials state vocabulary is the C3 triple',
      JSON.stringify(CREDENTIAL_STATES) === JSON.stringify(['connected', 'needs-connection', 'needs-reconfirm']));
  }

  // ---------- CC2. illegal credential names ----------
  {
    for (const bad of ['github_token', '1TOKEN', 'T'.repeat(65), 'A']) {
      await throwsWith('CC2 illegal name ' + JSON.stringify(bad.length > 20 ? bad[0] + '…(' + bad.length + ' chars)' : bad) + ' rejected with the field named',
        () => validateCapabilityDescriptor(cap('cap-a', [credential({ name: bad })])),
        '"name"');
    }
  }

  // ---------- CC3. illegal origins ----------
  {
    const badOrigins = [
      'http://api.github.com',             // not https
      'https://api.github.com/repos',      // path
      'https://api.github.com?x=1',        // query
      'https://api.github.com#frag',       // fragment
      'https://user:pass@api.github.com',  // userinfo
      'https://192.168.1.1',               // IPv4 literal
      'https://[::1]',                     // IPv6 literal
      'https://localhost',
      'https://a.localhost',
      'https://x.local',
      'https://y.internal',
      'https://z.lan',
      'https://h.home.arpa',
      'https://nodot',                     // no dot in the host
    ];
    for (const origin of badOrigins) {
      await throwsWith('CC3 illegal origin ' + origin + ' rejected with the field named',
        () => validateCapabilityDescriptor(cap('cap-a', [credential({ origin })])),
        'origin');
    }
  }

  // ---------- CC3b. trailing-dot host names are rejected ----------
  // WHATWG URLs keep a trailing DNS root hint verbatim (url.origin
  // round-trips), so these slipped past every earlier rule: not
  // "localhost", dot-less check defeated by the extra dot. Bindings
  // compare origins EXACTLY, so a trailing-dot twin would fork a second
  // binding — rejected even for otherwise-public names.
  {
    for (const origin of ['https://localhost.', 'https://foo.local.', 'https://a.localhost.', 'https://api.deepseek.com.']) {
      await throwsWith('CC3b trailing-dot origin ' + origin + ' rejected with the field named',
        () => validateCapabilityDescriptor(cap('cap-a', [credential({ origin })])),
        'origin');
    }
  }

  // ---------- CC4. illegal pathPrefix values ----------
  {
    for (const pathPrefix of ['repos', '/repos', '/a/../b', '//', '/a//b', '/a%2Fb', '/a?b', '/a#b']) {
      await throwsWith('CC4 illegal pathPrefix ' + JSON.stringify(pathPrefix) + ' rejected with the field named',
        () => validateCapabilityDescriptor(cap('cap-a', [credential({ pathPrefix })])),
        'pathPrefix');
    }
  }

  // ---------- CC5. illegal and legal headers ----------
  {
    for (const header of ['cookie', 'proxy-authorization', 'sec-foo', 'x-forwarded-for', 'x-real-ip', 'x custom']) {
      await throwsWith('CC5 illegal header ' + JSON.stringify(header) + ' rejected with the field named',
        () => validateCapabilityDescriptor(cap('cap-a', [credential({ header })])),
        'header');
    }
    const d = validateCapabilityDescriptor(cap('cap-a', [
      credential({ name: 'TOKEN_A', header: 'Authorization' }),
      credential({ name: 'TOKEN_B', header: 'X-API-KEY' }),
      credential({ name: 'TOKEN_C', header: 'x-custom-token' }),
    ]));
    check('CC5 legal headers accepted and normalized to lowercase',
      d.credentials[0].header === 'authorization'
      && d.credentials[1].header === 'x-api-key'
      && d.credentials[2].header === 'x-custom-token');
  }

  // ---------- CC6. scheme accepts exactly "Bearer" ----------
  {
    for (const scheme of ['bearer', 'Basic']) {
      await throwsWith('CC6 illegal scheme ' + JSON.stringify(scheme) + ' rejected with the field named',
        () => validateCapabilityDescriptor(cap('cap-a', [credential({ scheme })])),
        'scheme');
    }
    const d = validateCapabilityDescriptor(cap('cap-a', [credential({ scheme: 'Bearer' })]));
    check('CC6 scheme "Bearer" accepted verbatim', d.credentials[0].scheme === 'Bearer');
  }

  // ---------- CC7. unknown fields and same-capability duplicate names ----------
  {
    await throwsWith('CC7 unknown credential field rejected',
      () => validateCapabilityDescriptor(cap('cap-a', [credential({ scopes: ['repo'] })])),
      'scopes');
    await throwsWith('CC7 duplicate credential name within one capability rejected',
      () => validateCapabilityDescriptor(cap('cap-a', [credential(), credential()])),
      'duplicate credential name');
    await throwsWith('CC7 credentials must be an array',
      () => validateCapabilityDescriptor(cap('cap-a', { name: 'X' })),
      '"credentials" must be an array');
  }

  // ---------- CC8. credential names are unique ACROSS capabilities ----------
  {
    await throwsWith('CC8 duplicate credential names fail catalog load naming BOTH capability ids',
      () => new CapabilityManager({
        catalogs: { capabilities: [cap('cap-a', [credential()]), cap('cap-b', [credential()])] },
      }),
      'cap-a');
    await throwsWith('CC8 catalog-load conflict message carries the second id too',
      () => validateCatalogSet({ capabilities: [cap('cap-a', [credential()]), cap('cap-b', [credential()])] }),
      'cap-b');
    const mgr = new CapabilityManager({ catalogs: { capabilities: [cap('cap-a', [credential({ name: 'KEY_A' })])] } });
    await throwsWith('CC8 registerPackage refuses a name another capability owns, naming BOTH ids',
      () => mgr.registerPackage({ capability: cap('cap-b', [credential({ name: 'KEY_A' })]), plugins: [], skills: [], mcps: [] }),
      'cap-a');
    check('CC8 refused registration left no trace', !mgr.isPackage('cap-b'));
    await mgr.registerPackage({ capability: cap('cap-b', [credential({ name: 'KEY_B' })]), plugins: [], skills: [], mcps: [] });
    await throwsWith('CC8 a second package cannot take the same name',
      () => mgr.registerPackage({ capability: cap('cap-c', [credential({ name: 'KEY_B' })]), plugins: [], skills: [], mcps: [] }),
      'cap-b');
    await mgr.unregisterPackage('cap-b');
    await mgr.registerPackage({ capability: cap('cap-c', [credential({ name: 'KEY_B' })]), plugins: [], skills: [], mcps: [] });
    check('CC8 after unregisterPackage the name is free again',
      mgr.isPackage('cap-c'));
  }

  // ---------- CC9. default state, setCredentialState, notifications ----------
  {
    const changes = [];
    const mgr = new CapabilityManager({
      catalogs: { capabilities: [cap('cap-a', [credential()])] },
      onChange: (n) => changes.push(n),
    });
    await mgr.enable('cap-a');
    check('CC9 default state is needs-connection',
      mgr.buildTaskEnvironment().capabilities[0].credentials[0].state === 'needs-connection');
    mgr.setCredentialState('GITHUB_TOKEN', 'connected');
    check('CC9 state change notifies once with the full transition',
      changes.length === 1 && changes[0].capabilityId === 'cap-a'
      && changes[0].name === 'GITHUB_TOKEN' && changes[0].state === 'connected'
      && changes[0].previousState === 'needs-connection');
    check('CC9 snapshot reflects the new state',
      mgr.buildTaskEnvironment().capabilities[0].credentials[0].state === 'connected');
    mgr.setCredentialState('GITHUB_TOKEN', 'connected');
    check('CC9 unchanged state sends NO notification', changes.length === 1);
    await throwsWith('CC9 unknown credential name throws',
      () => Promise.resolve(mgr.setCredentialState('NOPE_TOKEN', 'connected')),
      'unknown credential');
    await throwsWith('CC9 illegal state throws',
      () => Promise.resolve(mgr.setCredentialState('GITHUB_TOKEN', 'maybe')),
      'invalid credential state');
    // needs-reconfirm is a legal state (product sets it on binding change).
    mgr.setCredentialState('GITHUB_TOKEN', 'needs-reconfirm');
    check('CC9 needs-reconfirm is accepted and notified',
      changes.length === 2 && changes[1].state === 'needs-reconfirm'
      && changes[1].previousState === 'connected');
    // A manager without the observer option still mutates safely.
    const bare = new CapabilityManager({ catalogs: { capabilities: [cap('cap-a', [credential()])] } });
    check('CC9 setCredentialState works without an observer',
      bare.setCredentialState('GITHUB_TOKEN', 'connected') === 'connected');
    check('CC9 credentialState accessor reads the registration-scoped state',
      bare.credentialState('GITHUB_TOKEN') === 'connected');
  }

  // ---------- CC10. enable / disable never touch credential state ----------
  {
    const mgr = new CapabilityManager({ catalogs: { capabilities: [cap('cap-a', [credential()])] } });
    mgr.setCredentialState('GITHUB_TOKEN', 'connected');
    await mgr.enable('cap-a');
    check('CC10 enable keeps the set state',
      mgr.buildTaskEnvironment().capabilities[0].credentials[0].state === 'connected');
    await mgr.disable('cap-a');
    await mgr.enable('cap-a');
    check('CC10 disable + re-enable keeps the set state',
      mgr.buildTaskEnvironment().capabilities[0].credentials[0].state === 'connected');
  }

  // ---------- CC11. snapshot carries credentials, existing fields unchanged ----------
  {
    const { mgr, env } = await buildEnv([
      cap('cap-a', [credential({ name: 'TOKEN_A', description: 'repo scope', scheme: 'Bearer', header: 'X-API-KEY' })]),
      cap('cap-b'),
    ]);
    mgr.setCredentialState('TOKEN_A', 'connected');
    const env2 = mgr.buildTaskEnvironment();
    const a = env2.capabilities.find((c) => c.id === 'cap-a');
    const b = env2.capabilities.find((c) => c.id === 'cap-b');
    // The pre-C3 capability entry fields, verbatim and in order, followed
    // by exactly ONE new field: credentials.
    check('CC11 existing snapshot fields unchanged (pinned key order + credentials)',
      JSON.stringify(Object.keys(a)) === JSON.stringify([
        'id', 'version', 'displayName', 'description', 'state', 'error',
        'pluginIds', 'skillIds', 'mcpIds', 'skillPaths', 'includes', 'credentials',
      ]), JSON.stringify(Object.keys(a)));
    check('CC11 credentials entry carries the full shape + state',
      JSON.stringify(Object.keys(a.credentials[0])) === JSON.stringify(
        ['name', 'label', 'description', 'origin', 'pathPrefix', 'header', 'scheme', 'state'])
      && a.credentials[0].name === 'TOKEN_A'
      && a.credentials[0].description === 'repo scope'
      && a.credentials[0].header === 'x-api-key'
      && a.credentials[0].scheme === 'Bearer'
      && a.credentials[0].state === 'connected');
    check('CC11 no-credential capability carries an empty array', Array.isArray(b.credentials) && b.credentials.length === 0);
    check('CC11 snapshot credentials are frozen (deep-frozen snapshot)',
      Object.isFrozen(a.credentials) && Object.isFrozen(a.credentials[0]));
    const errorCapMgr = new CapabilityManager({ catalogs: { capabilities: [cap('cap-e', [credential()])] } });
    // An error-state capability still carries its (honest) credential facts.
    await errorCapMgr.enable('cap-e');
    const errEnv = errorCapMgr.buildTaskEnvironment();
    check('CC11 credentials present on every snapshot capability entry',
      errEnv.capabilities.every((c) => Array.isArray(c.credentials)));
  }

  // ---------- CC12. credentialBindingChanged ----------
  {
    const oldC = validateCapabilityDescriptor(cap('cap-a', [credential()])).credentials[0];
    check('CC12 identical bindings are unchanged', credentialBindingChanged(oldC, oldC) === false);
    check('CC12 header case-only difference is NOT a binding change',
      credentialBindingChanged(oldC, Object.assign({}, oldC, { header: 'Authorization' })) === false);
    check('CC12 origin change is a binding change',
      credentialBindingChanged(oldC, Object.assign({}, oldC, { origin: 'https://api.example.com' })) === true);
    check('CC12 pathPrefix change is a binding change',
      credentialBindingChanged(oldC, Object.assign({}, oldC, { pathPrefix: '/orgs/' })) === true);
    check('CC12 header change is a binding change',
      credentialBindingChanged(oldC, Object.assign({}, oldC, { header: 'x-api-key' })) === true);
    check('CC12 scheme change is a binding change',
      credentialBindingChanged(oldC, Object.assign({}, oldC, { scheme: 'Bearer' })) === true);
    check('CC12 label/description edits alone are NOT a binding change',
      credentialBindingChanged(oldC, Object.assign({}, oldC, { label: 'Renamed', description: 'new words' })) === false);
  }

  // ---------- CC13. listCapabilities carries credentials in every state ----------
  {
    const mgr = new CapabilityManager({
      catalogs: { capabilities: [cap('cap-a', [credential({ name: 'TOKEN_A', description: 'repo scope', scheme: 'Bearer', header: 'X-API-KEY' })]), cap('cap-b')] },
    });
    // Disabled (never enabled): the binding is visible with the default
    // connection state — the settings UI renders Connect on the card.
    const a0 = mgr.listCapabilities().find((c) => c.id === 'cap-a');
    const b0 = mgr.listCapabilities().find((c) => c.id === 'cap-b');
    check('CC13 disabled capability lists credentials with state needs-connection',
      Array.isArray(a0.credentials) && a0.credentials.length === 1
      && JSON.stringify(Object.keys(a0.credentials[0])) === JSON.stringify(
        ['name', 'label', 'description', 'origin', 'pathPrefix', 'header', 'scheme', 'state'])
      && a0.credentials[0].name === 'TOKEN_A'
      && a0.credentials[0].description === 'repo scope'
      && a0.credentials[0].origin === 'https://api.github.com'
      && a0.credentials[0].header === 'x-api-key'
      && a0.credentials[0].scheme === 'Bearer'
      && a0.credentials[0].state === 'needs-connection');
    check('CC13 no-credential capability lists an empty credentials array',
      Array.isArray(b0.credentials) && b0.credentials.length === 0);
    // The pre-C3 listCapabilities fields, verbatim and in order, followed
    // by exactly ONE new field: credentials.
    check('CC13 existing listCapabilities fields unchanged (pinned key order + credentials)',
      JSON.stringify(Object.keys(a0)) === JSON.stringify([
        'id', 'version', 'displayName', 'description', 'state', 'error',
        'enabled', 'includes', 'plugins', 'skills', 'mcps', 'credentials',
      ]), JSON.stringify(Object.keys(a0)));
    // Credential state is registration-scoped: a state change is visible
    // in listCapabilities with the capability still disabled.
    mgr.setCredentialState('TOKEN_A', 'connected');
    check('CC13 listCapabilities reflects a state change while disabled',
      mgr.listCapabilities().find((c) => c.id === 'cap-a').credentials[0].state === 'connected');
    // After enable, the list view and the frozen snapshot agree byte for byte.
    await mgr.enable('cap-a');
    const listed = mgr.listCapabilities().find((c) => c.id === 'cap-a');
    const snapshot = mgr.buildTaskEnvironment().capabilities.find((c) => c.id === 'cap-a');
    check('CC13 after enable listCapabilities credentials match the snapshot',
      JSON.stringify(listed.credentials) === JSON.stringify(snapshot.credentials));
  }

  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' capability-credential checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
