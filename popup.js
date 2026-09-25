const fileAccessEl = document.getElementById('file-access');

// Map Local reads files straight from disk: warn when the mode uses it but file access is off.
// The toggle is checked here (extension page) rather than trusting the worker, which may lack chrome.extension.
async function updateFileAccess({ usesMapLocal = false } = {}) {
  let fileAccess = true;
  try {
    fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  } catch { /* unknown: stay quiet */ }
  const show = usesMapLocal && !fileAccess;
  fileAccessEl.hidden = !show;
  fileAccessEl.classList.toggle('down', show);
  fileAccessEl.querySelector('.text').textContent = show
    ? 'Map Local needs “Allow access to file URLs” — click to open extension details'
    : '';
}

// ---- Global variable overrides (per domain, any mode) ----

const globalsEl = document.getElementById('globals');
const globalsList = document.getElementById('globals-list');
const globalsForm = document.getElementById('globals-add');
const globalsName = document.getElementById('globals-name');
const globalsValue = document.getElementById('globals-value');

let globals = [];
let globalsMeta = { domain: null, userScripts: true, state: 'off' };

function renderGlobals(list, meta = {}) {
  globals = Array.isArray(list) ? list : [];
  globalsMeta = { ...globalsMeta, ...meta };
  const { domain, userScripts, state } = globalsMeta;
  const disabled = state === 'off';

  globalsEl.hidden = !domain;
  globalsEl.classList.toggle('unsupported', userScripts === false);
  globalsEl.classList.toggle('disabled', disabled);
  globalsName.disabled = disabled;
  globalsValue.disabled = disabled;
  globalsForm.querySelector('.btn.add').disabled = disabled;
  globalsList.textContent = '';

  for (const entry of globals) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.title = `${entry.name} = ${entry.value}`;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;

    const eq = document.createElement('span');
    eq.className = 'eq';
    eq.textContent = '=';

    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = entry.value;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn remove';
    remove.title = 'Remove variable';
    remove.textContent = '×';
    remove.disabled = disabled;
    remove.addEventListener('click', () => saveGlobals(globals.filter(e => e !== entry)));

    chip.append(name, eq, value, remove);
    globalsList.appendChild(chip);
  }
}

// Background stores the list, re-registers the user script and reloads the tab
async function saveGlobals(list) {
  const response = await chrome.runtime.sendMessage({ action: 'setGlobals', globals: list });
  if (response?.success) renderGlobals(response.globals);
}

globalsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (globalsMeta.state === 'off') return;
  const name = globalsName.value.trim().replace(/^(window|self|globalThis)\./, '');
  if (!name) {
    globalsName.focus();
    return;
  }
  const value = globalsValue.value;
  const next = globals.filter(e => e.name !== name);
  next.push({ name, value });
  globalsName.value = '';
  globalsValue.value = '';
  globalsName.focus();
  saveGlobals(next);
});

document.getElementById('globals-hint').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'openExtensionDetails' });
  window.close();
});

// Get current state and update UI
async function updateUI() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const response = await chrome.runtime.sendMessage({ action: 'getState', prefersDark });
  const currentState = response?.state || 'off';

  document.querySelectorAll('.menu-item').forEach(item => {
    item.classList.toggle('active', item.dataset.state === currentState);
  });

  updateFileAccess(response);
  updateBlocked(response?.blockedBy || [], response?.interrupted);
  renderGlobals(response?.globals, { domain: response?.domain, userScripts: response?.userScripts, state: currentState });
}

// Chrome refuses to debug a tab that contains a frame of another extension: nothing works there until it is off
let blockingExtension = null;
// Another extension's frame (password managers such as iCloud Passwords inject one next to inputs)
// makes Chrome end Dev Mode's debugging of the tab: nothing is mapped (blocked), or requests made
// until the re-attach went to the real site (interrupted)
function updateBlocked(ids, interrupted) {
  const el = document.getElementById('blocked');
  const culprits = ids.length ? ids : (interrupted?.ids || []);
  blockingExtension = culprits[0] || null;
  let text = '';
  if (ids.length) {
    text = `Chrome stopped Dev Mode on this tab: another extension (id ${ids.join(', ')}) put a frame in the page. Nothing here is mapped.`;
  } else if (interrupted?.count) {
    text = `Another extension${culprits.length ? ` (id ${culprits.join(', ')})` : ''} interrupted Dev Mode ${interrupted.count}× while this page loaded: some files came from the real site.`;
  }
  if (text) text += ' Click to open that extension and set Site access to "On click" (it stays installed and works when you click its icon), then reload.';
  el.hidden = !text;
  el.classList.toggle('down', !!text);
  el.querySelector('.text').textContent = text;
}
document.getElementById('blocked').addEventListener('click', () => {
  chrome.tabs.create({ url: blockingExtension ? `chrome://extensions/?id=${blockingExtension}` : 'chrome://extensions/' });
});

// Create ripple effect on click
function createRipple(event, element) {
  const ripple = document.createElement('span');
  ripple.className = 'ripple';

  const rect = element.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);

  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (event.clientX - rect.left - size / 2) + 'px';
  ripple.style.top = (event.clientY - rect.top - size / 2) + 'px';

  element.appendChild(ripple);

  ripple.addEventListener('animationend', () => ripple.remove());
}

// Handle menu item clicks
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', async (event) => {
    const newState = item.dataset.state;

    // Create ripple effect
    createRipple(event, item);

    // Send message to background script to change state
    await chrome.runtime.sendMessage({ action: 'setState', state: newState });

    // Update UI
    await updateUI();

    // Close popup after a brief delay for visual feedback
    setTimeout(() => window.close(), 150);
  });
});

// Open settings page
document.getElementById('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

fileAccessEl.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'openExtensionDetails' });
  window.close();
});

// Initialize UI on load
updateUI();
