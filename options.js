const SETTINGS_KEY = 'settings';
const MODES = [
  { id: 'dev', label: 'DEV' },
  { id: 'preview', label: 'PREVIEW' }
];

const mapLocalList = document.getElementById('map-local-list');
const rewriteList = document.getElementById('rewrite-list');
const statusEl = document.getElementById('status');

let settings = { mapLocal: [], rewrites: [] };

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

// ---- rendering ----

function modesField(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'modes wide';
  wrap.innerHTML = '<span>Modes</span>';
  for (const mode of MODES) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = entry.modes?.includes(mode.id) ?? false;
    cb.addEventListener('change', () => {
      const set = new Set(entry.modes || []);
      cb.checked ? set.add(mode.id) : set.delete(mode.id);
      entry.modes = MODES.map(m => m.id).filter(id => set.has(id));
    });
    label.append(cb, mode.label);
    wrap.appendChild(label);
  }
  return wrap;
}

function textField(labelText, entry, key, { type = 'text', placeholder = '', wide = false, onInput } = {}) {
  const label = document.createElement('label');
  label.className = `field${wide ? ' wide' : ''}`;
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.placeholder = placeholder;
  input.value = entry[key] ?? '';
  input.dataset.key = key;
  input.addEventListener('input', () => {
    entry[key] = type === 'number' ? Number(input.value) : input.value;
    input.classList.remove('invalid');
    onInput?.();
  });
  label.appendChild(input);
  return label;
}

function cardShell(entry, list, rerender) {
  const card = document.createElement('div');
  card.className = `card${entry.enabled === false ? ' disabled' : ''}`;
  card.dataset.id = entry.id;

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'toggle';
  toggle.title = 'Enabled';
  toggle.checked = entry.enabled !== false;
  toggle.addEventListener('change', () => {
    entry.enabled = toggle.checked;
    card.classList.toggle('disabled', !toggle.checked);
  });

  const fields = document.createElement('div');
  fields.className = 'fields';

  const remove = document.createElement('button');
  remove.className = 'icon';
  remove.title = 'Remove rule';
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    list.splice(list.indexOf(entry), 1);
    rerender();
  });

  const error = document.createElement('div');
  error.className = 'error';

  card.append(toggle, fields, remove, error);
  return { card, fields, error };
}

const LOCAL_ORIGIN = 'http://127.0.0.1:4815';

// Latest /__health payload (null when the server is unreachable); refreshed on a timer
let serverHealth = null;
const healthListeners = new Set();

async function pollHealth() {
  try {
    const res = await fetch(`${LOCAL_ORIGIN}/__health`, { cache: 'no-store' });
    serverHealth = res.ok ? await res.json() : null;
  } catch {
    serverHealth = null;
  }
  healthListeners.forEach(fn => fn());
}

function renderServerBanner() {
  const banner = document.getElementById('server-banner');
  const dot = banner.querySelector('.dot');
  const text = banner.querySelector('.text');
  if (serverHealth) {
    const missing = settings.mapLocal.filter(e => {
      const mount = serverHealth.mounts?.[e.id];
      return e.enabled !== false && e.localPath && mount && !mount.exists;
    });
    dot.className = missing.length ? 'dot down' : 'dot ok';
    text.textContent = missing.length
      ? `Local server running on ${LOCAL_ORIGIN} — folder not found: ${missing.map(e => e.localPath).join(', ')}`
      : `Local server running on ${LOCAL_ORIGIN}`;
  } else {
    dot.className = 'dot down';
    text.textContent = `Local server not running — run "npm run install-service" once in the extension folder`;
  }
}

function renderMapLocal() {
  mapLocalList.textContent = '';
  healthListeners.clear();
  healthListeners.add(renderServerBanner);

  if (!settings.mapLocal.length) {
    mapLocalList.innerHTML = '<p class="empty">No map-local rules.</p>';
    return;
  }

  for (const entry of settings.mapLocal) {
    const { card, fields } = cardShell(entry, settings.mapLocal, renderMapLocal);
    fields.append(
      textField('URL pattern', entry, 'pattern', { placeholder: 'https://*/view/orion/*', wide: true }),
      textField('Local folder', entry, 'localPath', { placeholder: '/path/to/static', wide: true }),
      modesField(entry)
    );
    mapLocalList.appendChild(card);
  }
}

function renderRewrites() {
  rewriteList.textContent = '';

  if (!settings.rewrites.length) {
    rewriteList.innerHTML = '<p class="empty">No rewrite rules.</p>';
    return;
  }

  for (const entry of settings.rewrites) {
    const { card, fields } = cardShell(entry, settings.rewrites, renderRewrites);
    fields.append(
      textField('Regex', entry, 'regex', { placeholder: '/(.*)/dist/production-(css|js)-(.*).(css|js)(.*)', wide: true }),
      textField('Replacement', entry, 'replacement', { placeholder: '/$1/dist/production-$2.$4', wide: true }),
      modesField(entry)
    );
    rewriteList.appendChild(card);
  }
}

