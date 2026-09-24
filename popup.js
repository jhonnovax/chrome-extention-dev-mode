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

// Get current state and update UI
async function updateUI() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const response = await chrome.runtime.sendMessage({ action: 'getState', prefersDark });
  const currentState = response?.state || 'off';

  document.querySelectorAll('.menu-item').forEach(item => {
    item.classList.toggle('active', item.dataset.state === currentState);
  });

  updateServerStatus(response?.ports);
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
