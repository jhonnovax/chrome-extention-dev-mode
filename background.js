// Constants
const COOKIE_NAME = 'htm-dev-mode';
const COOKIE_VALUE = '4815162342';
const STORAGE_KEY = 'domainStates';
const SETTINGS_KEY = 'settings';
const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = 4815;
const LOCAL_ORIGIN = `http://${LOCAL_HOST}:${LOCAL_PORT}`;
const DEBUGGER_VERSION = '1.3';

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

// State for a URL (OFF for anything the extension can't act on)
async function stateForUrl(url) {
  if (!isActionableUrl(url)) return STATES.OFF;
  const domain = extractDomain(url);
  return domain ? getState(domain) : STATES.OFF;
}

// Update extension icon
function updateIcon(state) {
  const { title } = STATE_CONFIG[state];
  chrome.action.setIcon({ imageData: generateIcons(state) });
  chrome.action.setTitle({ title });
}

// Apply state configuration (cookie). Network rules are handled by syncRules() / interception.
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

// ---- Map Local / Rewrite resolution ----

function escapeRegex(str) {
  return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// Glob pattern ("https://*/view/orion/*") -> anchored regex, each * is a capture group
function globToRegex(pattern) {
  const regex = pattern.split('*').map(escapeRegex).join('(.*)');
  return { regex: `^${regex}$`, groups: pattern.split('*').length - 1 };
}

const enabledFor = (list, state) => list.filter(e => e.enabled !== false && e.modes?.includes(state));

// Apply the state's rewrite rules to a URL (Charles "Rewrite"); returns the possibly changed URL
function applyRewrites(url, settings, state) {
  let current = url;
  for (const rw of enabledFor(settings.rewrites, state)) {
    if (!rw.regex) continue;
    try { current = current.replace(new RegExp(rw.regex, 'i'), rw.replacement || ''); } catch { /* invalid regex */ }
  }
  return current;
}

// First map-local rule matching the URL -> local server URL (/m/<ruleId>/<last wildcard>) or null
function mapLocalTarget(url, settings, state) {
  const bare = url.split(/[?#]/)[0];
  for (const ml of enabledFor(settings.mapLocal, state)) {
    if (!ml.pattern || !ml.id) continue;
    const { regex, groups } = globToRegex(ml.pattern);
    let match;
    try { match = bare.match(new RegExp(regex, 'i')); } catch { continue; }
    if (!match) continue;
    return `${LOCAL_ORIGIN}/m/${ml.id}/` + (groups ? match[groups] : '');
  }
  return null;
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

// ---- Request interception (chrome.debugger + Fetch domain) ----
// Like Charles: the page keeps the original URL/origin. Map Local answers the request with
// the local file (Fetch.fulfillRequest); Rewrite changes the URL invisibly (Fetch.continueRequest).

const attachedTabs = new Set();
const userDetachedTabs = new Set();
const warnedUrls = new Set();
let keepAliveTimer = null;

function updateKeepAlive() {
  if (attachedTabs.size && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  } else if (!attachedTabs.size && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function sendCommand(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Fetch.enable patterns for a state: raw globs of map-local rules; '*' when any rewrite applies
async function interceptPatterns(state) {
  const settings = await getSettings();
  const patterns = enabledFor(settings.mapLocal, state)
    .filter(e => e.pattern)
    .map(e => ({ urlPattern: e.pattern, requestStage: 'Request' }));
  if (enabledFor(settings.rewrites, state).some(e => e.regex)) {
    return [{ urlPattern: '*', requestStage: 'Request' }];
  }
  return patterns;
}

async function enableInterception(tabId, state) {
  const patterns = await interceptPatterns(state);
  if (!patterns.length) {
    await sendCommand(tabId, 'Fetch.disable').catch(() => {});
    return;
  }
  await sendCommand(tabId, 'Fetch.enable', { patterns });
}

async function attachTab(tabId, state) {
  if (attachedTabs.has(tabId)) {
    await enableInterception(tabId, state).catch(() => {});
    return;
  }
  if (userDetachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  } catch (err) {
    // Already attached by us in a previous worker life, or not attachable (chrome://, another debugger)
    if (!/already attached/i.test(err?.message || '')) return;
  }
  attachedTabs.add(tabId);
  updateKeepAlive();
  try {
    await enableInterception(tabId, state);
  } catch (err) {
    console.warn('[Dev Mode] Fetch.enable failed', err);
  }
}

async function detachTab(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  updateKeepAlive();
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

// Attach or detach a tab according to the state of its current URL
async function syncTab(tabId, url) {
  const state = await stateForUrl(url);
  if (state === STATES.OFF) await detachTab(tabId);
  else await attachTab(tabId, state);
}

// Re-evaluate every open tab (worker start, settings change)
async function syncAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => syncTab(tab.id, tab.url)));
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function onRequestPaused(tabId, params) {
  const { requestId, request } = params;
  const finish = (method, extra = {}) =>
    sendCommand(tabId, method, { requestId, ...extra }).catch(() => {});

  try {
    const [state, settings] = await Promise.all([stateForUrl(request.url), getSettings()]);
    if (state === STATES.OFF) return finish('Fetch.continueRequest');

    const rewritten = applyRewrites(request.url, settings, state);
    const local = mapLocalTarget(rewritten, settings, state);

    if (local) {
      let res = null;
      try {
        res = await fetch(local, { cache: 'no-store' });
      } catch {
        if (!warnedUrls.has('server')) {
          warnedUrls.add('server');
          console.warn('[Dev Mode] Local server not reachable; serving from the real site. Run "npm run install-service" once.');
        }
      }
      if (res?.ok) {
        const body = toBase64(await res.arrayBuffer());
        const responseHeaders = [
          { name: 'Content-Type', value: res.headers.get('content-type') || 'application/octet-stream' },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'X-Dev-Mode', value: 'map-local' }
        ];
        if (request.headers?.Origin || request.headers?.origin) {
          responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: request.headers.Origin || request.headers.origin });
          responseHeaders.push({ name: 'Access-Control-Allow-Credentials', value: 'true' });
        }
        return finish('Fetch.fulfillRequest', { responseCode: 200, responseHeaders, body });
      }
      if (res && !warnedUrls.has(rewritten)) {
        warnedUrls.add(rewritten);
        console.warn(`[Dev Mode] No local file for ${rewritten} (${res.status}); serving from the real site.`);
      }
    }

    if (rewritten !== request.url) return finish('Fetch.continueRequest', { url: rewritten });
    return finish('Fetch.continueRequest');
  } catch (err) {
    console.error('[Dev Mode] interception error', err);
    return finish('Fetch.continueRequest');
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Fetch.requestPaused' && source.tabId != null) onRequestPaused(source.tabId, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attachedTabs.delete(source.tabId);
  updateKeepAlive();
  // User clicked "Cancel" on the debugging bar: leave the tab alone until it navigates again
  if (reason === 'canceled_by_user') userDetachedTabs.add(source.tabId);
});

// ---- declarativeNetRequest: no-cache headers for domains with cache disabled ----

async function syncRules() {
  const { [STORAGE_KEY]: states = {} } = await chrome.storage.local.get(STORAGE_KEY);
  const rules = [];

  for (const [rawDomain, rawState] of Object.entries(states)) {
    const state = normalizeState(rawState);
    const domain = rawDomain.replace(/^\./, '');
    if (state === STATES.OFF || !domain || STATE_CONFIG[state].cache) continue;

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
  const uses = enabledFor(settings.mapLocal, state).some(e => e.pattern);
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
    userDetachedTabs.delete(tab.id);
    await syncAllTabs();
    updateIcon(normalizedState);
    chrome.tabs.reload(tab.id, { bypassCache: true });
  }
}

// Message handler
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
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
  if (msg.action === 'getDefaultSettings') {
    respond(structuredClone(DEFAULT_SETTINGS));
    return false;
  }
  if (msg.action === 'pushServerConfig') {
    pushServerConfig().then(() => respond({ ok: true }));
    return true;
  }
});

// Rules and interception derive from storage: rebuild whenever states or settings change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEY] || changes[SETTINGS_KEY]) {
    scheduleSync();
    syncAllTabs();
  }
  if (changes[SETTINGS_KEY]) pushServerConfig();
});

// Apply cookie at multiple points to ensure it's set before request goes out

// 1. Before navigation starts (earliest possible)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const domain = extractDomain(details.url);
  if (!domain) return;

  // A fresh top-level navigation ends a user-cancelled debugging session's grace period
  userDetachedTabs.delete(details.tabId);
  syncTab(details.tabId, details.url);

  const state = await getState(domain);
  await applyConfig(state, details.url);
});

// 2. When tab URL changes (catches new tabs)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  if (!isActionableUrl(changeInfo.url)) {
    detachTab(tabId);
    updateIcon(STATES.OFF);
    return;
  }

  const domain = extractDomain(changeInfo.url);
  if (!domain) return;

  const state = await getState(domain);
  await syncTab(tabId, changeInfo.url);
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

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  userDetachedTabs.delete(tabId);
  updateKeepAlive();
});

// Update icon when switching tabs
chrome.tabs.onActivated.addListener(() => updateIconForActiveTab());

// Initialize
function init() {
  updateIconForActiveTab();
  scheduleSync();
  pushServerConfig();
  syncAllTabs();
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
