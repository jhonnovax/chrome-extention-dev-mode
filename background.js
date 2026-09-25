// Rules + globals live in chrome.storage.sync (see sync-schema.js); modes stay in chrome.storage.local
importScripts('sync-schema.js');

// Constants
const COOKIE_NAME = 'htm-dev-mode';
const COOKIE_VALUE = '4815162342';
const STORAGE_KEY = 'domainStates';
const LEGACY_SETTINGS_KEY = 'settings'; // chrome.storage.local keys used before 1.4 (migrated to sync once)
const LEGACY_GLOBALS_KEY = 'globals';
const DEBUGGER_VERSION = '1.3';

const STATES = { OFF: 'off', DEV: 'dev', PREVIEW: 'preview' };

// badge*: exact popup badge CSS colors (light / dark variants)
const STATE_CONFIG = {
  [STATES.OFF]:     { color: '#94A3B8', label: 'OFF', badgeBgLight: 'rgba(158,158,158,0.15)', badgeTextLight: '#5f6368', badgeBgDark: 'rgba(158,158,158,0.20)', badgeTextDark: '#bdbdbd', title: 'Off',              cookie: false, cache: true },
  [STATES.DEV]:     { color: '#22C55E', label: 'DEV', badgeBgLight: 'rgba(0,200,83,0.15)',    badgeTextLight: '#00a344', badgeBgDark: 'rgba(0,200,83,0.20)',    badgeTextDark: '#69f0ae', title: 'Development Mode', cookie: true,  cache: false },
  [STATES.PREVIEW]: { color: '#EAB308', label: 'PRE', badgeBgLight: 'rgba(234,179,8,0.18)',   badgeTextLight: '#a16207', badgeBgDark: 'rgba(234,179,8,0.24)',   badgeTextDark: '#facc15', title: 'Preview Mode',     cookie: false, cache: false }
};

// Content-Type for files served from disk (Chrome gives file:// responses no reliable type)
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm'
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

// ---- Config (chrome.storage.sync via sync-schema.js), cached until the store changes ----

let configCache = null;

// { mapLocal, rewrites, globals } — defaults when the sync store was never written
async function getConfig() {
  if (!configCache) configCache = DevModeConfig.readConfig();
  try {
    return await configCache;
  } catch (err) {
    configCache = null;
    throw err;
  }
}

const getSettings = getConfig;

function invalidateConfig() {
  configCache = null;
}

// One-time move of the pre-1.4 chrome.storage.local rules/globals into the sync store.
// Only runs when the cloud store is still empty, so cloud data always wins over local leftovers.
async function migrateLocalConfig() {
  const local = await chrome.storage.local.get([LEGACY_SETTINGS_KEY, LEGACY_GLOBALS_KEY]);
  const legacySettings = local[LEGACY_SETTINGS_KEY];
  const legacyGlobals = local[LEGACY_GLOBALS_KEY];
  if (!legacySettings && !legacyGlobals) return;

  const all = await chrome.storage.sync.get(null);
  if (!all[DevModeConfig.META_KEY]) {
    if (legacySettings?.mapLocal && legacySettings?.rewrites) await DevModeConfig.writeSettings(legacySettings);
    for (const [domain, list] of Object.entries(legacyGlobals || {})) {
      if (Array.isArray(list) && list.length) await DevModeConfig.writeGlobals(domain, list);
    }
    console.info('[Dev Mode] migrated local rules/globals to chrome.storage.sync');
  }
  await chrome.storage.local.remove([LEGACY_SETTINGS_KEY, LEGACY_GLOBALS_KEY]);
  invalidateConfig();
}

// ---- Global variable overrides (per root domain, injected in DEV/PREVIEW only) ----
// Stored in sync as 'globals:<domain>' → [{ name, value }] with `value` the raw string typed in the popup

async function getGlobals(domain) {
  const { globals } = await getConfig();
  return Array.isArray(globals[domain]) ? globals[domain] : [];
}

async function saveGlobals(domain, list) {
  await DevModeConfig.writeGlobals(domain, list);
  invalidateConfig();
}

// chrome.userScripts is only exposed while the "Allow User Scripts" toggle is on (Chrome 138+)
function userScriptsAvailable() {
  try {
    return !!chrome.userScripts;
  } catch {
    return false;
  }
}

