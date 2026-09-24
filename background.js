// Constants
const COOKIE_NAME = 'htm-dev-mode';
const COOKIE_VALUE = '4815162342';
const STORAGE_KEY = 'domainStates';
const SETTINGS_KEY = 'settings';
const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = 4815;
const LOCAL_ORIGIN = `http://${LOCAL_HOST}:${LOCAL_PORT}`;

const STATES = { OFF: 'off', DEV: 'dev', PREVIEW: 'preview' };

// badge*: exact popup badge CSS colors (light / dark variants)
const STATE_CONFIG = {
  [STATES.OFF]:     { color: '#94A3B8', label: 'OFF', badgeBgLight: 'rgba(158,158,158,0.15)', badgeTextLight: '#5f6368', badgeBgDark: 'rgba(158,158,158,0.20)', badgeTextDark: '#bdbdbd', title: 'Off',              cookie: false, cache: true },
  [STATES.DEV]:     { color: '#22C55E', label: 'DEV', badgeBgLight: 'rgba(0,200,83,0.15)',    badgeTextLight: '#00a344', badgeBgDark: 'rgba(0,200,83,0.20)',    badgeTextDark: '#69f0ae', title: 'Development Mode', cookie: true,  cache: false },
  [STATES.PREVIEW]: { color: '#EAB308', label: 'PRE', badgeBgLight: 'rgba(234,179,8,0.18)',   badgeTextLight: '#a16207', badgeBgDark: 'rgba(234,179,8,0.24)',   badgeTextDark: '#facc15', title: 'Preview Mode',     cookie: false, cache: false }
};

// Default map-local / rewrite rules seeded on first run (editable in options.html)
const DEFAULT_SETTINGS = {
  mapLocal: [{
    id: 'ml-orion',
    enabled: true,
    pattern: 'https://*/view/orion/*',
    localPath: '/Users/jnova/Projects/orion/static',
    modes: [STATES.DEV, STATES.PREVIEW]
  }],
  rewrites: [{
    id: 'rw-production-hash',
    enabled: true,
    regex: '/(.*)/dist/production-(css|js)-(.*).(css|js)(.*)',
    replacement: '/$1/dist/production-$2.$4',
    modes: [STATES.PREVIEW]
  }]
};

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other'
];

function normalizeState(state) {
  return STATE_CONFIG[state] ? state : STATES.OFF;
}

let prefersDark = self.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

// Generate a single icon ImageData at the given pixel size
function generateIconSize(state, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cfg = STATE_CONFIG[state];
  const badgeBg   = prefersDark ? cfg.badgeBgDark   : cfg.badgeBgLight;
  const badgeText = prefersDark ? cfg.badgeTextDark  : cfg.badgeTextLight;
  const { label } = cfg;

  // Badge chip — solid base first so semi-transparent color is toolbar-independent
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.28);
  ctx.fillStyle = prefersDark ? '#1e1f21' : '#ffffff';
  ctx.fill();
  ctx.fillStyle = badgeBg;
  ctx.fill();

  // Border to lift the chip off the toolbar
  ctx.strokeStyle = prefersDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.15)';
  ctx.lineWidth = Math.max(1, size * 0.04);
  ctx.stroke();

  const fontSize = Math.round(size * 0.44);
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillStyle = badgeText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size / 2 + size * 0.02);

  return ctx.getImageData(0, 0, size, size);
}

// Generate icons at all required sizes
function generateIcons(state) {
  return {
    16:  generateIconSize(state, 16),
    32:  generateIconSize(state, 32),
    48:  generateIconSize(state, 48),
    64:  generateIconSize(state, 64),
    128: generateIconSize(state, 128)
  };
}

// Returns true only for URLs the extension can operate on
function isActionableUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

// Extract root domain from URL
function extractDomain(url) {
  try {
    const parts = new URL(url).hostname.split('.');
    return '.' + parts.slice(-2).join('.');
  } catch {
    return null;
  }
}

// Get state for a domain
async function getState(domain) {
  const { [STORAGE_KEY]: states = {} } = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(states[domain]);
}

// Save state for a domain
async function saveState(domain, state) {
  const { [STORAGE_KEY]: states = {} } = await chrome.storage.local.get(STORAGE_KEY);
  states[domain] = normalizeState(state);
  await chrome.storage.local.set({ [STORAGE_KEY]: states });
}

// Get settings, seeding defaults when missing (first install or upgrade)
async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  if (settings && Array.isArray(settings.mapLocal) && Array.isArray(settings.rewrites)) return settings;
  const seeded = structuredClone(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ [SETTINGS_KEY]: seeded });
  return seeded;
}

// Update extension icon
function updateIcon(state) {
  const { title } = STATE_CONFIG[state];
  chrome.action.setIcon({ imageData: generateIcons(state) });
  chrome.action.setTitle({ title });
}

