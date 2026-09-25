// Frame guard (content script, isolated world, every frame of every page while a mode is active).
//
// Chrome refuses to let an extension debug a tab that contains a frame of another extension, and
// closes the session when one appears. Password managers (iCloud Passwords…) and similar inject
// such frames next to text fields. On tabs Dev Mode debugs, this script removes those frames as
// soon as they are inserted, before their chrome-extension:// URL commits, so the tab stays
// debuggable. Only foreign extension frames are touched; the page's own iframes are left alone.
// It does nothing until the worker says the tab is in DEV/PREVIEW.

(() => {
  if (window.__devModeFrameGuard) return;
  window.__devModeFrameGuard = true;

  const OWN_PREFIX = `chrome-extension://${chrome.runtime.id}/`;
  let active = false;
  let observer = null;
  let sweepTimer = null;
  let removed = 0;

  const srcOf = (el) => el.getAttribute?.('src') || el.getAttribute?.('data') || el.src || el.data || '';
  const isForeign = (el) => {
    const src = srcOf(el);
    return typeof src === 'string' && src.startsWith('chrome-extension://') && !src.startsWith(OWN_PREFIX);
  };

  function remove(el) {
    try {
      el.remove();
      removed++;
    } catch { /* ignore */ }
  }

  function sweep(root) {
    if (!root?.querySelectorAll) return;
    for (const el of root.querySelectorAll('iframe, frame, embed, object')) if (isForeign(el)) remove(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) watch(el.shadowRoot);
  }

  const watched = new WeakSet();
  function watch(root) {
    if (!root || watched.has(root)) return;
    watched.add(root);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data'] });
    sweep(root);
  }

  function onMutations(records) {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (isForeign(r.target)) remove(r.target);
        continue;
      }
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (isForeign(node)) { remove(node); continue; }
        sweep(node);
        if (node.shadowRoot) watch(node.shadowRoot);
      }
    }
  }

  function start() {
    if (active) return;
    active = true;
    observer = new MutationObserver(onMutations);
    watch(document);
    // Safety net for frames that arrive through paths the observer does not see
    sweepTimer = setInterval(() => sweep(document), 1000);
  }

  function stop() {
    if (!active) return;
    active = false;
    observer?.disconnect();
    observer = null;
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.action === 'frameGuard') {
      msg.active ? start() : stop();
      respond({ active, removed });
    }
  });

  // Pages of active domains start right away (frame-guard-now.js sets the flag, in either order)
  window.__devModeFrameGuardStart = start;
  if (window.__devModeFrameGuardNow) {
    start();
    return;
  }
  try {
    chrome.runtime.sendMessage({ action: 'frameGuardStatus' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.active) start();
    });
  } catch { /* worker asleep: it pushes the state when it attaches the tab */ }
})();
