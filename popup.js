const serverStatus = document.getElementById('server-status');

// Show whether the local map-local server(s) the current mode relies on are reachable
async function updateServerStatus(ports = []) {
  if (!ports.length) {
    serverStatus.hidden = true;
    return;
  }

  const results = await Promise.all(ports.map(async (port) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__health`, { cache: 'no-store' });
      return { port, ok: res.ok };
    } catch {
      return { port, ok: false };
    }
  }));

  const down = results.filter(r => !r.ok).map(r => `:${r.port}`);
  serverStatus.hidden = false;
  serverStatus.classList.toggle('ok', down.length === 0);
  serverStatus.classList.toggle('down', down.length > 0);
  serverStatus.querySelector('.text').textContent = down.length
    ? `Local server ${down.join(', ')} not running`
    : `Local server ${results.map(r => `:${r.port}`).join(', ')} running`;
}

// ---- Global variable overrides (per domain, any mode) ----

const globalsEl = document.getElementById('globals');
const globalsList = document.getElementById('globals-list');
const globalsForm = document.getElementById('globals-add');
const globalsName = document.getElementById('globals-name');
const globalsValue = document.getElementById('globals-value');

let globals = [];

function renderGlobals(list, { domain, userScripts } = {}) {
  globals = Array.isArray(list) ? list : [];
  globalsEl.hidden = !domain;
  globalsEl.classList.toggle('unsupported', userScripts === false);
  globalsList.textContent = '';

  for (const entry of globals) {
    const row = document.createElement('div');
    row.className = 'row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    name.title = entry.name;

    const eq = document.createElement('span');
    eq.className = 'eq';
    eq.textContent = '=';

    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = entry.value;
    value.title = entry.value;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn remove';
    remove.title = 'Remove variable';
    remove.textContent = '×';
    remove.addEventListener('click', () => saveGlobals(globals.filter(e => e !== entry)));

    row.append(name, eq, value, remove);
    globalsList.appendChild(row);
  }
}

// Background stores the list, re-registers the user script and reloads the tab
async function saveGlobals(list) {
  const response = await chrome.runtime.sendMessage({ action: 'setGlobals', globals: list });
  if (response?.success) renderGlobals(response.globals, { domain: true, userScripts: !globalsEl.classList.contains('unsupported') });
}

globalsForm.addEventListener('submit', (event) => {
  event.preventDefault();
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

  updateServerStatus(response?.ports);
  renderGlobals(response?.globals, { domain: response?.domain, userScripts: response?.userScripts });
}

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

serverStatus.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// Initialize UI on load
updateUI();