// `true`, `42`, `"text"`, `{"a":1}` become real values; anything else stays a string
function parseGlobalValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Snippet run in the page's MAIN world at document_start: each variable becomes a locked accessor
// on window, so later assignments by page code are ignored and the override survives the page's life
function buildGlobalsCode(list) {
  const vars = {};
  for (const { name, value } of list) {
    if (typeof name === 'string' && name.trim()) vars[name.trim()] = parseGlobalValue(String(value ?? ''));
  }
  return `(() => {
  const vars = ${JSON.stringify(vars)};
  for (const key of Object.keys(vars)) {
    const value = vars[key];
    try {
      Object.defineProperty(window, key, { get: () => value, set() {}, configurable: true, enumerable: true });
    } catch (e) {
      try { window[key] = value; } catch {}
    }
  }
})();`;
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

// First map-local rule matching the URL -> file:// URL under the rule's folder, or null.
// The last wildcard of the pattern is the path under the folder (as in the local-server days).
function mapLocalTarget(url, settings, state) {
  const bare = url.split(/[?#]/)[0];
  for (const ml of enabledFor(settings.mapLocal, state)) {
    if (!ml.pattern || !ml.localPath) continue;
    const { regex, groups } = globToRegex(ml.pattern);
    let match;
    try { match = bare.match(new RegExp(regex, 'i')); } catch { continue; }
    if (!match) continue;
    const url = fileUrlFor(ml.localPath, groups ? match[groups] : '');
    return url ? { url, id: ml.id } : null;
  }
  return null;
}

// Per-rule outcome of the last mappings since the worker started (shown in the options page):
// { [ruleId]: { served, missing, last: { ok, url, at } } }
const mapLocalStats = {};
function recordMapLocal(id, ok, url) {
  const s = mapLocalStats[id] || (mapLocalStats[id] = { served: 0, missing: 0, last: null });
  ok ? s.served++ : s.missing++;
  s.last = { ok, url, at: Date.now() };
}

// file:///<folder>/<relPath>; directories get index.html; anything escaping the folder is refused
function fileUrlFor(folder, relPath) {
  const root = 'file://' + encodeURI(folder.replace(/\/+$/, '')) + '/';
  let rel = String(relPath || '').replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  try {
    const target = new URL(rel, root);
    if (target.protocol !== 'file:' || !target.pathname.startsWith(new URL(root).pathname)) return null;
    return target.href;
  } catch {
    return null;
  }
}

function contentTypeFor(fileUrl, fallback) {
  const path = new URL(fileUrl).pathname;
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return MIME[ext] || fallback || 'application/octet-stream';
}

// "Allow access to file URLs" toggle on the extension card (chrome://extensions → Dev Mode → Details).
// When the API is not exposed to the worker the answer is "unknown" → assume allowed and let the fetch decide
// (the popup checks the toggle itself, extension pages always have chrome.extension).
let fileAccessCache = { value: null, at: 0 };
async function fileAccessAllowed() {
  if (Date.now() - fileAccessCache.at < 5_000 && fileAccessCache.value !== null) return fileAccessCache.value;
  let value = true;
  try {
    if (typeof chrome.extension?.isAllowedFileSchemeAccess === 'function') {
      value = await chrome.extension.isAllowedFileSchemeAccess();
    }
  } catch { /* unknown: keep true */ }
  fileAccessCache = { value, at: Date.now() };
  return value;
}

// Does the given state rely on any map-local rule?
async function usesMapLocal(state) {
  const settings = await getSettings();
  return enabledFor(settings.mapLocal, state).some(e => e.pattern && e.localPath);
}

// ---- Request interception (chrome.debugger + Fetch domain) ----
// Like Charles: the page keeps the original URL/origin. Map Local answers the request with
// the local file (Fetch.fulfillRequest); Rewrite changes the URL invisibly (Fetch.continueRequest).

const attachedTabs = new Set();
const tabStates = new Map(); // tabId -> state the interception was enabled with
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
  let patterns = enabledFor(settings.mapLocal, state)
    .filter(e => e.pattern)
    .map(e => ({ urlPattern: e.pattern, requestStage: 'Request' }));
  if (enabledFor(settings.rewrites, state).some(e => e.regex)) {
    patterns = [{ urlPattern: '*', requestStage: 'Request' }];
  }
  return patterns;
}

// Current mode of a tab, read from its live URL and the stored modes (OFF when the tab is gone)
async function currentTabState(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return stateForUrl(tab?.url);
}

async function enableInterception(tabId, state) {
  const patterns = await interceptPatterns(state);
  // The mode may have been switched to OFF while the patterns were being read
  if ((await currentTabState(tabId)) === STATES.OFF) throw new Error('mode is OFF');
  tabStates.set(tabId, state);
  if (!patterns.length) {
    await sendCommand(tabId, 'Fetch.disable').catch(() => {});
    return;
  }
  await sendCommand(tabId, 'Fetch.enable', { patterns });
  console.info(`[Dev Mode] interception on tab ${tabId} (${state}):`, patterns.map(p => p.urlPattern).join(', '));
}

const attaching = new Map(); // tabId -> in-flight attach promise

// Attach + enable interception. `reloadAfter`: the call comes from a navigation whose document
// request may already be in flight, so reload once when this call performed a new attach.
// OFF is re-checked after every await: a mode switch that lands mid-attach must win, otherwise the
// tab would stay attached (debugging bar, interception) although the popup shows Off.
async function attachTab(tabId, state, { reloadAfter = false } = {}) {
  if (state === STATES.OFF) return detachTab(tabId);
  if (attachedTabs.has(tabId)) {
    try {
      await enableInterception(tabId, state);
      return;
    } catch (err) {
      if (/mode is OFF/.test(err?.message || '')) return detachTab(tabId);
      // Session is gone (worker restart, DevTools took over…) — attach again below
      attachedTabs.delete(tabId);
    }
  }
  if (userDetachedTabs.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);

  const job = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
      console.info(`[Dev Mode] attached tab ${tabId} (${state})`);
    } catch (err) {
      // Already attached by us in a previous worker life, or not attachable (chrome://, another debugger)
      if (!/already attached/i.test(err?.message || '')) {
        console.warn(`[Dev Mode] cannot attach tab ${tabId}: ${err?.message}`);
        return;
      }
      console.info(`[Dev Mode] tab ${tabId} already attached, reusing session`);
    }
    attachedTabs.add(tabId);
    updateKeepAlive();
    try {
      await enableInterception(tabId, state);
    } catch (err) {
      if (/mode is OFF/.test(err?.message || '')) {
        console.info(`[Dev Mode] tab ${tabId} switched to OFF during attach, detaching`);
        await forceDetach(tabId);
        return;
      }
      console.warn(`[Dev Mode] Fetch.enable failed on tab ${tabId}: ${err?.message}`);
      attachedTabs.delete(tabId);
      updateKeepAlive();
      return;
    }
    if (reloadAfter) {
      console.info(`[Dev Mode] reloading tab ${tabId} so the document is intercepted`);
      // Plain reload: a cache-bypassing reload makes some on24 pages answer 404
      chrome.tabs.reload(tabId).catch(() => {});
    }
  })();

  attaching.set(tabId, job);
  try {
    await job;
  } finally {
    attaching.delete(tabId);
  }
}

