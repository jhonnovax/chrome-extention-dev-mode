// Rules + globals live in chrome.storage.sync (see sync-schema.js). Modes belong to a tab for its
// life only: kept in memory (mirrored in chrome.storage.session, RAM only, so a worker restart keeps
// them), every tab starts OFF and nothing about modes is ever written to disk.
importScripts('sync-schema.js');

// Constants
const COOKIE_NAME = 'htm-dev-mode';
const COOKIE_VALUE = '4815162342';
const TAB_MODES_KEY = 'tabModes';        // chrome.storage.session: { [tabId]: state }, DEV/PREVIEW tabs only
const LEGACY_LOCAL_KEYS = ['domainStates', 'activeTabOnly']; // chrome.storage.local keys of 1.5 and earlier
const LEGACY_SETTINGS_KEY = 'settings'; // chrome.storage.local keys used before 1.4 (migrated to sync once)
const LEGACY_GLOBALS_KEY = 'globals';
const DEBUGGER_VERSION = '1.3';

const STATES = { OFF: 'off', DEV: 'dev', PREVIEW: 'preview' };

// ---- Activity log: the worker's own "[Dev Mode]" console lines, readable from the options page ----
// (the service worker console is hard to reach; the options page shows this buffer instead)
const ACTIVITY_MAX = 1000;
const activityLog = [];
for (const level of ['info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[Dev Mode]')) {
      const text = args.map(a => (typeof a === 'string' ? a : (a?.message || safeJson(a)))).join(' ');
      // Network trace lines carry long cookie lists: keep them whole
      activityLog.push({ at: Date.now(), level, text: text.slice(0, text.startsWith('[Dev Mode] net ') ? 4000 : 600) });
      if (activityLog.length > ACTIVITY_MAX) activityLog.splice(0, activityLog.length - ACTIVITY_MAX);
    }
    original(...args);
  };
}
function safeJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}
// Errors nobody awaited would only show in chrome://extensions: put them in the Activity log too
self.addEventListener('unhandledrejection', (e) => console.error(`[Dev Mode] unhandled error: ${e.reason?.message || e.reason}`, e.reason?.stack || ''));
self.addEventListener('error', (e) => console.error(`[Dev Mode] uncaught error: ${e.message} (${e.filename}:${e.lineno})`));

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

// ---- Tab modes: tabId -> state, for the tab's life only ----
// Loaded once from chrome.storage.session (the worker may restart while tabs live), then kept in memory.
// OFF is the absence of an entry, so a new tab (or one the extension never saw) is OFF.

let tabModes = null;    // Map<tabId, state>
let tabStoreLoad = null;

function loadTabStore() {
  if (!tabStoreLoad) {
    tabStoreLoad = chrome.storage.session.get(TAB_MODES_KEY).catch(() => ({})).then(r => {
      tabModes = new Map(Object.entries(r[TAB_MODES_KEY] || {}).map(([id, st]) => [Number(id), normalizeState(st)]));
    });
  }
  return tabStoreLoad;
}

function persistTabStore() {
  chrome.storage.session.set({ [TAB_MODES_KEY]: Object.fromEntries(tabModes) }).catch(() => {});
}

async function getTabMode(tabId) {
  await loadTabStore();
  return tabModes.get(tabId) || STATES.OFF;
}

async function setTabMode(tabId, state) {
  await loadTabStore();
  if (state === STATES.OFF) tabModes.delete(tabId);
  else tabModes.set(tabId, state);
  persistTabStore();
}

