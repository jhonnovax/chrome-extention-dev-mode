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

// ---- file access (Map Local reads the folders straight from disk) ----

async function fileAccessAllowed() {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

async function renderFileAccessBanner() {
  const banner = document.getElementById('file-access-banner');
  const dot = banner.querySelector('.dot');
  const text = banner.querySelector('.text');
  const allowed = await fileAccessAllowed();
  if (allowed) {
    dot.className = 'dot ok';
    text.textContent = 'Map Local files are served straight from disk (file access allowed).';
    banner.classList.remove('action');
  } else {
    dot.className = 'dot down';
    text.textContent = 'Map Local needs "Allow access to file URLs": click here to open the extension details and turn it on.';
    banner.classList.add('action');
  }
  await refreshFolderChecks();
}

// A folder cannot be probed from here (Chrome only lists file:// directories on navigation), so show what
// the worker actually did with each rule since it started: last file served, or last file it could not find
async function refreshFolderChecks() {
  let stats = {};
  try {
    stats = (await chrome.runtime.sendMessage({ action: 'getMapLocalStats' })) || {};
  } catch { /* worker asleep: nothing to show */ }
  for (const entry of settings.mapLocal) {
    const card = mapLocalList.querySelector(`[data-id="${entry.id}"]`);
    const note = card?.querySelector('.folder-note');
    if (!note) continue;
    const last = stats[entry.id]?.last;
    note.classList.toggle('ok', !!last?.ok);
    if (!last) { note.textContent = ''; continue; }
    const rel = decodeURIComponent(last.url.replace(/^file:\/\//, ''));
    note.textContent = last.ok
      ? `Last served: ${rel}`
      : `Last file not found: ${rel} (request went to the real site)`;
  }
}

function renderMapLocal() {
  mapLocalList.textContent = '';

  if (!settings.mapLocal.length) {
    mapLocalList.innerHTML = '<p class="empty">No map-local rules.</p>';
    return;
  }

  for (const entry of settings.mapLocal) {
    const { card, fields } = cardShell(entry, settings.mapLocal, renderMapLocal);
    const note = document.createElement('div');
    note.className = 'folder-note wide';
    fields.append(
      textField('URL pattern', entry, 'pattern', { placeholder: 'https://*/view/orion/*', wide: true }),
      textField('Local folder', entry, 'localPath', { placeholder: '/path/to/static', wide: true, onInput: () => { note.textContent = ''; } }),
      note,
      modesField(entry)
    );
    mapLocalList.appendChild(card);
  }
  refreshFolderChecks();
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

// Rules are evaluated with JavaScript RegExp; returns an error message or null
async function regexSupported(regex) {
  try {
    new RegExp(regex, 'i');
    return null;
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
  try {
    // Background re-syncs interception on the storage change; nothing else to notify
    await DevModeConfig.writeSettings(clean);
  } catch (err) {
    // Chrome sync quota (8 KB per rule, 100 KB total, 120 writes/min) or sync unavailable
    setStatus(`Not saved: ${err?.message || err}`, 'err');
    return;
  }
  settings = structuredClone(clean);
  await refreshFolderChecks();
  setStatus('Saved. Rules sync to your other Chrome profiles through your Google account.', 'ok');
  setTimeout(() => setStatus(''), 3000);
}

async function load() {
  const { mapLocal, rewrites } = await DevModeConfig.readConfig();
  settings = { mapLocal, rewrites };
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

document.getElementById('restore').addEventListener('click', () => {
  settings = DevModeConfig.defaults();
  renderAll();
  setStatus('Defaults restored — click Save to apply.');
});

document.getElementById('save').addEventListener('click', save);

document.getElementById('file-access-banner').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'openExtensionDetails' });
});

// Edits arriving from another machine (or the popup's globals) re-render when nothing is being typed
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !Object.keys(changes).some(DevModeConfig.isRuleKey)) return;
  if (document.activeElement?.tagName === 'INPUT') return;
  load();
});

load().then(renderFileAccessBanner);
// The toggle lives on the extension card; re-check when the user comes back to this tab
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderFileAccessBanner(); });