// Always ask Chrome to detach: the in-memory set is lost when the service worker restarts,
// but the debugger session is not, so it must not be the only source of truth
async function forceDetach(tabId) {
  const known = attachedTabs.delete(tabId);
  tabStates.delete(tabId);
  updateKeepAlive();
  try {
    await chrome.debugger.detach({ tabId });
    console.info(`[Dev Mode] detached tab ${tabId}`);
  } catch (err) {
    if (known) console.warn(`[Dev Mode] detach tab ${tabId} failed: ${err?.message}`);
  }
}

// Detach after any attach still in flight for the tab, so a detach requested during an attach
// is not overtaken by it (Chrome would otherwise keep the session the attach opens)
async function detachTab(tabId) {
  if (attaching.has(tabId)) await attaching.get(tabId).catch(() => {});
  await forceDetach(tabId);
}

// Rebuild the attached set from Chrome after a worker (re)start
async function loadAttachedTabs() {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null) attachedTabs.add(t.tabId);
    }
  } catch { /* ignore */ }
  updateKeepAlive();
}

// Attach or detach a tab according to the state of its current URL
async function syncTab(tabId, url, options) {
  const state = await stateForUrl(url);
  if (state === STATES.OFF) await detachTab(tabId);
  else await attachTab(tabId, state, options);
}

// Re-evaluate every open tab (worker start, settings change)
async function syncAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => syncTab(tab.id, tab.url)));
}