// Tab ids currently in DEV/PREVIEW (optionally only those in `state`)
async function activeTabIds(state) {
  await loadTabStore();
  return [...tabModes].filter(([, st]) => !state || st === state).map(([id]) => id);
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

// `true`, `42`, `"text"`, `{"a":1}` become real values; anything else stays a string
function parseGlobalValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// [{ name, value }] -> { name: parsedValue }
function parseGlobalVars(list) {
  const vars = {};
  for (const { name, value } of list) {
    if (typeof name === 'string' && name.trim()) vars[name.trim()] = parseGlobalValue(String(value ?? ''));
  }
  return vars;
}

// Page-side snippet: each variable becomes a locked accessor on window, so later assignments by
// page code are ignored and the override survives the page's life
const DEFINE_GLOBALS_JS = `
  for (const key of Object.keys(vars)) {
    const value = vars[key];
    try {
      Object.defineProperty(window, key, { get: () => value, set() {}, configurable: true, enumerable: true });
    } catch (e) {
      try { window[key] = value; } catch {}
    }
  }`;

// Script for Page.addScriptToEvaluateOnNewDocument: runs in every document of an attached target,
// including about:blank / srcdoc / blob: iframes that user scripts cannot match, so it works out
// the frame's root domain itself: from its origin, else from the nearest same-origin ancestor
// (about:blank and srcdoc inherit the creator's origin), else from the referrer / embedding page.
// The script is only installed on sessions of DEV/PREVIEW tabs (the tab's mode rules its frames).
function buildFrameGlobalsCode(byDomain) {
  return `(() => {
  const byDomain = ${JSON.stringify(byDomain)};
  const hostOf = (origin) => { try { return origin && origin !== 'null' ? new URL(origin).hostname : ''; } catch (e) { return ''; } };
  const domainOf = (host) => host ? '.' + host.split('.').slice(-2).join('.') : '';
  let host = '';
  try {
    let w = window;
    for (let i = 0; i < 16 && !host; i++) {
      host = hostOf(w.origin);
      if (w === w.parent) break;
      w = w.parent;
    }
  } catch (e) {}
  if (!host) { try { host = hostOf(new URL(document.referrer).origin); } catch (e) {} }
  if (!host) { try { host = hostOf(location.ancestorOrigins && location.ancestorOrigins[0]); } catch (e) {} }
  const vars = byDomain[domainOf(host)];
  if (!vars) return;${DEFINE_GLOBALS_JS}
})();`;
}

// Mode of a tab showing `url` (OFF for anything the extension can't act on)
async function modeForTab(tabId, url) {
  if (tabId == null || !isActionableUrl(url)) return STATES.OFF;
  return getTabMode(tabId);
}

// Update extension icon
function updateIcon(state, tabId) {
  const { title } = STATE_CONFIG[state];
  const target = tabId != null ? { tabId } : {};
  chrome.action.setIcon({ ...target, imageData: generateIcons(state) }).catch(() => {});
  chrome.action.setTitle({ ...target, title }).catch(() => {});
}

// No htm-dev-mode may live in the cookie jar (1.5 and the first per-tab builds wrote one there, and
// it would reach every tab): removed at browser/extension start and at every worker start
async function removeAllDevCookies() {
  for (const query of [{ name: COOKIE_NAME }, { name: COOKIE_NAME, partitionKey: {} }]) {
    const all = await chrome.cookies.getAll(query).catch(() => []);
    for (const c of all) {
      const url = `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
      await chrome.cookies.remove({ url, name: COOKIE_NAME, ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}) }).catch(() => {});
    }
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
//
// Frames: a cross-site iframe runs in its own renderer with its own DevTools target, invisible to
// the tab's root session. The root session therefore auto-attaches iframe targets (flatten mode);
// every child session gets the same Fetch patterns and the same globals script, and its events and
// replies carry the child's sessionId. The mode of a request is the one of its frame's document
// when that is not OFF (an on24 page embedded in a foreign site), otherwise the tab's (assets
// served from CDNs, third-party iframes inside a DEV page).

const attachedTabs = new Set();
const tabPatterns = new Map();     // tabId -> Fetch.enable patterns in force ([] = disabled)
const childSessions = new Map();   // tabId -> Set<sessionId> of auto-attached iframe targets
const userDetachedTabs = new Set();
const pendingReload = new Set();   // tabs that navigated while kept detached by "active tab only"
const warnedUrls = new Set();
let keepAliveTimer = null;

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

function updateKeepAlive() {
  if (attachedTabs.size && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  } else if (!attachedTabs.size && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// sessionId undefined = the tab's root session, otherwise an auto-attached child (iframe) session
function sendCommand(tabId, method, params, sessionId) {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  return chrome.debugger.sendCommand(target, method, params);
}

function childrenOf(tabId) {
  let set = childSessions.get(tabId);
  if (!set) childSessions.set(tabId, set = new Set());
  return set;
}

// Drop everything remembered about a tab's debugger session
function forgetTab(tabId) {
  attachedTabs.delete(tabId);
  tabPatterns.delete(tabId);
  childSessions.delete(tabId);
  for (const key of frameGlobalsScripts.keys()) {
    if (key === String(tabId) || key.startsWith(`${tabId}/`)) frameGlobalsScripts.delete(key);
  }
  updateKeepAlive();
}

// Fetch.enable patterns for a set of states: raw globs of map-local rules; '*' when any rewrite
// applies. Documents (top and iframes) are always paused so the mode's cookie for their domain is
// in place before the request leaves, whatever the rules. XHR/fetch responses are always paused
// too, for followRedirectInWorker (Chrome mishandles cross-origin redirects of intercepted requests).
const REDIRECT_PATTERNS = [
  { urlPattern: '*', resourceType: 'XHR', requestStage: 'Response' },
  { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Response' }
];

async function interceptPatterns(states) {
  if (!states.length) return [];
  const settings = await getSettings();
  const globs = new Set();
  for (const state of states) {
    if (enabledFor(settings.rewrites, state).some(e => e.regex)) {
      return [{ urlPattern: '*', requestStage: 'Request' }, ...REDIRECT_PATTERNS];
    }
    for (const e of enabledFor(settings.mapLocal, state)) if (e.pattern) globs.add(e.pattern);
  }
  return [
    { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
    ...REDIRECT_PATTERNS,
    ...[...globs].map(urlPattern => ({ urlPattern, requestStage: 'Request' }))
  ];
}

async function applyPatterns(tabId, patterns, sessionId) {
  if (!patterns.length) {
    await sendCommand(tabId, 'Fetch.disable', undefined, sessionId).catch(() => {});
    return;
  }
  await sendCommand(tabId, 'Fetch.enable', { patterns }, sessionId);
}

// Chrome's refusal to debug a tab holding another extension's frame; reported once by reportBlockedTab
const isForeignFrameError = (err) => /chrome-extension/i.test(err?.message || '');

// Thrown by enableInterception when the tab stopped qualifying for a session mid-attach
const isIneligibleError = (err) => /tab not eligible/.test(err?.message || '');

// Root session first (errors propagate), then every known child session
async function enableInterception(tabId, states) {
  const patterns = await interceptPatterns(states);
  // The tab may have been switched to OFF (or sent to the background under "active tab only") while
  // the patterns were being read: that always wins over the attach
  if (!(await tabStatesFor(tabId)).length) throw new Error('tab not eligible');
  tabPatterns.set(tabId, patterns);
  await applyPatterns(tabId, patterns);
  // Cross-site iframes get their own sessions (Target.attachedToTarget). Idempotent, and re-sent on
  // every sync so a session whose first attempt failed still gets it.
  sendCommand(tabId, 'Target.setAutoAttach', AUTO_ATTACH).catch(err => {
    if (!isForeignFrameError(err) && !/not attached/i.test(err?.message || '')) {
      console.warn(`[Dev Mode] cannot auto-attach iframes of tab ${tabId}: ${err?.message}`);
    }
  });
  for (const sessionId of childrenOf(tabId)) {
    applyPatterns(tabId, patterns, sessionId).catch(err => {
      if (/session with given id not found/i.test(err?.message || '')) childrenOf(tabId).delete(sessionId);
      else console.warn(`[Dev Mode] Fetch.enable failed on an iframe of tab ${tabId}: ${err?.message}`);
    });
  }
  console.info(`[Dev Mode] interception on tab ${tabId} (${states.join('+')}):`, patterns.map(p => p.urlPattern).join(', ') || 'none');
}

// DEV/PREVIEW run with caches off. The declarativeNetRequest no-cache headers only reach the HTTP
// cache; the renderer's memory cache would still hand back assets fetched before the attach (the
// un-intercepted first load) without any request, so interception would never see them. DevTools'
// "Disable cache" (Network.setCacheDisabled, needs Network.enable) bypasses both for the session.
async function disableCache(tabId, sessionId) {
  try {
    await sendCommand(tabId, 'Network.enable', undefined, sessionId);
    await sendCommand(tabId, 'Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
  } catch (err) {
    if (!isForeignFrameError(err)) console.warn(`[Dev Mode] cannot disable the cache on tab ${tabId}${sessionId ? ' (iframe)' : ''}: ${err?.message}`);
  }
}

const attaching = new Map(); // tabId -> in-flight attach promise
const blockedTabs = new Map(); // tabId -> ids of other extensions whose frames keep Chrome from debugging the tab
const interruptedTabs = new Map(); // tabId -> { ids, count } sessions closed by another extension's frame since the last top-level navigation

// Chrome refuses an extension debugger on a tab that holds a frame of another extension (password
// managers, Grammarly… inject one next to text fields) and drops the session as soon as such a frame
// appears. Nothing here can override that: the user must turn that extension off for the site.
// webNavigation.getAllFrames hides other extensions' frames, so the page DOM is scanned instead
// (open shadow roots included); debugger targets of type "other" are the fallback.
async function foreignExtensionFrames(tabId) {
  const ids = new Set();
  const add = (url) => {
    try {
      const id = new URL(url).hostname;
      if (id && id !== chrome.runtime.id) ids.add(id);
    } catch { /* ignore */ }
  };
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const out = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('iframe, frame, embed, object')) {
          const src = el.src || el.data || '';
          if (src.startsWith('chrome-extension://')) out.push(src);
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return out;
    }
  }).catch(() => []);
  for (const r of results || []) for (const src of r.result || []) add(src);
  if (!ids.size) {
    const targets = await chrome.debugger.getTargets().catch(() => []);
    for (const t of targets) if (t.type === 'other' && t.url?.startsWith('chrome-extension://')) add(t.url);
  }
  return [...ids];
}

// ---- Frame guard (frame-guard.js): removes other extensions' frames from debugged tabs ----
// Registered on every http(s) page while any tab is in DEV/PREVIEW; a page asks the worker at start
// whether its tab is active (frameGuardStatus), and the worker pushes the activation when it attaches a tab.
const FRAME_GUARD_ID = 'frame-guard';
const LEGACY_FRAME_GUARD_NOW_ID = 'frame-guard-now'; // domain-matched registration of 1.5

async function syncFrameGuard() {
  const any = (await activeTabIds()).length > 0;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ids = existing.map(s => s.id);
    if (ids.includes(LEGACY_FRAME_GUARD_NOW_ID)) await chrome.scripting.unregisterContentScripts({ ids: [LEGACY_FRAME_GUARD_NOW_ID] });
    if (!any) {
      if (ids.includes(FRAME_GUARD_ID)) await chrome.scripting.unregisterContentScripts({ ids: [FRAME_GUARD_ID] });
      return;
    }
    if (!ids.includes(FRAME_GUARD_ID)) {
      await chrome.scripting.registerContentScripts([{ id: FRAME_GUARD_ID, js: ['frame-guard.js'], matches: ['http://*/*', 'https://*/*'], allFrames: true, runAt: 'document_start', persistAcrossSessions: false }]);
      console.info('[Dev Mode] frame guard on (other extensions\' frames are removed from debugged tabs)');
    }
  } catch (err) {
    console.warn(`[Dev Mode] frame guard registration failed: ${err?.message}`);
  }
}

function activateFrameGuard(tabId) {
  chrome.tabs.sendMessage(tabId, { action: 'frameGuard', active: true }).catch(() => {});
}

// Remove other extensions' frames from every frame of the tab right now (same rule as the guard)
async function sweepForeignFrames(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (own) => {
      let n = 0;
      const walk = (root) => {
        for (const el of root.querySelectorAll('iframe, frame, embed, object')) {
          const src = el.getAttribute('src') || el.getAttribute('data') || '';
          if (src.startsWith('chrome-extension://') && !src.startsWith(own)) { el.remove(); n++; }
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return n;
    },
    args: [`chrome-extension://${chrome.runtime.id}/`]
  }).catch(() => {});
}

// Chrome closed the session because a foreign frame committed: remove it and attach again, quickly
// (requests made meanwhile are not intercepted). Bounded per page load, see attachRetries.
const attachRetries = new Map(); // tabId -> retries since the last top-level navigation
function retryAttach(tabId) {
  const n = attachRetries.get(tabId) || 0;
  if (n >= 5) return;
  attachRetries.set(tabId, n + 1);
  setTimeout(async () => {
    await sweepForeignFrames(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) await syncTab(tabId, tab.url);
    if (attachedTabs.has(tabId)) {
      console.warn(`[Dev Mode] tab ${tabId} attached again after another extension's frame closed the session; requests made in between were not intercepted — reload the page if it misbehaves`);
    }
  }, 150);
}

async function reportBlockedTab(tabId, reason) {
  const ids = await foreignExtensionFrames(tabId);
  const known = blockedTabs.get(tabId) || [];
  blockedTabs.set(tabId, ids);
  if (ids.length && ids.join() === known.join()) return;
  if (ids.length) {
    console.warn(`[Dev Mode] cannot debug tab ${tabId} (${reason}): it contains a frame from another extension (${ids.join(', ')}). Chrome forbids debugging such tabs; disable that extension for this site (chrome://extensions → its Details → Site access) and reload.`);
  } else {
    console.warn(`[Dev Mode] cannot debug tab ${tabId}: ${reason}`);
  }
}

// Attach + enable interception. `reloadAfter`: the call comes from a navigation whose document
// request may already be in flight, so reload once when this call performed a new attach.
// OFF is re-checked after every await: a mode switch that lands mid-attach must win, otherwise the
// tab would stay attached (debugging bar, interception) although the popup shows Off.
async function attachTab(tabId, states, { reloadAfter = false } = {}) {
  if (!states.length) return detachTab(tabId);
  if (attachedTabs.has(tabId)) {
    try {
      await enableInterception(tabId, states);
      await installFrameGlobals(tabId);
      return;
    } catch (err) {
      if (isIneligibleError(err)) return detachTab(tabId);
      // Session is gone (worker restart, DevTools took over…) — attach again below
      attachedTabs.delete(tabId);
    }
  }
  if (userDetachedTabs.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);

  const job = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
      console.info(`[Dev Mode] attached tab ${tabId} (${states.join('+')})`);
    } catch (err) {
      // Already attached by us in a previous worker life, or not attachable (chrome://, another debugger)
      if (!/already attached/i.test(err?.message || '')) {
        if (/chrome-extension/i.test(err?.message || '')) await reportBlockedTab(tabId, err.message);
        else console.warn(`[Dev Mode] cannot attach tab ${tabId}: ${err?.message}`);
        return;
      }
      console.info(`[Dev Mode] tab ${tabId} already attached, reusing session`);
    }
    blockedTabs.delete(tabId);
    attachedTabs.add(tabId);
    activateFrameGuard(tabId);
    updateKeepAlive();
    try {
      await enableInterception(tabId, states);
    } catch (err) {
      if (isIneligibleError(err)) {
        console.info(`[Dev Mode] tab ${tabId} switched to OFF or left the foreground during attach, detaching`);
        // Not detachTab: this job is the in-flight attach it would wait for
        await forceDetach(tabId);
        return;
      }
      console.warn(`[Dev Mode] Fetch.enable failed on tab ${tabId}: ${err?.message}`);
      attachedTabs.delete(tabId);
      updateKeepAlive();
      return;
    }
    await disableCache(tabId);
    await installFrameGlobals(tabId);
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
// but the debugger session is not, so it must not be the only source of truth.
// Detaching the root session also drops its auto-attached child sessions.
async function forceDetach(tabId) {
  const known = attachedTabs.has(tabId);
  forgetTab(tabId);
  try {
    await chrome.debugger.detach({ tabId });
    console.info(`[Dev Mode] detached tab ${tabId}`);
  } catch (err) {
    if (known) console.warn(`[Dev Mode] detach tab ${tabId} failed: ${err?.message}`);
  }
}

// Detach after any attach still in flight for the tab, so a detach requested during an attach is
// not overtaken by it (Chrome would otherwise keep the session the attach opens)
async function detachTab(tabId) {
  if (attaching.has(tabId)) await attaching.get(tabId).catch(() => {});
  await forceDetach(tabId);
}

// A new iframe target (cross-site frame) was auto-attached: give it the tab's patterns and globals,
// then let it run. It is paused until Runtime.runIfWaitingForDebugger, so that call always happens.
async function onTargetAttached(tabId, params) {
  const { sessionId, targetInfo, waitingForDebugger } = params;
  const resume = () => (waitingForDebugger
    ? sendCommand(tabId, 'Runtime.runIfWaitingForDebugger', undefined, sessionId).catch(() => {})
    : Promise.resolve());
  if (targetInfo?.type !== 'iframe') return resume();

  // An iframe target of a tab that is OFF by now must not resurrect the tab's session
  const states = await tabStatesFor(tabId);
  if (!states.length) {
    await resume();
    detachTab(tabId);
    return;
  }
  childrenOf(tabId).add(sessionId);
  attachedTabs.add(tabId);
  updateKeepAlive();
  console.info(`[Dev Mode] attached iframe ${targetInfo.url || '(no url)'} in tab ${tabId}`);
  try {
    // Interception first (the frame is still paused), then the rest
    const patterns = tabPatterns.get(tabId) ?? await interceptPatterns(states);
    tabPatterns.set(tabId, patterns);
    await applyPatterns(tabId, patterns, sessionId);
    console.info(`[Dev Mode] interception on iframe of tab ${tabId}:`, patterns.map(p => p.urlPattern).join(', ') || 'none');
    // Nested cross-site iframes hang off this session
    await sendCommand(tabId, 'Target.setAutoAttach', AUTO_ATTACH, sessionId).catch(() => {});
    await disableCache(tabId, sessionId);
    await installFrameGlobals(tabId, sessionId);
  } catch (err) {
    console.warn(`[Dev Mode] iframe setup failed in tab ${tabId}: ${err?.message}`);
  } finally {
    await resume();
  }
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

// "Debug only the active tab": keep the debugger session only on the active tab of each window.
// Chrome's debugging bar is browser-wide, so this is the only way to make it disappear while an OFF
// tab is in front; the price is that a DEV/PREVIEW tab in the background is served from the real
// site until it is active again. On by default, no UI; hidden switch for debugging, lost when the
// browser quits: chrome.storage.session.set({ activeTabOnly: false }) from the worker console.
const ACTIVE_TAB_ONLY_KEY = 'activeTabOnly';
let activeTabOnlyCache = null;
const asActiveTabOnly = (value) => (value === undefined ? true : !!value);
async function activeTabOnly() {
  if (activeTabOnlyCache === null) {
    const stored = await chrome.storage.session.get(ACTIVE_TAB_ONLY_KEY).catch(() => ({}));
    activeTabOnlyCache = asActiveTabOnly(stored[ACTIVE_TAB_ONLY_KEY]);
  }
  return activeTabOnlyCache;
}

// States a tab needs interception for. The mode picked for the tab rules everything it loads:
// CDN assets and iframes of other domains. OFF on the tab means OFF inside its iframes too; under
// "active tab only" a background tab counts as OFF. Without `topUrl` the tab's pending URL wins over
// its current one: while a navigation is pending the tab still reports the previous page.
async function tabStatesFor(tabId, topUrl) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return [];
  if (topUrl === undefined) topUrl = tab.pendingUrl || tab.url;
  const state = await modeForTab(tabId, topUrl);
  if (state === STATES.OFF) return [];
  if ((await activeTabOnly()) && !tab.active) return [];
  return [state];
}

// Attach or detach a tab according to the mode of its top-level URL
async function syncTab(tabId, url, { reloadAfter = false } = {}) {
  const state = await modeForTab(tabId, url);
  const states = await tabStatesFor(tabId, url);
  if (!states.length) {
    // A DEV/PREVIEW page loading in a background tab ("active tab only") is not intercepted:
    // remember to reload it once it comes to the front
    if (state === STATES.OFF) pendingReload.delete(tabId);
    else if (reloadAfter) pendingReload.add(tabId);
    await detachTab(tabId);
    return;
  }
  await attachTab(tabId, states, { reloadAfter });
}

// Re-evaluate every open tab (worker start, settings change). Tabs that navigated while kept
// detached get their pending reload. Modes of tabs that no longer exist are dropped.
async function syncAllTabs() {
  const tabs = await chrome.tabs.query({});
  const open = new Set(tabs.map(t => t.id));
  for (const id of await activeTabIds()) if (!open.has(id)) await forgetTabMode(id);
  await Promise.all(tabs.map(tab => syncTab(tab.id, tab.url, { reloadAfter: pendingReload.delete(tab.id) })));
}

// The tab closed: its mode and the cookies only it held go away
async function forgetTabMode(tabId) {
  await setTabMode(tabId, STATES.OFF);
  scheduleSync();
  scheduleGlobalsSync();
}

// Worker startup: learn what Chrome still has attached, then reconcile every tab
let ready = null;
function ensureReady() {
  if (!ready) ready = loadAttachedTabs().then(syncAllTabs).catch(() => {});
  return ready;
}

// Mode for a paused request: the tab's (see tabStatesFor)
async function requestState(tabId) {
  return getTabMode(tabId);
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

// Chrome bug (seen in Chrome 155): while DevTools request interception is on (any Fetch.enable
// pattern, request or response stage), Chrome mishandles a fetch/XHR that a server redirects to
// another origin. Locally the redirected request goes out without its Origin header (so a CORS
// response is rejected: "Failed to fetch"); on the on24 SSO handoff (Zendesk widget:
// wccorionqa …?command=wccorionsso&action=redirect → 302 → wccqa …?token=…) it crashes Chrome's
// network service, which wipes every session cookie (JSESSIONID, wcc_admin…) and logs the user out.
// So the redirect never reaches Chrome: XHR/fetch responses are paused, and a 3xx to another origin
// is followed by the worker (with the browser's cookies, host permissions) and the request is
// fulfilled with the final response, plus the 3xx's own Set-Cookie headers.
function crossOriginLocation(params) {
  const status = params.responseStatusCode;
  if (!(status >= 300 && status < 400) || (params.resourceType !== 'XHR' && params.resourceType !== 'Fetch')) return null;
  const location = (params.responseHeaders || []).find(h => h.name.toLowerCase() === 'location')?.value;
  if (!location) return null;
  try {
    const target = new URL(location, params.request.url);
    return target.origin !== new URL(params.request.url).origin ? target.href : null;
  } catch {
    return null;
  }
}

// Request headers fetch() may not set (or that the worker's own request computes)
const UNFORWARDABLE_HEADER = /^(cookie2?|host|origin|referer|connection|content-length|content-type|accept-encoding|accept-charset|date|dnt|expect|keep-alive|te|trailer|transfer-encoding|upgrade|via|user-agent|priority|sec-|proxy-)/i;

async function followRedirectInWorker(finish, params, location, where) {
  const { request } = params;
  const headers = {};
  for (const [name, value] of Object.entries(request.headers || {})) if (!UNFORWARDABLE_HEADER.test(name)) headers[name] = value;
  // 307/308 keep the method and body; 301/302/303 turn into a GET
  const keep = params.responseStatusCode === 307 || params.responseStatusCode === 308;
  const method = keep ? request.method : (request.method === 'HEAD' ? 'HEAD' : 'GET');
  let res;
  try {
    res = await fetch(location, {
      method,
      headers,
      body: keep && method !== 'GET' && method !== 'HEAD' ? request.postData : undefined,
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store'
    });
  } catch (err) {
    console.warn(`[Dev Mode] cross-origin redirect to ${safeUrl(location)} failed in the worker (${err?.message}); letting Chrome follow it (${where})`);
    return finish('Fetch.continueResponse');
  }
  const body = toBase64(await res.arrayBuffer());
  const responseHeaders = [];
  // The body is already decoded and measured by fetch(); CORS headers are set below
  res.headers.forEach((value, name) => {
    if (!/^(content-encoding|content-length|transfer-encoding|access-control-|set-cookie)/i.test(name)) responseHeaders.push({ name, value });
  });
  // Cookies the redirecting server set on its 3xx (they belong to the request's own URL)
  for (const h of params.responseHeaders || []) if (h.name.toLowerCase() === 'set-cookie') responseHeaders.push(h);
  const origin = request.headers?.Origin || request.headers?.origin;
  if (origin) {
    responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: origin }, { name: 'Access-Control-Allow-Credentials', value: 'true' });
  }
  responseHeaders.push({ name: 'X-Dev-Mode', value: 'redirect-followed' });
  console.info(`[Dev Mode] ${params.resourceType} ${safeUrl(request.url)} ← ${params.responseStatusCode} to ${safeUrl(location)}: followed by the extension (${res.status}${res.redirected ? `, via ${safeUrl(res.url)}` : ''}) so Chrome does not handle a cross-origin redirect under interception (${where})`);
  return finish('Fetch.fulfillRequest', { responseCode: res.status, responseHeaders, body });
}

