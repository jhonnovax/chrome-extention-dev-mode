// Config store shared by background.js (importScripts) and options.js (<script>).
//
// Rules and globals live in chrome.storage.sync so they follow the Google account signed into
// Chrome to every machine where this extension (same ID, fixed by manifest.json "key") is loaded.
// One key per rule / per domain keeps every item far below the 8 KB per-key quota and lets edits
// made on two machines merge key by key. Modes (domainStates) stay in chrome.storage.local.
//
//   meta                 { schema: 1, updatedAt }
//   rule:<id>            { kind: 'mapLocal', order, enabled, modes, pattern, localPath }
//                        { kind: 'rewrite',  order, enabled, modes, regex, replacement }
//   globals:<domain>     [{ name, value }]            // domain like '.on24.com'
//
// Without a `meta` key the store is untouched: readConfig() then returns DEFAULT_SETTINGS without
// writing, so a freshly loaded machine never overwrites cloud data with the defaults.

const DevModeConfig = (() => {
  const META_KEY = 'meta';
  const RULE_PREFIX = 'rule:';
  const GLOBALS_PREFIX = 'globals:';
  const SCHEMA = 1;

  // Seeded on first run (editable in options.html)
  const DEFAULT_SETTINGS = {
    mapLocal: [{
      id: 'ml-orion',
      enabled: true,
      pattern: 'https://*/view/orion/*',
      localPath: '/Users/jnova/Projects/orion/static',
      modes: ['dev', 'preview']
    }],
    rewrites: [{
      id: 'rw-production-hash',
      enabled: true,
      regex: '/(.*)/dist/production-(css|js)-(.*).(css|js)(.*)',
      replacement: '/$1/dist/production-$2.$4',
      modes: ['preview']
    }]
  };

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const ruleKey = (id) => RULE_PREFIX + id;
  const globalsKey = (domain) => GLOBALS_PREFIX + domain;
  const isRuleKey = (k) => k.startsWith(RULE_PREFIX);
  const isGlobalsKey = (k) => k.startsWith(GLOBALS_PREFIX);

  function ruleToEntry(id, stored) {
    const base = { id, enabled: stored.enabled !== false, modes: Array.isArray(stored.modes) ? stored.modes : [] };
    if (stored.kind === 'rewrite') return { ...base, regex: stored.regex || '', replacement: stored.replacement || '' };
    return { ...base, pattern: stored.pattern || '', localPath: stored.localPath || '' };
  }

  function entryToRule(kind, entry, order) {
    const base = { kind, order, enabled: entry.enabled !== false, modes: entry.modes || [] };
    if (kind === 'rewrite') return { ...base, regex: entry.regex || '', replacement: entry.replacement || '' };
    return { ...base, pattern: entry.pattern || '', localPath: entry.localPath || '' };
  }

  // Parse a raw chrome.storage.sync dump into { mapLocal, rewrites, globals, seeded }
  function parse(all) {
    if (!all || !all[META_KEY]) {
      return { ...clone(DEFAULT_SETTINGS), globals: {}, seeded: true };
    }
    const mapLocal = [];
    const rewrites = [];
    const globals = {};
    for (const [key, value] of Object.entries(all)) {
      if (isRuleKey(key) && value && typeof value === 'object') {
        const entry = ruleToEntry(key.slice(RULE_PREFIX.length), value);
        (value.kind === 'rewrite' ? rewrites : mapLocal).push({ ...entry, order: value.order ?? 0 });
      } else if (isGlobalsKey(key) && Array.isArray(value)) {
        const domain = key.slice(GLOBALS_PREFIX.length);
        if (domain && value.length) globals[domain] = value;
      }
    }
    const byOrder = (a, b) => a.order - b.order;
    const strip = ({ order, ...rest }) => rest;
    return {
      mapLocal: mapLocal.sort(byOrder).map(strip),
      rewrites: rewrites.sort(byOrder).map(strip),
      globals,
      seeded: false
    };
  }

  async function readConfig() {
    return parse(await chrome.storage.sync.get(null));
  }

  // Replace every rule: one set() for the new/updated keys, one remove() for the dropped ones.
  // Rejects with Chrome's quota error message when the store is full.
  async function writeSettings({ mapLocal = [], rewrites = [] }) {
    const items = { [META_KEY]: { schema: SCHEMA, updatedAt: Date.now() } };
    let order = 0;
    for (const e of mapLocal) items[ruleKey(e.id)] = entryToRule('mapLocal', e, order++);
    for (const e of rewrites) items[ruleKey(e.id)] = entryToRule('rewrite', e, order++);

    const existing = await chrome.storage.sync.get(null);
    const stale = Object.keys(existing).filter(k => isRuleKey(k) && !(k in items));
    await chrome.storage.sync.set(items);
    if (stale.length) await chrome.storage.sync.remove(stale);
  }

  async function writeGlobals(domain, list) {
    const meta = { schema: SCHEMA, updatedAt: Date.now() };
    if (Array.isArray(list) && list.length) {
      await chrome.storage.sync.set({ [META_KEY]: meta, [globalsKey(domain)]: list });
    } else {
      await chrome.storage.sync.remove(globalsKey(domain));
      await chrome.storage.sync.set({ [META_KEY]: meta });
    }
  }

  return {
    DEFAULT_SETTINGS,
    META_KEY,
    isRuleKey,
    isGlobalsKey,
    parse,
    readConfig,
    writeSettings,
    writeGlobals,
    defaults: () => clone(DEFAULT_SETTINGS)
  };
})();
