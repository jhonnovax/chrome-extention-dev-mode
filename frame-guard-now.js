// Runs before frame-guard.js on pages of domains in DEV/PREVIEW: tells it to start at once,
// without waiting for the worker's answer (another extension may inject its frame at page start).
window.__devModeFrameGuardNow = true;
window.__devModeFrameGuardStart?.();