function renderAll() {
  renderMapLocal();
  renderRewrites();
}

// ---- validation & persistence ----

async function regexSupported(regex) {
  try {
    const r = await chrome.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: false });
    return r.isSupported ? null : (r.reason || 'unsupported');
  } catch (e) {
    return e.message;
  }
}

function markInvalid(card, key, message) {
  card.querySelector(`input[data-key="${key}"]`)?.classList.add('invalid');
  const err = card.querySelector('.error');
  err.textContent = err.textContent ? `${err.textContent} · ${message}` : message;
}

async function validate() {
  let ok = true;
  document.querySelectorAll('.card .error').forEach(e => { e.textContent = ''; });
  document.querySelectorAll('.card input.invalid').forEach(i => i.classList.remove('invalid'));

  for (const entry of settings.mapLocal) {
    const card = mapLocalList.querySelector(`[data-id="${entry.id}"]`);
    if (!entry.pattern?.trim()) { markInvalid(card, 'pattern', 'Pattern is required'); ok = false; }
    if (!entry.localPath?.trim()) { markInvalid(card, 'localPath', 'Local folder is required'); ok = false; }
    if (entry.localPath?.trim() && !entry.localPath.trim().startsWith('/')) { markInvalid(card, 'localPath', 'Use an absolute path'); ok = false; }
    if (!entry.modes?.length) { markInvalid(card, '', 'Select at least one mode'); ok = false; }
    if (entry.pattern?.trim()) {
      const regex = '^' + entry.pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('(.*)') + '$';
      const reason = await regexSupported(regex);
      if (reason) { markInvalid(card, 'pattern', `Pattern not supported: ${reason}`); ok = false; }
    }
  }

  for (const entry of settings.rewrites) {
    const card = rewriteList.querySelector(`[data-id="${entry.id}"]`);
    if (!entry.regex?.trim()) { markInvalid(card, 'regex', 'Regex is required'); ok = false; }
    else {
      const reason = await regexSupported(entry.regex);
      if (reason) { markInvalid(card, 'regex', `Regex not supported: ${reason}`); ok = false; }
    }
    if (!entry.replacement?.trim()) { markInvalid(card, 'replacement', 'Replacement is required'); ok = false; }
    if (!entry.modes?.length) { markInvalid(card, '', 'Select at least one mode'); ok = false; }
  }

  return ok;
}

async function save() {
  if (!(await validate())) {
    setStatus('Fix the highlighted fields before saving.', 'err');
    return;
  }
  const clean = {
    mapLocal: settings.mapLocal.map(e => ({
      id: e.id, enabled: e.enabled !== false, pattern: e.pattern.trim(),
      localPath: e.localPath.trim().replace(/\/+$/, ''), modes: e.modes
    })),
    rewrites: settings.rewrites.map(e => ({
      id: e.id, enabled: e.enabled !== false, regex: e.regex.trim(),
      replacement: e.replacement.trim(), modes: e.modes
    }))
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean });
  settings = structuredClone(clean);
  // Background pushes the folders to the server on storage change; wait for it, then refresh status
  await chrome.runtime.sendMessage({ action: 'pushServerConfig' }).catch(() => {});
  await pollHealth();
  setStatus(serverHealth ? 'Saved. Rules and server updated.' : 'Saved. Rules updated (server not running).', serverHealth ? 'ok' : '');
  setTimeout(() => setStatus(''), 3000);
}

async function load() {
  const { [SETTINGS_KEY]: stored } = await chrome.storage.local.get(SETTINGS_KEY);
  settings = stored?.mapLocal && stored?.rewrites
    ? structuredClone(stored)
    : await chrome.runtime.sendMessage({ action: 'getDefaultSettings' });
  renderAll();
}

document.getElementById('add-map-local').addEventListener('click', () => {
  settings.mapLocal.push({ id: uid('ml'), enabled: true, pattern: '', localPath: '', modes: ['dev', 'preview'] });
  renderMapLocal();
  mapLocalList.lastElementChild?.querySelector('input[type="text"]')?.focus();
});

document.getElementById('add-rewrite').addEventListener('click', () => {
  settings.rewrites.push({ id: uid('rw'), enabled: true, regex: '', replacement: '', modes: ['preview'] });
  renderRewrites();
  rewriteList.lastElementChild?.querySelector('input[type="text"]')?.focus();
});

document.getElementById('restore').addEventListener('click', async () => {
  settings = await chrome.runtime.sendMessage({ action: 'getDefaultSettings' });
  renderAll();
  setStatus('Defaults restored — click Save to apply.');
});

document.getElementById('save').addEventListener('click', save);

load().then(pollHealth);
setInterval(pollHealth, 4000);