async function onRequestPaused(source, params) {
  const { tabId, sessionId } = source;
  const { requestId, request } = params;
  const finish = (method, extra = {}) =>
    sendCommand(tabId, method, { requestId, ...extra }, sessionId).catch(() => {});

  // Events can arrive right after a worker restart, before the attached set is rebuilt
  attachedTabs.add(tabId);
  updateKeepAlive();

  // Response stage: only XHR/fetch are subscribed (REDIRECT_PATTERNS)
  if (params.responseStatusCode !== undefined || params.responseErrorReason) {
    const location = !params.responseErrorReason && crossOriginLocation(params);
    if (location && (await requestState(tabId)) !== STATES.OFF) {
      return followRedirectInWorker(finish, params, location, `tab ${tabId}${sessionId ? ', iframe' : ''}`);
    }
    return finish('Fetch.continueResponse');
  }

  try {
    const isDocument = params.resourceType === 'Document';
    const state = await requestState(tabId);
    const settings = await getSettings();
    if (state === STATES.OFF) {
      // An OFF tab must browse as if the extension were not installed: pass the request through
      // untouched and end the debugger session that is still delivering events
      await finish('Fetch.continueRequest');
      detachTab(tabId);
      return;
    }

    const rewritten = applyRewrites(request.url, settings, state);
    const hit = mapLocalTarget(rewritten, settings, state);
    const local = hit?.url || null;
    if (isDocument || local || rewritten !== request.url) {
      console.info(`[Dev Mode] ${params.resourceType} ${safeUrl(request.url)} (${state}${sessionId ? ', iframe' : ''}) → ${local || (rewritten !== request.url ? safeUrl(rewritten) : 'real site')}`);
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
        console.warn(`[Dev Mode] No local file ${local}; serving ${safeUrl(request.url)} from the real site.`);
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

// ---- Network trace (Activity log): why a debugged tab lands on a login page ----
// Documents always; XHR/fetch only when a cookie was blocked or the answer is 401/403 or a redirect.
// Only cookie *names* and URL paths with parameter names are logged: values are tokens.
const TRACED_TYPES = new Set(['Document', 'XHR', 'Fetch']);
const netRequests = new Map(); // `${sessionId}:${requestId}` -> { type, url, pending: [] }

function safeUrl(url) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.keys()];
    return `${u.origin}${u.pathname}${params.length ? `?${params.join('&')}` : ''}`;
  } catch {
    return String(url).split('?')[0];
  }
}

