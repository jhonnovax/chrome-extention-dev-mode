// Constants
const COOKIE_NAME = 'htm-dev-mode';
const COOKIE_VALUE = '4815162342';
const CACHE_RULE_ID = 1;
const STORAGE_KEY = 'domainStates';
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 8888;

const PROXY_MODES = { SYSTEM: 'system', FIXED: 'fixed', DIRECT: 'direct' };
const STATES = { OFF: 'off', DEV: 'dev', PREVIEW: 'preview', PROD: 'prod' };
const LEGACY_STATE_MAP = { testing: STATES.OFF, prod_local: STATES.PREVIEW };

// badge*: exact popup badge CSS colors (light / dark variants)
const STATE_CONFIG = {
  [STATES.OFF]:     { color: '#94A3B8', label: 'OFF', badgeBgLight: 'rgba(158,158,158,0.15)', badgeTextLight: '#5f6368', badgeBgDark: 'rgba(158,158,158,0.20)', badgeTextDark: '#bdbdbd', title: 'Off',              cookie: false, proxy: PROXY_MODES.SYSTEM, cache: true },
  [STATES.DEV]:     { color: '#22C55E', label: 'DEV', badgeBgLight: 'rgba(0,200,83,0.15)',    badgeTextLight: '#00a344', badgeBgDark: 'rgba(0,200,83,0.20)',    badgeTextDark: '#69f0ae', title: 'Development Mode', cookie: true,  proxy: PROXY_MODES.FIXED,  cache: false },
  [STATES.PREVIEW]: { color: '#EAB308', label: 'PRE', badgeBgLight: 'rgba(234,179,8,0.18)',   badgeTextLight: '#a16207', badgeBgDark: 'rgba(234,179,8,0.24)',   badgeTextDark: '#facc15', title: 'Preview Mode',     cookie: false, proxy: PROXY_MODES.FIXED,  cache: false },
  [STATES.PROD]:    { color: '#EF4444', label: 'PRO', badgeBgLight: 'rgba(211,47,47,0.15)',   badgeTextLight: '#c62828', badgeBgDark: 'rgba(211,47,47,0.20)',   badgeTextDark: '#ef9a9a', title: 'Production Mode',  cookie: false, proxy: PROXY_MODES.DIRECT, cache: false }
};

function normalizeState(state) {
  const migratedState = LEGACY_STATE_MAP[state] || state;
  return STATE_CONFIG[migratedState] ? migratedState : STATES.OFF;
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

  // Badge chip — exact popup badge colors, composited by Chrome on the toolbar
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.26);
  ctx.fillStyle = badgeBg;
  ctx.fill();

  // Badge text label
  const fontSize = Math.round(size * 0.42);
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

// Update extension icon
function updateIcon(state) {
  const { title } = STATE_CONFIG[state];
  chrome.action.setIcon({ imageData: generateIcons(state) });
  chrome.action.setTitle({ title });
}

// Apply state configuration (cookie, proxy, cache)
async function applyConfig(state, url) {
  const normalizedState = normalizeState(state);
  const config = STATE_CONFIG[normalizedState];
  const domain = url ? extractDomain(url) : null;

  // Cookie
  if (domain) {
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

  // Proxy
  if (config.proxy === PROXY_MODES.FIXED) {
    await chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: { singleProxy: { host: PROXY_HOST, port: PROXY_PORT } }
      },
      scope: 'regular'
    });
  } else if (config.proxy === PROXY_MODES.DIRECT) {
    await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' });
  } else {
    // Condition OFF - Clear proxy settings
    await chrome.proxy.settings.clear({ scope: 'regular' });
  }

  // Cache
  if (config.cache) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [CACHE_RULE_ID] });
  } else {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [CACHE_RULE_ID],
      addRules: [{
        id: CACHE_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Cache-Control', operation: 'set', value: 'no-cache, no-store, must-revalidate' },
            { header: 'Pragma', operation: 'set', value: 'no-cache' }
          ]
        },
        condition: {
          urlFilter: '*',
          resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'xmlhttprequest', 'other']
        }
      }]
    });
  }
}

// Get active tab's state and update icon
async function updateIconForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (!isActionableUrl(tab.url)) {
    chrome.action.disable(tab.id);
    return;
  }

  chrome.action.enable(tab.id);
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
    await applyConfig(normalizedState, tab.url);
    updateIcon(normalizedState);
    chrome.tabs.reload(tab.id);
  }
}

// Message handler
chrome.runtime.onMessage.addListener((msg, _, respond) => {
  if (msg.action === 'setState') {
    setState(msg.state).then(() => respond({ success: true }));
    return true;
  }
  if (msg.action === 'getState') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (typeof msg.prefersDark === 'boolean' && msg.prefersDark !== prefersDark) {
        prefersDark = msg.prefersDark;
        const domain = tab?.url ? extractDomain(tab.url) : null;
        const state = domain ? await getState(domain) : STATES.OFF;
        if (isActionableUrl(tab?.url)) updateIcon(state);
      }
      const domain = tab?.url ? extractDomain(tab.url) : null;
      respond({ state: domain ? await getState(domain) : STATES.OFF });
    });
    return true;
  }
});

// Apply config at multiple points to ensure it's set before request goes out

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
    chrome.action.disable(_tabId);
    return;
  }

  chrome.action.enable(_tabId);
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
chrome.runtime.onInstalled.addListener(updateIconForActiveTab);
chrome.runtime.onStartup.addListener(updateIconForActiveTab);
updateIconForActiveTab();
