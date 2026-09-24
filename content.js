// Runs at document_start on every page. If the current domain's mode uses Map Local rules,
// make one explicit fetch to the local server so Chrome shows its "Local Network Access"
// permission prompt (Chrome 142+). Redirected sub-resources can't trigger that prompt on
// their own, so without this they fail with "Permission was denied ... loopback address space".
(async () => {
  if (window !== window.top) return;

  let ports;
  try {
    ({ ports } = await chrome.runtime.sendMessage({ action: 'getLocalPorts', url: location.href }));
  } catch {
    return;
  }
  if (!ports?.length) return;

  // Chrome 145+ names the loopback permission 'loopback-network'; 142–144 use 'local-network-access'
  const permissionState = async () => {
    for (const name of ['loopback-network', 'local-network-access']) {
      try {
        return (await navigator.permissions.query({ name })).state;
      } catch { /* unsupported name */ }
    }
    return 'unknown';
  };

  const before = await permissionState();

  const results = await Promise.all(ports.map(async (port) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__health`, {
        targetAddressSpace: 'loopback', mode: 'cors', cache: 'no-store'
      });
      return { port, ok: res.ok };
    } catch {
      return { port, ok: false };
    }
  }));

  const after = await permissionState();

  // Permission was just granted through the prompt: assets requested meanwhile failed, reload once
  if (before !== 'granted' && after === 'granted') {
    location.reload();
    return;
  }

  const down = results.filter(r => !r.ok).map(r => r.port);
  if (down.length) {
    console.warn(
      `[Dev Mode] Local server not reachable on port(s) ${down.join(', ')}. ` +
      `Run "npm run install-service" once in the extension folder. ` +
      `If Chrome asked for "local network" / "apps on device" access, click Allow ` +
      `(or enable it from the site info icon in the address bar) and reload.`
    );
  }
})();