const cookieNameOf = (c) => c.cookie?.name || String(c.cookieLine || '').split('=')[0].trim() || '?';
const headerOf = (headers, name) => {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return v;
  return undefined;
};

function netEntry(source, requestId) {
  const key = `${source.sessionId || ''}:${requestId}`;
  let entry = netRequests.get(key);
  if (!entry) {
    netRequests.set(key, entry = { type: null, url: null, pending: [] });
    if (netRequests.size > 500) netRequests.delete(netRequests.keys().next().value);
  }
  return entry;
}

// Set-Cookie header (one cookie per line) -> ['name', 'name (deleted)']: a server ending a session
// answers with an expired copy of its cookie
function setCookieNames(headers) {
  const raw = headerOf(headers, 'set-cookie');
  if (!raw) return [];
  return String(raw).split('\n').filter(Boolean).map(line => {
    const name = line.split('=')[0].trim();
    const attrs = line.split(';').slice(1).map(a => a.trim().toLowerCase());
    const maxAge = attrs.find(a => a.startsWith('max-age='));
    const expires = attrs.find(a => a.startsWith('expires='));
    const deleted = (maxAge && Number(maxAge.slice(8)) <= 0) || (expires && Date.parse(expires.slice(8)) < Date.now());
    return deleted ? `${name} (deleted)` : name;
  });
}