// Worker startup: learn what Chrome still has attached, then reconcile every tab
let ready = null;
function ensureReady() {
  if (!ready) ready = loadAttachedTabs().then(syncAllTabs).catch(() => {});
  return ready;
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

  // Events can arrive right after a worker restart, before the attached set is rebuilt
  attachedTabs.add(tabId);
  updateKeepAlive();

  // Only request-stage events are subscribed; be safe if a response-stage one ever arrives
  if (params.responseStatusCode !== undefined || params.responseErrorReason) {
    return finish('Fetch.continueResponse');
  }

  try {
    // The mode belongs to the page (tab), not to the request's host: assets may come from a CDN
    let state = tabStates.get(tabId);
    if (!state) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      state = await stateForUrl(tab?.url);
      tabStates.set(tabId, state);
    }
    const settings = await getSettings();
    if (state === STATES.OFF) {
      // An OFF tab must browse as if the extension were not installed: pass the request
      // through untouched and end the debugger session that is still delivering events
      await finish('Fetch.continueRequest');
      detachTab(tabId);
      return;
    }

    const rewritten = applyRewrites(request.url, settings, state);
    const hit = mapLocalTarget(rewritten, settings, state);
    const local = hit?.url || null;
    const isDocument = params.resourceType === 'Document';
    if (isDocument || local || rewritten !== request.url) {
      console.info(`[Dev Mode] ${params.resourceType} ${request.url} (${state}) → ${local || (rewritten !== request.url ? rewritten : 'real site')}`);
    }

    if (local) {
      if (!(await fileAccessAllowed())) {
        if (!warnedUrls.has('file-access')) {
          warnedUrls.add('file-access');
          console.warn('[Dev Mode] Map Local needs "Allow access to file URLs": enable it in the extension details (chrome://extensions → Dev Mode → Details). Serving from the real site.');
        }
        return finish('Fetch.continueRequest');
      }
      warnedUrls.delete('file-access');

      // A missing file rejects the fetch (file:// has no 404); a directory answers Chrome's listing page
      let res = null;
      try {
        res = await fetch(local, { cache: 'no-store' });
      } catch { /* no such file */ }
      recordMapLocal(hit.id, !!res?.ok, local);
      if (res?.ok) {
        const body = toBase64(await res.arrayBuffer());
        const responseHeaders = [
          { name: 'Content-Type', value: contentTypeFor(local, res.headers.get('content-type')) },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'X-Dev-Mode', value: 'map-local' }
        ];
        if (request.headers?.Origin || request.headers?.origin) {
          responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: request.headers.Origin || request.headers.origin });
          responseHeaders.push({ name: 'Access-Control-Allow-Credentials', value: 'true' });
        }
        return finish('Fetch.fulfillRequest', { responseCode: 200, responseHeaders, body });
      }
      if (isDocument || !warnedUrls.has(rewritten)) {
        warnedUrls.add(rewritten);
        console.warn(`[Dev Mode] No local file ${local}; serving ${request.url} from the real site.`);
      }
      // The rewrite existed to reach the local file; without it, ask the real site for the original URL
      return finish('Fetch.continueRequest');
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
  console.info(`[Dev Mode] Chrome detached tab ${source.tabId}: ${reason}`);
  attachedTabs.delete(source.tabId);
  tabStates.delete(source.tabId);
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

// ---- userScripts: one MAIN-world document_start script per domain with global overrides ----
// Independent of the debugger/Fetch path: injected in DEV and PREVIEW, paused (kept but not registered) in OFF.

let warnedUserScripts = false;

async function syncGlobals() {
  if (!userScriptsAvailable()) {
    if (!warnedUserScripts) {
      warnedUserScripts = true;
      console.warn('[Dev Mode] chrome.userScripts unavailable: enable "Allow User Scripts" in the extension details to inject global variables.');
    }
    return;
  }
  warnedUserScripts = false;

  const { globals: all } = await getConfig();
  const { [STORAGE_KEY]: states = {} } = await chrome.storage.local.get(STORAGE_KEY);
  const scripts = [];
  const paused = [];
  for (const [rawDomain, list] of Object.entries(all)) {
    const domain = rawDomain.replace(/^\./, '');
    if (!domain || !Array.isArray(list) || !list.length) continue;
    // Variables are kept but not injected while the domain is OFF
    if (normalizeState(states[rawDomain]) === STATES.OFF) {
      paused.push(domain);
      continue;
    }
    scripts.push({
      id: `globals:${domain}`,
      matches: [`*://*.${domain}/*`, `*://${domain}/*`],
      js: [{ code: buildGlobalsCode(list) }],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true
    });
  }

  await chrome.userScripts.unregister();
  if (scripts.length) {
    try {
      await chrome.userScripts.register(scripts);
    } catch (err) {
      console.error(`[Dev Mode] userScripts.register failed: ${err?.message}`, scripts);
      throw err;
    }
  }
  console.info(`[Dev Mode] global overrides registered for: ${scripts.map(s => s.id.slice(8)).join(', ') || 'none'}`
    + (paused.length ? ` (paused while OFF: ${paused.join(', ')})` : ''));
}

