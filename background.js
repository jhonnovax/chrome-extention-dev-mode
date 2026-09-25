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

// ---- Activity log: the worker's own "[Dev Mode]" console lines, readable from the options page ----
// (the service worker console is hard to reach; the options page shows this buffer instead)
const ACTIVITY_MAX = 400;
const activityLog = [];
for (const level of ['info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[Dev Mode]')) {
      const text = args.map(a => (typeof a === 'string' ? a : (a?.message || safeJson(a)))).join(' ');
      activityLog.push({ at: Date.now(), level, text: text.slice(0, 600) });
      if (activityLog.length > ACTIVITY_MAX) activityLog.splice(0, activityLog.length - ACTIVITY_MAX);
    }
    original(...args);
  };
}
function safeJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

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

// domainStates, cached in memory (looked up for every intercepted request); invalidated on storage.onChanged
let statesCache = null;
function getStates() {
  if (!statesCache) {
    statesCache = chrome.storage.local.get(STORAGE_KEY).then(r => r[STORAGE_KEY] || {}).catch(() => ({}));
  }
  return statesCache;
}

function invalidateStates() {
  statesCache = null;
}

// Get state for a domain
async function getState(domain) {
  const states = await getStates();
  return normalizeState(states[domain]);
}

// Save state for a domain
async function saveState(domain, state) {
  const states = { ...(await getStates()) };
  states[domain] = normalizeState(state);
  await chrome.storage.local.set({ [STORAGE_KEY]: states });
  invalidateStates();
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

// User script for one domain, run in the page's MAIN world at document_start. In an iframe it only
// applies when the tab's top-level domain is active too (the tab's mode rules its frames).
function buildGlobalsCode(list, activeDomains = []) {
  return `(() => {
  const vars = ${JSON.stringify(parseGlobalVars(list))};
  const active = ${JSON.stringify(activeDomains)};
  if (window !== window.top) {
    let top = '';
    try { top = window.top.location.hostname; } catch (e) {}
    try { const a = location.ancestorOrigins; if (!top && a && a.length) top = new URL(a[a.length - 1]).hostname; } catch (e) {}
    if (top && !active.includes('.' + top.split('.').slice(-2).join('.'))) return;
  }${DEFINE_GLOBALS_JS}
})();`;
}

// Script for Page.addScriptToEvaluateOnNewDocument: runs in every document of an attached target,
// including about:blank / srcdoc / blob: iframes that user scripts cannot match, so it works out
// the frame's root domain itself: from its origin, else from the nearest same-origin ancestor
// (about:blank and srcdoc inherit the creator's origin), else from the referrer / embedding page.
// The frame's list is injected when the tab's top-level domain is in `activeDomains` (the tab's mode rules its frames).
function buildFrameGlobalsCode(byDomain, activeDomains) {
  return `(() => {
  const byDomain = ${JSON.stringify(byDomain)};
  const active = ${JSON.stringify(activeDomains)};
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
  const domain = domainOf(host);
  let topDomain = domain;
  try { topDomain = domainOf(hostOf(window.top.origin)) || topDomain; } catch (e) {}
  try { const a = location.ancestorOrigins; if (a && a.length) topDomain = domainOf(hostOf(a[a.length - 1])) || topDomain; } catch (e) {}
  const vars = byDomain[domain];
  if (!vars || !active.includes(topDomain)) return;${DEFINE_GLOBALS_JS}
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

// Site ("https://on24.com") of a URL, the form chrome.cookies partition keys use
function siteOf(url) {
  const domain = extractDomain(url);
  return domain ? `https://${domain.slice(1)}` : null;
}

// Apply state configuration (cookie). Network rules are handled by syncRules() / interception.
// `topLevelSite`: site of the tab's top-level page when `url` is a document embedded in it. A
// document of another site is a third party there, and Chrome's "block third-party cookies"
// setting withholds the plain cookie from it; a partitioned (CHIPS) copy keyed by the embedding
// site is still delivered, so both are set (and both removed when the mode has no cookie).
async function applyConfig(state, url, topLevelSite) {
  const config = STATE_CONFIG[normalizeState(state)];
  const domain = url ? extractDomain(url) : null;
  if (!domain) return;
  const partitionKey = topLevelSite && topLevelSite !== siteOf(url) ? { topLevelSite } : null;

  if (config.cookie) {
    const cookie = {
      url, domain,
      name: COOKIE_NAME,
      value: COOKIE_VALUE,
      path: '/',
      secure: true,
      sameSite: 'no_restriction',
      expirationDate: Math.floor(Date.now() / 1000) + 31536000
    };
    try {
      await chrome.cookies.set(cookie);
      if (partitionKey) await chrome.cookies.set({ ...cookie, partitionKey });
    } catch (err) {
      console.warn(`[Dev Mode] cannot set the ${COOKIE_NAME} cookie on ${domain}: ${err?.message}`);
    }
  } else {
    await chrome.cookies.remove({ url, name: COOKIE_NAME }).catch(() => {});
    await removePartitionedCookies(domain, siteOf(url));
  }
}

// Partitioned copies are invisible to the plain remove(): drop every one that belongs to `domain`
// (the domain went OFF) or that is keyed by `topLevelSite` (the embedding page went OFF, its iframes
// would otherwise keep the mode of the previous state)
async function removePartitionedCookies(domain, topLevelSite) {
  let all = [];
  try {
    all = await chrome.cookies.getAll({ name: COOKIE_NAME, partitionKey: {} });
  } catch { return; }
  for (const c of all) {
    if (!c.partitionKey?.topLevelSite) continue;
    const ownDomain = ('.' + c.domain.replace(/^\./, '')).endsWith(domain);
    if (!ownDomain && c.partitionKey.topLevelSite !== topLevelSite) continue;
    const url = `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
    await chrome.cookies.remove({ url, name: COOKIE_NAME, partitionKey: c.partitionKey }).catch(() => {});
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
const tabStates = new Map();       // tabId -> state of the top-level document (may be OFF)
const tabPatterns = new Map();     // tabId -> Fetch.enable patterns in force ([] = disabled)
const childSessions = new Map();   // tabId -> Set<sessionId> of auto-attached iframe targets
const userDetachedTabs = new Set();
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
  tabStates.delete(tabId);
  tabPatterns.delete(tabId);
  childSessions.delete(tabId);
  for (const key of frameGlobalsScripts.keys()) {
    if (key === String(tabId) || key.startsWith(`${tabId}/`)) frameGlobalsScripts.delete(key);
  }
  updateKeepAlive();
}

// Fetch.enable patterns for a set of states: raw globs of map-local rules; '*' when any rewrite
// applies. Documents (top and iframes) are always paused so the mode's cookie for their domain is
// in place before the request leaves, whatever the rules.
async function interceptPatterns(states) {
  if (!states.length) return [];
  const settings = await getSettings();
  const globs = new Set();
  for (const state of states) {
    if (enabledFor(settings.rewrites, state).some(e => e.regex)) {
      return [{ urlPattern: '*', requestStage: 'Request' }];
    }
    for (const e of enabledFor(settings.mapLocal, state)) if (e.pattern) globs.add(e.pattern);
  }
  return [
    { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
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

// Root session first (errors propagate), then every known child session
async function enableInterception(tabId, states) {
  const patterns = await interceptPatterns(states);
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
// Registered on every http(s) page while any mode is active; a page asks the worker at start
// whether its tab is active, and the worker pushes the activation when it attaches a tab.
// Two registrations: on pages (and frames) of domains in DEV/PREVIEW the guard starts synchronously
// at document_start (frame-guard-now.js first); everywhere else it asks the worker whether its tab
// is active (an on24 iframe inside an OFF page of another site attaches the tab later).
const FRAME_GUARD_ID = 'frame-guard';
const FRAME_GUARD_NOW_ID = 'frame-guard-now';

async function syncFrameGuard() {
  const states = await getStates();
  const domains = Object.keys(states).filter(d => normalizeState(states[d]) !== STATES.OFF).map(d => d.replace(/^\./, '')).filter(Boolean);
  const matches = domains.flatMap(d => [`*://*.${d}/*`, `*://${d}/*`]);
  const common = { allFrames: true, runAt: 'document_start', persistAcrossSessions: true };
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [FRAME_GUARD_ID, FRAME_GUARD_NOW_ID] });
    const ids = existing.map(s => s.id);
    if (!domains.length) {
      if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
      return;
    }
    const now = existing.find(s => s.id === FRAME_GUARD_NOW_ID);
    const sameMatches = now && JSON.stringify([...now.matches].sort()) === JSON.stringify([...matches].sort());
    if (!sameMatches) {
      if (now) await chrome.scripting.unregisterContentScripts({ ids: [FRAME_GUARD_NOW_ID] });
      await chrome.scripting.registerContentScripts([{ id: FRAME_GUARD_NOW_ID, js: ['frame-guard-now.js', 'frame-guard.js'], matches, ...common }]);
    }
    if (!ids.includes(FRAME_GUARD_ID)) {
      await chrome.scripting.registerContentScripts([{ id: FRAME_GUARD_ID, js: ['frame-guard.js'], matches: ['http://*/*', 'https://*/*'], ...common }]);
    }
    if (!sameMatches) console.info(`[Dev Mode] frame guard on: ${domains.join(', ')} (other extensions' frames are removed from debugged tabs)`);
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
async function attachTab(tabId, states, { reloadAfter = false } = {}) {
  if (attachedTabs.has(tabId)) {
    try {
      await enableInterception(tabId, states);
      await installFrameGlobals(tabId);
      return;
    } catch {
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
async function detachTab(tabId) {
  const known = attachedTabs.has(tabId);
  forgetTab(tabId);
  try {
    await chrome.debugger.detach({ tabId });
    console.info(`[Dev Mode] detached tab ${tabId}`);
  } catch (err) {
    if (known) console.warn(`[Dev Mode] detach tab ${tabId} failed: ${err?.message}`);
  }
}

// A new iframe target (cross-site frame) was auto-attached: give it the tab's patterns and globals,
// then let it run. It is paused until Runtime.runIfWaitingForDebugger, so that call always happens.
async function onTargetAttached(tabId, params) {
  const { sessionId, targetInfo, waitingForDebugger } = params;
  const resume = () => (waitingForDebugger
    ? sendCommand(tabId, 'Runtime.runIfWaitingForDebugger', undefined, sessionId).catch(() => {})
    : Promise.resolve());
  if (targetInfo?.type !== 'iframe') return resume();

  childrenOf(tabId).add(sessionId);
  attachedTabs.add(tabId);
  updateKeepAlive();
  console.info(`[Dev Mode] attached iframe ${targetInfo.url || '(no url)'} in tab ${tabId}`);
  try {
    // Interception first (the frame is still paused), then the rest
    const patterns = tabPatterns.get(tabId) ?? await interceptPatterns(await tabStatesFor(tabId));
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

// States a tab needs interception for. The mode picked for the tab's own (top-level) domain rules
// everything the tab loads: CDN assets and iframes of other domains, whatever their own mode.
// OFF on the tab means OFF inside its iframes too.
async function tabStatesFor(tabId, topUrl) {
  if (topUrl === undefined) topUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url;
  const state = await stateForUrl(topUrl);
  return state === STATES.OFF ? [] : [state];
}

// Attach or detach a tab according to the mode of its top-level URL
async function syncTab(tabId, url, { reloadAfter = false } = {}) {
  tabStates.set(tabId, await stateForUrl(url));
  const states = await tabStatesFor(tabId, url);
  if (!states.length) {
    await detachTab(tabId);
    return;
  }
  await attachTab(tabId, states, { reloadAfter });
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

// Mode for a paused request: the tab's (see tabStatesFor)
async function requestState(tabId) {
  let state = tabStates.get(tabId);
  if (!state) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    state = await stateForUrl(tab?.url);
    tabStates.set(tabId, state);
  }
  return state;
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

async function onRequestPaused(source, params) {
  const { tabId, sessionId } = source;
  const { requestId, request } = params;
  const finish = (method, extra = {}) =>
    sendCommand(tabId, method, { requestId, ...extra }, sessionId).catch(() => {});

  // Events can arrive right after a worker restart, before the attached set is rebuilt
  attachedTabs.add(tabId);
  updateKeepAlive();

  // Only request-stage events are subscribed; be safe if a response-stage one ever arrives
  if (params.responseStatusCode !== undefined || params.responseErrorReason) {
    return finish('Fetch.continueResponse');
  }

  try {
    const isDocument = params.resourceType === 'Document';
    const state = await requestState(tabId);
    const settings = await getSettings();
    if (state === STATES.OFF) return finish('Fetch.continueRequest');
    // The mode's cookie for the document's own domain, before the request leaves: cookies are added
    // by the network stack after interception, so an iframe from another domain (e.g. an on24 page
    // embedded in a DEV tab of another site) is served in the tab's mode too
    if (isDocument) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      await applyConfig(state, request.url, siteOf(tab?.url));
    }

    const rewritten = applyRewrites(request.url, settings, state);
    const hit = mapLocalTarget(rewritten, settings, state);
    const local = hit?.url || null;
    if (isDocument || local || rewritten !== request.url) {
      console.info(`[Dev Mode] ${params.resourceType} ${request.url} (${state}${sessionId ? ', iframe' : ''}) → ${local || (rewritten !== request.url ? rewritten : 'real site')}`);
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
  const tabId = source.tabId;
  if (tabId == null) return;
  // Child sessions outlive the worker like the root one: learn them back from their events
  if (source.sessionId) childrenOf(tabId).add(source.sessionId);
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

// ---- declarativeNetRequest: no-cache headers for domains with cache disabled ----

async function syncRules() {
  const states = await getStates();
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

// ---- Globals injection ----
// Two complementary paths, both injecting in DEV and PREVIEW only (variables are kept but not injected in OFF):
//  1. chrome.userScripts: one MAIN-world document_start script per domain, matched on the frame URL
//     (top pages and iframes whose URL is on the domain), independent of the debugger.
//  2. Page.addScriptToEvaluateOnNewDocument on every attached session (tab root + auto-attached
//     iframe targets): reaches about:blank / srcdoc / blob: iframes and cross-site iframes that the
//     user script cannot match. Both define the same locked accessors, so double injection is harmless.

const frameGlobalsScripts = new Map(); // 'tabId' | 'tabId/sessionId' -> Page script identifier
let frameGlobalsSource; // undefined = not built yet, null = nothing to inject

// Every domain's list goes in: the snippet injects a frame's list when the frame's domain or the
// tab's top-level domain is in DEV/PREVIEW (an iframe follows the mode of the tab it is loaded in)
async function getFrameGlobalsSource() {
  if (frameGlobalsSource !== undefined) return frameGlobalsSource;
  const { globals: all } = await getConfig();
  const states = await getStates();
  const byDomain = {};
  for (const [rawDomain, list] of Object.entries(all)) {
    if (!Array.isArray(list) || !list.length) continue;
    const vars = parseGlobalVars(list);
    if (Object.keys(vars).length) byDomain[rawDomain.startsWith('.') ? rawDomain : `.${rawDomain}`] = vars;
  }
  const active = Object.keys(states).filter(d => normalizeState(states[d]) !== STATES.OFF);
  frameGlobalsSource = Object.keys(byDomain).length && active.length ? buildFrameGlobalsCode(byDomain, active) : null;
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

let warnedUserScripts = false;

async function syncGlobals() {
  await syncFrameGuard();
  await refreshFrameGlobals();
  await syncUserScriptGlobals();
}

async function syncUserScriptGlobals() {
  if (!userScriptsAvailable()) {
    if (!warnedUserScripts) {
      warnedUserScripts = true;
      console.warn('[Dev Mode] chrome.userScripts unavailable: enable "Allow User Scripts" in the extension details to inject global variables.');
    }
    return;
  }
  warnedUserScripts = false;

  const { globals: all } = await getConfig();
  const states = await getStates();
  const activeDomains = Object.keys(states).filter(d => normalizeState(states[d]) !== STATES.OFF);
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
      js: [{ code: buildGlobalsCode(list, activeDomains) }],
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

// The tab's mode rules its iframes: when it drops the cookie (OFF/PREVIEW), drop the DEV cookie of
// the domains its iframes come from too, unless that domain is itself in DEV (its own tabs need it)
async function clearFrameCookies(tabId, tabDomain) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  const done = new Set([tabDomain]);
  for (const f of frames || []) {
    if (!isActionableUrl(f.url)) continue;
    const domain = extractDomain(f.url);
    if (!domain || done.has(domain)) continue;
    done.add(domain);
    if (STATE_CONFIG[await getState(domain)].cookie) continue;
    await chrome.cookies.remove({ url: f.url, name: COOKIE_NAME }).catch(() => {});
    await removePartitionedCookies(domain, null);
  }
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
    if (!STATE_CONFIG[normalizedState].cookie) await clearFrameCookies(tab.id, domain);
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
        blockedBy: (tab && blockedTabs.get(tab.id)) || [],
        interrupted: (tab && interruptedTabs.get(tab.id)) || null,
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
      respond({
        log: activityLog,
        states: await getStates(),
        fileAccess: await fileAccessAllowed(),
        userScripts: userScriptsAvailable(),
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

// Interception, no-cache rules and globals derive from storage: rebuild whenever it changes.
// 'local' holds the modes (domainStates); 'sync' holds rules and globals, and fires for edits made
// here as well as for changes arriving from another machine through Chrome sync.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    invalidateStates();
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
  const domain = extractDomain(details.url);
  if (!domain || details.frameId !== 0) return;

  // A fresh top-level navigation ends a user-cancelled debugging session's grace period
  userDetachedTabs.delete(details.tabId);
  attachRetries.delete(details.tabId);
  interruptedTabs.delete(details.tabId);
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

  // An attach refused while the previous document held another extension's frame: the new
  // document starts without it, so attach now and reload once to intercept it
  if (state !== STATES.OFF && !attachedTabs.has(details.tabId) && blockedTabs.has(details.tabId)) {
    ensureReady().then(() => syncTab(details.tabId, details.url, { reloadAfter: true }));
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id === details.tabId) updateIcon(state);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  userDetachedTabs.delete(tabId);
  blockedTabs.delete(tabId);
  interruptedTabs.delete(tabId);
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