// Who started a document navigation: the script (URL:line) that sent the page elsewhere, or the browser
function initiatorOf(initiator) {
  if (!initiator) return '';
  const frame = initiator.stack?.callFrames?.[0];
  if (frame) return ` · initiated by script ${safeUrl(frame.url)}:${frame.lineNumber + 1}`;
  if (initiator.url) return ` · initiated by ${initiator.type} ${safeUrl(initiator.url)}${initiator.lineNumber != null ? `:${initiator.lineNumber + 1}` : ''}`;
  return initiator.type && initiator.type !== 'other' ? ` · initiated by ${initiator.type}` : '';
}

function traceNetwork(source, method, params) {
  const where = `tab ${source.tabId}${source.sessionId ? ', iframe' : ''}`;
  const entry = netEntry(source, params.requestId);
  // Extra-info events may arrive before requestWillBeSent: keep them until the type is known
  const emit = (fn) => (entry.type ? fn() : entry.pending.push(fn));

  if (method === 'Network.requestWillBeSent') {
    entry.type = params.type || entry.type || 'Other';
    entry.url = params.request?.url;
    if (TRACED_TYPES.has(entry.type)) {
      if (params.redirectResponse) {
        console.info(`[Dev Mode] net ${entry.type} redirect ${params.redirectResponse.status} → ${safeUrl(entry.url)} (${where})`);
      } else if (entry.type === 'Document') {
        console.info(`[Dev Mode] net ${entry.type} ${params.request?.method} ${safeUrl(entry.url)}${initiatorOf(params.initiator)} (${where})`);
      }
    }
    const pending = entry.pending.splice(0);
    pending.forEach(fn => fn());
    return;
  }

  if (method === 'Network.requestWillBeSentExtraInfo') {
    emit(() => {
      if (!TRACED_TYPES.has(entry.type)) return;
      const cookies = params.associatedCookies || [];
      // Kept for the response line: a 401/403 repeats what the request carried
      entry.sent = cookies.filter(c => !c.blockedReasons?.length).map(cookieNameOf);
      // Cookies of other hosts/paths are listed as blocked on every request: not worth reporting
      const blockedFor = (c) => (c.blockedReasons || []).filter(r => r !== 'DomainMismatch' && r !== 'NotOnPath');
      entry.blocked = cookies.filter(c => blockedFor(c).length).map(c => `${cookieNameOf(c)} (${blockedFor(c).join('/')})`);
      entry.headerNames = Object.keys(params.headers || {}).map(h => h.toLowerCase()).filter(h => !h.startsWith(':'));
      // The DEV cookie is appended by a DNR rule, so it shows in the Cookie header, not in associatedCookies
      entry.devCookie = String(headerOf(params.headers, 'cookie') || '').split(';').some(c => c.split('=')[0].trim() === COOKIE_NAME);
      if (entry.type !== 'Document' && !entry.blocked.length) return;
      console.info(`[Dev Mode] net ${entry.type} ${safeUrl(entry.url)}${entry.blocked.length ? ` · BLOCKED: ${entry.blocked.join(', ')} ·` : ''} cookies sent (${entry.sent.length}): ${entry.sent.join(', ') || 'none'}${entry.devCookie ? ` + ${COOKIE_NAME} (tab rule)` : ''} (${where})`);
    });
    return;
  }

  if (method === 'Network.responseReceivedExtraInfo') {
    emit(() => {
      if (!TRACED_TYPES.has(entry.type)) return;
      const status = params.statusCode;
      const denied = status === 401 || status === 403;
      const location = headerOf(params.headers, 'location');
      const setCookies = setCookieNames(params.headers);
      const blocked = (params.blockedCookies || []).map(c => `${cookieNameOf(c)} (${(c.blockedReasons || []).join('/')})`);
      const notable = entry.type === 'Document' || denied || blocked.length || setCookies.length || (status >= 300 && status < 400);
      if (!notable) return;
      let line = `[Dev Mode] net ${entry.type} ${safeUrl(entry.url)} ← ${status}`;
      if (location) {
        try { line += ` Location: ${safeUrl(new URL(location, entry.url).href)}`; } catch { line += ' Location: (unparsable)'; }
      }
      if (blocked.length) line += ` · Set-Cookie BLOCKED: ${blocked.join(', ')}`;
      if (setCookies.length) line += ` · Set-Cookie: ${setCookies.join(', ')}`;
      if (denied && entry.sent) {
        line += ` · request carried ${entry.sent.length} cookies (${COOKIE_NAME} ${entry.devCookie ? 'yes' : 'no'})`;
        if (entry.blocked?.length) line += `, BLOCKED: ${entry.blocked.join(', ')}`;
        line += ` · headers: ${(entry.headerNames || []).join(', ')} · cookies: ${entry.sent.join(', ')}`;
      }
      console[denied || blocked.length || setCookies.some(n => n.endsWith('(deleted)')) ? 'warn' : 'info'](`${line} (${where})`);
    });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  // Child sessions outlive the worker like the root one: learn them back from their events
  if (source.sessionId) childrenOf(tabId).add(source.sessionId);
  if (method.startsWith('Network.')) {
    try { traceNetwork(source, method, params); } catch (err) { console.warn(`[Dev Mode] network trace failed: ${err?.message}`); }
    return;
  }
  switch (method) {
    case 'Fetch.requestPaused':
      onRequestPaused(source, params);
      break;
    case 'Target.attachedToTarget':
      onTargetAttached(tabId, params);
      break;
    case 'Target.detachedFromTarget':
      childrenOf(tabId).delete(params.sessionId);
      frameGlobalsScripts.delete(`${tabId}/${params.sessionId}`);
      break;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  console.info(`[Dev Mode] Chrome detached tab ${source.tabId}: ${reason}`);
  forgetTab(source.tabId);
  // User clicked "Cancel" on the debugging bar: leave the tab alone until it navigates again
  if (reason === 'canceled_by_user') userDetachedTabs.add(source.tabId);
  // Chrome closes the session when a frame of another extension shows up in the tab
  if (reason === 'target_closed') {
    const tabId = source.tabId;
    chrome.tabs.get(tabId)
      .then(() => reportBlockedTab(tabId, 'session closed by Chrome'))
      .then(() => {
        const ids = blockedTabs.get(tabId) || [];
        const prev = interruptedTabs.get(tabId);
        interruptedTabs.set(tabId, { ids: ids.length ? ids : (prev?.ids || []), count: (prev?.count || 0) + 1 });
        return retryAttach(tabId);
      })
      .catch(() => {});
  }
});

// ---- declarativeNetRequest: no-cache headers for tabs in DEV/PREVIEW, DEV cookie per DEV tab ----
// Session rules (memory only) scoped by tab id: the tab's mode rules everything it loads.

let dynamicRulesCleared = false;

async function syncRules() {
  // 1.5 kept per-domain dynamic rules (persisted): drop them once
  if (!dynamicRulesCleared) {
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    if (old.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map(r => r.id) });
    dynamicRulesCleared = true;
  }
  await loadTabStore();
  const tabIds = [...tabModes].filter(([, state]) => !STATE_CONFIG[state].cache).map(([tabId]) => tabId);
  const rules = [];
  if (tabIds.length) rules.push({
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Cache-Control', operation: 'set', value: 'no-cache, no-store, must-revalidate' },
        { header: 'Pragma', operation: 'set', value: 'no-cache' }
      ]
    },
    condition: { tabIds, resourceTypes: ALL_RESOURCE_TYPES }
  });
  // DEV cookie (id 2), never written to Chrome's cookie jar: the jar is shared by every tab, so a new
  // tab on the same site would be served in DEV too. The rule appends it to the Cookie header of every
  // request of the DEV tabs (iframes and other sites included: the tab's mode rules everything it
  // loads). No domain list: rules are applied before the debugger pauses a request, so a domain
  // learned from a paused document would come too late for that document. Only the server reads the
  // cookie; page JS never sees it, and requests without a tab (service workers, the worker's own
  // followRedirectInWorker fetch) don't carry it.
  const devTabIds = [...tabModes].filter(([, state]) => STATE_CONFIG[state].cookie).map(([tabId]) => tabId);
  if (devTabIds.length) rules.push({
    id: 2,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'append', value: `${COOKIE_NAME}=${COOKIE_VALUE}` }]
    },
    condition: { tabIds: devTabIds, resourceTypes: ALL_RESOURCE_TYPES }
  });

  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map(r => r.id),
    addRules: rules
  });
}