let globalsQueue = Promise.resolve();
function scheduleGlobalsSync() {
  globalsQueue = globalsQueue.then(syncGlobals).catch(err => console.error('[Dev Mode] syncGlobals failed', err));
  return globalsQueue;
}

// Popup: replace the active tab domain's variable list, re-register and reload so it applies now
async function setGlobals(list) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const domain = isActionableUrl(tab?.url) ? extractDomain(tab.url) : null;
  if (!domain) return { success: false, globals: [] };

  const clean = [];
  for (const entry of Array.isArray(list) ? list : []) {
    // "window.isNurturePage" and "isNurturePage" mean the same global
    const name = String(entry?.name ?? '').trim().replace(/^(window|self|globalThis)\./, '');
    if (!name) continue;
    const value = String(entry?.value ?? '');
    const existing = clean.findIndex(e => e.name === name);
    if (existing >= 0) clean[existing] = { name, value };
    else clean.push({ name, value });
  }

  console.info(`[Dev Mode] setGlobals ${domain}:`, clean.map(e => `${e.name}=${e.value}`).join(', ') || '(none)');
  await saveGlobals(domain, clean);
  await scheduleGlobalsSync();
  chrome.tabs.reload(tab.id).catch(() => {});
  return { success: true, globals: clean };
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
    console.info(`[Dev Mode] setState ${domain} → ${normalizedState} (tab ${tab.id})`);
    await saveState(domain, normalizedState);
    await scheduleSync();
    await scheduleGlobalsSync();
    await applyConfig(normalizedState, tab.url);
    userDetachedTabs.delete(tab.id);
    await ensureReady();
    await syncAllTabs();
    updateIcon(normalizedState);
    chrome.tabs.reload(tab.id);
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
      respond({
        state,
        domain,
        usesMapLocal: await usesMapLocal(state),
        fileAccess: await fileAccessAllowed(),
        globals: domain ? await getGlobals(domain) : [],
        userScripts: userScriptsAvailable()
      });
    });
    return true;
  }
  if (msg.action === 'setGlobals') {
    setGlobals(msg.globals).then(respond);
    return true;
  }
  if (msg.action === 'openExtensionDetails') {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).then(() => respond({ ok: true }));
    return true;
  }
  if (msg.action === 'getMapLocalStats') {
    respond(mapLocalStats);
    return false;
  }
});

// Interception, no-cache rules and globals derive from storage: rebuild whenever it changes.
// 'local' holds the modes (domainStates); 'sync' holds rules and globals, and fires for edits made
// here as well as for changes arriving from another machine through Chrome sync.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    // Forget the mode each attached tab was enabled with: the next paused request re-reads it
    tabStates.clear();
    scheduleSync();
    ensureReady().then(syncAllTabs);
    // Globals depend on the domain state too (not injected while OFF)
    scheduleGlobalsSync();
    return;
  }
  if (area !== 'sync') return;
  invalidateConfig();
  const keys = Object.keys(changes);
  if (keys.some(DevModeConfig.isRuleKey)) ensureReady().then(syncAllTabs);
  if (keys.some(DevModeConfig.isGlobalsKey)) scheduleGlobalsSync();
});

// Apply cookie at multiple points to ensure it's set before request goes out

// 1. Before navigation starts (earliest possible)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const domain = extractDomain(details.url);
  if (!domain) return;

  // A fresh top-level navigation ends a user-cancelled debugging session's grace period
  userDetachedTabs.delete(details.tabId);
  ensureReady().then(() => syncTab(details.tabId, details.url, { reloadAfter: true }));

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
  await ensureReady();
  await syncTab(tabId, changeInfo.url, { reloadAfter: true });
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
  tabStates.delete(tabId);
  userDetachedTabs.delete(tabId);
  updateKeepAlive();
});

// Update icon when switching tabs
chrome.tabs.onActivated.addListener(() => updateIconForActiveTab());

// Initialize
function init() {
  updateIconForActiveTab();
  scheduleSync();
  scheduleGlobalsSync();
  ensureReady();
}
chrome.runtime.onInstalled.addListener(() => {
  migrateLocalConfig().catch(err => console.error('[Dev Mode] migration failed', err)).then(init);
});
chrome.runtime.onStartup.addListener(init);
init();