// Apply state configuration (cookie). Network rules are handled by syncRules().
async function applyConfig(state, url) {
  const config = STATE_CONFIG[normalizeState(state)];
  const domain = url ? extractDomain(url) : null;
  if (!domain) return;

  if (config.cookie) {
    await chrome.cookies.set({
      url, domain,
      name: COOKIE_NAME,
      value: COOKIE_VALUE,
      path: '/',
      secure: true,
      sameSite: 'no_restriction',
      expirationDate: Math.floor(Date.now() / 1000) + 31536000
    });
  } else {
    await chrome.cookies.remove({ url, name: COOKIE_NAME }).catch(() => {});
  }
}

// ---- declarativeNetRequest rule building ----

function escapeRegex(str) {
  return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// Glob pattern ("https://*/view/orion/*") -> anchored RE2 regex, each * is a capture group
function globToRegex(pattern) {
  const regex = pattern.split('*').map(escapeRegex).join('(.*)');
  return { regex: `^${regex}$`, groups: pattern.split('*').length - 1 };
}

// "$1" style replacement -> DNR regexSubstitution ("\1")
function toSubstitution(replacement) {
  return replacement.replace(/\$(\d+)/g, '\\$1');
}

// Each rule is a "mount" on the local server: /m/<ruleId>/<last wildcard>
function mapLocalTarget(entry) {
  const { groups } = globToRegex(entry.pattern);
  return `${LOCAL_ORIGIN}/m/${entry.id}/` + (groups ? `\\${groups}` : '');
}

// Tell the local server which folders to serve (all enabled map-local rules, any mode)
async function pushServerConfig() {
  const settings = await getSettings();
  const mounts = {};
  for (const e of settings.mapLocal) {
    if (e.enabled !== false && e.id && e.localPath) mounts[e.id] = e.localPath;
  }
  try {
    await fetch(`${LOCAL_ORIGIN}/__config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mounts })
    });
  } catch {
    // server not running; it will get the config on the next save / startup
  }
}

// Same rule body twice: once scoped to requests made by the page (sub-resources),
// once scoped to requests going to the domain itself (direct navigations)
function scopedRules(domain, base) {
  return [
    { ...base, condition: { ...base.condition, initiatorDomains: [domain] } },
    { ...base, condition: { ...base.condition, requestDomains: [domain] } }
  ];
}

async function regexOk(regex) {
  try {
    const result = await chrome.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: false });
    return result.isSupported;
  } catch {
    return false;
  }
}

// Rebuild the complete dynamic rule set from stored domain states + settings
async function syncRules() {
  const [{ [STORAGE_KEY]: states = {} }, settings] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEY),
    getSettings()
  ]);

  const rules = [];
  let usesLocalServer = false;
  const enabled = (list) => list.filter(e => e.enabled !== false);

  for (const [rawDomain, rawState] of Object.entries(states)) {
    const state = normalizeState(rawState);
    const config = STATE_CONFIG[state];
    const domain = rawDomain.replace(/^\./, '');
    if (state === STATES.OFF || !domain) continue;

    if (!config.cache) {
      rules.push({
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Cache-Control', operation: 'set', value: 'no-cache, no-store, must-revalidate' },
            { header: 'Pragma', operation: 'set', value: 'no-cache' }
          ]
        },
        condition: { requestDomains: [domain], resourceTypes: ALL_RESOURCE_TYPES }
      });
    }

    for (const entry of enabled(settings.rewrites)) {
      if (!entry.modes?.includes(state) || !entry.regex) continue;
      if (!(await regexOk(entry.regex))) {
        console.warn('[Dev Mode] Unsupported rewrite regex skipped:', entry.regex);
        continue;
      }
      rules.push(...scopedRules(domain, {
        priority: 3,
        action: { type: 'redirect', redirect: { regexSubstitution: toSubstitution(entry.replacement || '') } },
        condition: { regexFilter: entry.regex, isUrlFilterCaseSensitive: false, resourceTypes: ALL_RESOURCE_TYPES }
      }));
    }

    let hasMapLocal = false;
    for (const entry of enabled(settings.mapLocal)) {
      if (!entry.modes?.includes(state) || !entry.pattern || !entry.id) continue;
      const { regex } = globToRegex(entry.pattern);
      if (!(await regexOk(regex))) {
        console.warn('[Dev Mode] Unsupported map-local pattern skipped:', entry.pattern);
        continue;
      }
      hasMapLocal = true;
      usesLocalServer = true;
      rules.push(...scopedRules(domain, {
        priority: 2,
        action: { type: 'redirect', redirect: { regexSubstitution: mapLocalTarget(entry) } },
        condition: { regexFilter: regex, isUrlFilterCaseSensitive: false, resourceTypes: ALL_RESOURCE_TYPES }
      }));
    }

    // Pages loading mapped assets from 127.0.0.1 must not be blocked by the site's CSP
    if (hasMapLocal) {
      rules.push({
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Content-Security-Policy', operation: 'remove' },
            { header: 'Content-Security-Policy-Report-Only', operation: 'remove' }
          ]
        },
        condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] }
      });
    }
  }

  // Local server responses: permissive CORS so fonts / fetch / crossorigin scripts work from any page
  if (usesLocalServer) {
    rules.push({
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
          { header: 'Access-Control-Allow-Private-Network', operation: 'set', value: 'true' },
          { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
          { header: 'Timing-Allow-Origin', operation: 'set', value: '*' }
        ]
      },
      condition: { regexFilter: `^${escapeRegex(LOCAL_ORIGIN)}/`, resourceTypes: ALL_RESOURCE_TYPES }
    });
  }

  rules.forEach((rule, i) => { rule.id = i + 1; });

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(r => r.id),
    addRules: rules
  });
}

let syncQueue = Promise.resolve();
function scheduleSync() {
  syncQueue = syncQueue.then(syncRules).catch(err => console.error('[Dev Mode] syncRules failed', err));
  return syncQueue;
}

// Ports the given state relies on: [LOCAL_PORT] when any map-local rule is active, else []
async function localPortsForState(state) {
  const settings = await getSettings();
  const uses = settings.mapLocal.some(e => e.enabled !== false && e.modes?.includes(state) && e.pattern);
  return uses ? [LOCAL_PORT] : [];
}

// Get active tab's state and update icon
async function updateIconForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (!isActionableUrl(tab.url)) {
    updateIcon(STATES.OFF);
    return;
  }

  const domain = extractDomain(tab.url);
  const state  = domain ? await getState(domain) : STATES.OFF;
  updateIcon(state);
}

// Handle state change from popup
async function setState(newState) {
  const normalizedState = normalizeState(newState);
  if (!STATE_CONFIG[normalizedState]) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isActionableUrl(tab?.url)) return;

  const domain = extractDomain(tab.url);

  if (domain) {
    await saveState(domain, normalizedState);
    await scheduleSync();
    await applyConfig(normalizedState, tab.url);
    updateIcon(normalizedState);
    chrome.tabs.reload(tab.id, { bypassCache: true });
  }
}

// Message handler
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.action === 'setState') {
    setState(msg.state).then(() => respond({ success: true }));
    return true;
  }
  if (msg.action === 'getState') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      const domain = isActionableUrl(tab?.url) ? extractDomain(tab.url) : null;
      const state = domain ? await getState(domain) : STATES.OFF;
      if (typeof msg.prefersDark === 'boolean' && msg.prefersDark !== prefersDark) {
        prefersDark = msg.prefersDark;
        if (domain) updateIcon(state);
      }
      respond({ state, ports: await localPortsForState(state) });
    });
    return true;
  }
  if (msg.action === 'getLocalPorts') {
    const url = msg.url || sender.url;
    const domain = isActionableUrl(url) ? extractDomain(url) : null;
    (domain ? getState(domain) : Promise.resolve(STATES.OFF))
      .then(localPortsForState)
      .then(ports => respond({ ports }));
    return true;
  }
  if (msg.action === 'getDefaultSettings') {
    respond(structuredClone(DEFAULT_SETTINGS));
    return false;
  }
  if (msg.action === 'pushServerConfig') {
    pushServerConfig().then(() => respond({ ok: true }));
    return true;
  }
});

// Rules derive from storage: rebuild whenever states or settings change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[STORAGE_KEY] || changes[SETTINGS_KEY])) scheduleSync();
  if (area === 'local' && changes[SETTINGS_KEY]) pushServerConfig();
});

// Apply cookie at multiple points to ensure it's set before request goes out

// 1. Before navigation starts (earliest possible)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const domain = extractDomain(details.url);
  if (!domain) return;

  const state = await getState(domain);
  await applyConfig(state, details.url);
});

// 2. When tab URL changes (catches new tabs)
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  if (!isActionableUrl(changeInfo.url)) {
    updateIcon(STATES.OFF);
    return;
  }

  const domain = extractDomain(changeInfo.url);
  if (!domain) return;

  const state = await getState(domain);
  await applyConfig(state, changeInfo.url);

  if (tab.active) updateIcon(state);
});

// 3. When navigation commits (ensures config is applied)
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const domain = extractDomain(details.url);
  if (!domain) return;

  const state = await getState(domain);
  await applyConfig(state, details.url);

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id === details.tabId) updateIcon(state);
});

// Update icon when switching tabs
chrome.tabs.onActivated.addListener(() => updateIconForActiveTab());

// Initialize
function init() {
  updateIconForActiveTab();
  scheduleSync();
  pushServerConfig();
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