let syncQueue = Promise.resolve();
function scheduleSync() {
  syncQueue = syncQueue.then(syncRules).catch(err => console.error('[Dev Mode] syncRules failed', err));
  return syncQueue;
}

// ---- Globals injection ----
// Injected in DEV and PREVIEW tabs only (variables are kept but not injected in OFF), through the
// debugger: Page.addScriptToEvaluateOnNewDocument on every attached session (tab root + auto-attached
// iframe targets), so it follows the tab's mode and reaches about:blank / srcdoc / blob: and
// cross-site iframes too. chrome.userScripts is not used: its registrations are per domain, not per tab.

const frameGlobalsScripts = new Map(); // 'tabId' | 'tabId/sessionId' -> Page script identifier
let frameGlobalsSource; // undefined = not built yet, null = nothing to inject

// Every domain's list goes in: the snippet injects the list of each frame's domain. It only exists on
// sessions of DEV/PREVIEW tabs, so the tab's mode decides
async function getFrameGlobalsSource() {
  if (frameGlobalsSource !== undefined) return frameGlobalsSource;
  const { globals: all } = await getConfig();
  const byDomain = {};
  for (const [rawDomain, list] of Object.entries(all)) {
    if (!Array.isArray(list) || !list.length) continue;
    const vars = parseGlobalVars(list);
    if (Object.keys(vars).length) byDomain[rawDomain.startsWith('.') ? rawDomain : `.${rawDomain}`] = vars;
  }
  frameGlobalsSource = Object.keys(byDomain).length ? buildFrameGlobalsCode(byDomain) : null;
  return frameGlobalsSource;
}

// (Re)install the frame globals script on one session (root when sessionId is undefined).
// Idempotent, and the new script is added before the old one is removed: syncs run concurrently
// with reloads, and a gap between remove and add would leave the frames created meanwhile without globals.
async function installFrameGlobals(tabId, sessionId) {
  const key = sessionId ? `${tabId}/${sessionId}` : String(tabId);
  try {
    const source = await getFrameGlobalsSource();
    const previous = frameGlobalsScripts.get(key);
    if (previous?.source === source) return;
    if (source) {
      // The script only runs while the Page domain is enabled on that session
      await sendCommand(tabId, 'Page.enable', undefined, sessionId);
      const { identifier } = await sendCommand(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, sessionId);
      frameGlobalsScripts.set(key, { identifier, source });
    } else {
      frameGlobalsScripts.delete(key);
    }
    if (previous) {
      await sendCommand(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: previous.identifier }, sessionId).catch(() => {});
    }
  } catch (err) {
    // An iframe session that vanished before its Target.detachedFromTarget arrived
    if (sessionId && /session with given id not found/i.test(err?.message || '')) {
      childrenOf(tabId).delete(sessionId);
      frameGlobalsScripts.delete(key);
      return;
    }
    if (!isForeignFrameError(err)) console.warn(`[Dev Mode] globals script failed on tab ${tabId}${sessionId ? ' (iframe)' : ''}: ${err?.message}`);
  }
}

// Globals or modes changed: rebuild the script and push it to every attached session
async function refreshFrameGlobals() {
  frameGlobalsSource = undefined;
  const jobs = [];
  for (const tabId of attachedTabs) {
    jobs.push(installFrameGlobals(tabId));
    for (const sessionId of childrenOf(tabId)) jobs.push(installFrameGlobals(tabId, sessionId));
  }
  await Promise.all(jobs);
}

async function syncGlobals() {
  await syncFrameGuard();
  await refreshFrameGlobals();
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

// Get active tab's mode and update icon
async function updateIconForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  updateIcon(await modeForTab(tab.id, tab.url), tab.id);
}

// Handle mode change from popup: the mode belongs to the active tab, for its life only
async function setState(newState) {
  const normalizedState = normalizeState(newState);
  if (!STATE_CONFIG[normalizedState]) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isActionableUrl(tab?.url)) return;

  console.info(`[Dev Mode] setState tab ${tab.id} (${safeUrl(tab.url)}) → ${normalizedState}`);
  await setTabMode(tab.id, normalizedState);
  // The tab's DEV cookie rule and no-cache rule are in place before the reload below
  await scheduleSync();
  await scheduleGlobalsSync();
  userDetachedTabs.delete(tab.id);
  pendingReload.delete(tab.id);
  await ensureReady();
  await syncTab(tab.id, tab.url);
  updateIcon(normalizedState, tab.id);
  console.info(`[Dev Mode] reloading tab ${tab.id} for ${normalizedState}`);
  chrome.tabs.reload(tab.id).catch(err => console.warn(`[Dev Mode] reload of tab ${tab.id} failed: ${err?.message}`));
}

// Message handler
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.action === 'setState') {
    setState(msg.state)
      .then(() => respond({ success: true }))
      .catch(err => {
        console.error(`[Dev Mode] setState ${msg.state} failed: ${err?.message}`, err?.stack || '');
        respond({ success: false, error: err?.message });
      });
    return true;
  }
  if (msg.action === 'getState') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      const domain = isActionableUrl(tab?.url) ? extractDomain(tab.url) : null;
      const state = await modeForTab(tab?.id, tab?.url);
      if (typeof msg.prefersDark === 'boolean' && msg.prefersDark !== prefersDark) {
        prefersDark = msg.prefersDark;
        if (tab) updateIcon(state, tab.id);
      }
      respond({
        state,
        domain,
        blockedBy: (tab && blockedTabs.get(tab.id)) || [],
        interrupted: (tab && interruptedTabs.get(tab.id)) || null,
        usesMapLocal: await usesMapLocal(state),
        fileAccess: await fileAccessAllowed(),
        globals: domain ? await getGlobals(domain) : []
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
  if (msg.action === 'frameGuardStatus') {
    const tab = _sender.tab;
    if (!tab) { respond({ active: false }); return false; }
    tabStatesFor(tab.id, tab.url).then(states => respond({ active: states.length > 0 })).catch(() => respond({ active: false }));
    return true;
  }
  if (msg.action === 'getActivityLog') {
    (async () => {
      const tabs = await chrome.tabs.query({}).catch(() => []);
      const urlOf = Object.fromEntries(tabs.map(t => [t.id, t.url || '']));
      // What Chrome itself reports as attached, independent of the in-memory set
      const chromeAttached = (await chrome.debugger.getTargets().catch(() => []))
        .filter(t => t.attached)
        .map(t => ({ tabId: t.tabId ?? null, type: t.type, url: t.url || "" }));
      respond({
        log: activityLog,
        version: chrome.runtime.getManifest().version,
        activeTabOnly: await activeTabOnly(),
        chromeAttached,
        modes: (await activeTabIds()).map(id => ({ id, mode: tabModes.get(id), url: urlOf[id] || '(closed)' })),
        fileAccess: await fileAccessAllowed(),
        blocked: [...blockedTabs.entries()].filter(([, ids]) => ids.length).map(([id, ids]) => ({ id, url: urlOf[id] || '(closed)', extensions: ids })),
        tabs: [...attachedTabs].map(id => ({
          id,
          url: urlOf[id] || '(closed)',
          iframes: childrenOf(id).size,
          patterns: (tabPatterns.get(id) || []).map(p => (p.resourceType ? `${p.urlPattern} [${p.resourceType}]` : p.urlPattern))
        }))
      });
    })();
    return true;
  }
});

// Rules and globals live in 'sync', which fires for edits made here as well as for changes arriving
// from another machine through Chrome sync. Modes are per tab and in memory, never in storage.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[ACTIVE_TAB_ONLY_KEY]) {
    activeTabOnlyCache = asActiveTabOnly(changes[ACTIVE_TAB_ONLY_KEY].newValue);
    console.info(`[Dev Mode] debug only the active tab: ${activeTabOnlyCache ? 'on' : 'off'}`);
    ensureReady().then(syncAllTabs);
  }
  if (area !== 'sync') return;
  invalidateConfig();
  const keys = Object.keys(changes);
  if (keys.some(DevModeConfig.isRuleKey)) ensureReady().then(syncAllTabs);
  if (keys.some(DevModeConfig.isGlobalsKey)) scheduleGlobalsSync();
});

// Apply the tab's mode at multiple points to ensure the cookie is set before the request goes out.
// The mode stays with the tab whatever it navigates to; OFF tabs are left alone.

// 1. Before navigation starts (earliest possible)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0 || !isActionableUrl(details.url)) return;

  // A fresh top-level navigation ends a user-cancelled debugging session's grace period
  userDetachedTabs.delete(details.tabId);
  attachRetries.delete(details.tabId);
  interruptedTabs.delete(details.tabId);
  const state = await getTabMode(details.tabId);
  if (state === STATES.OFF) return;
  ensureReady().then(() => syncTab(details.tabId, details.url, { reloadAfter: true }));
});

// 2. When tab URL changes
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  if (!isActionableUrl(changeInfo.url)) {
    detachTab(tabId);
    if (tab.active) updateIcon(STATES.OFF, tabId);
    return;
  }

  const state = await getTabMode(tabId);
  if (tab.active) updateIcon(state, tabId);
  if (state === STATES.OFF) return;
  await ensureReady();
  await syncTab(tabId, changeInfo.url, { reloadAfter: true });
});

// 3. When navigation commits (ensures config is applied)
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0 || !isActionableUrl(details.url)) return;

  const state = await getTabMode(details.tabId);
  updateIcon(state, details.tabId);
  if (state === STATES.OFF) return;

  // An attach refused while the previous document held another extension's frame: the new
  // document starts without it, so attach now and reload once to intercept it
  if (!attachedTabs.has(details.tabId) && blockedTabs.has(details.tabId)) {
    ensureReady().then(() => syncTab(details.tabId, details.url, { reloadAfter: true }));
  }
});

// Closing a tab ends its mode: nothing about it is kept
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  pendingReload.delete(tabId);
  userDetachedTabs.delete(tabId);
  blockedTabs.delete(tabId);
  interruptedTabs.delete(tabId);
  attachRetries.delete(tabId);
  forgetTabMode(tabId).catch(() => {});
});

// Prerender / instant navigation swaps the tab for a new one: the mode follows the visible tab
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await loadTabStore();
  const state = tabModes.get(removedTabId);
  if (!state) return;
  tabModes.delete(removedTabId);
  tabModes.set(addedTabId, state);
  persistTabStore();
  forgetTab(removedTabId);
  scheduleSync();
  const tab = await chrome.tabs.get(addedTabId).catch(() => null);
  if (tab) await ensureReady().then(() => syncTab(addedTabId, tab.url, { reloadAfter: true }));
});

// Tab switch: icon, and under "active tab only" move the debugger session to the tab now in front.
// Chrome's activeInfo has no previousTabId (Firefox only), so every tab of the window is re-checked:
// the background ones detach, the active one attaches (reloaded if it navigated while detached).
chrome.tabs.onActivated.addListener(async ({ windowId }) => {
  updateIconForActiveTab();
  if (!(await activeTabOnly())) return;
  await ensureReady();
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  await Promise.all(tabs.map(tab =>
    syncTab(tab.id, tab.pendingUrl || tab.url, { reloadAfter: tab.active && pendingReload.delete(tab.id) }).catch(() => {})
  ));
});

// Initialize
function init() {
  removeAllDevCookies();
  activeTabOnly().then(on => console.info(`[Dev Mode] worker started v${chrome.runtime.getManifest().version}, debug only the active tab: ${on ? "on" : "off"}`));
  updateIconForActiveTab();
  scheduleSync();
  scheduleGlobalsSync();
  ensureReady();
}

// Browser start or install/update/reload: chrome.storage.session is empty, every tab is OFF, so no
// cookie or persisted leftover of an earlier version may stay behind
async function freshStart() {
  await chrome.storage.local.remove(LEGACY_LOCAL_KEYS).catch(() => {});
  await removeAllDevCookies();
}
chrome.runtime.onInstalled.addListener(() => {
  migrateLocalConfig().catch(err => console.error('[Dev Mode] migration failed', err))
    .then(freshStart).then(init);
});
chrome.runtime.onStartup.addListener(() => {
  freshStart().then(init);
});
init();
