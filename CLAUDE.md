# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension (Manifest V3) that toggles development mode for on24.com domains by managing a cookie (`htm-dev-mode`) plus user-configurable **Map Local** and **Rewrite** rules, implemented Charles-style with `chrome.debugger` (Fetch domain): the page keeps its real URL/origin, only the response body (map local) or the outgoing URL (rewrite) is changed. No proxy is used. In DEV/PREVIEW, per-domain **Globals** (e.g. `window.isNurturePage = true`) are injected before any page JS runs via `chrome.userScripts`; in OFF they are kept but not injected.

**Future direction (design only, not implemented):** [docs/all-browsers-proxy-engine.md](docs/all-browsers-proxy-engine.md) describes moving the engine into a local MITM proxy in `local-server/` (started on demand; it owns modes and machine-local settings and caches the config) so DEV/PREVIEW, Map Local, rewrites and globals work in every browser (Chrome family, Firefox, Safari); rules/globals live in `chrome.storage.sync` (personal cloud config) and are pushed to the server by the Chrome extension, which stays as Chrome's UI client and config editor (badge, popup, options, launcher) and configures Chrome's proxy via `chrome.proxy`. The final package is the extension plus the mandatory `local-server/` companion.

## Development

No build step required. This is a plain JavaScript extension.

**To test changes:**
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory
4. After code changes, click the refresh icon on the extension card

**Local server for Map Local rules** (a Chrome extension cannot read disk; the service worker fetches files from `http://127.0.0.1:4815` — the page never talks to it):
```
npm run install-service      # macOS launchd agent com.devmode.serve: starts at login, auto-restarts
npm run uninstall-service
npm run serve                # or run it manually in a terminal
```
`local-server/serve.js` is zero-dependency and has no folder configuration of its own: the extension POSTs `{ mounts: { <ruleId>: <folder> } }` to `/__config` on startup and whenever settings are saved (only `chrome-extension://` origins are accepted; persisted in `~/.devmode-serve.json`). Files are served at `/m/<ruleId>/<path>`. `GET /__health` returns `{ ok, port, mounts: { id: { dir, exists } } }` for the popup/options status. Log: `~/Library/Logs/devmode-serve.log`. The port is fixed (`LOCAL_PORT` in background.js, `--port` in the install script).

## Architecture

**background.js** - Service worker containing extension logic:
- Manages three states: OFF, DEV, PREVIEW (per root domain, persisted in `chrome.storage.local.domainStates`; unknown/legacy values such as `prod` normalize to OFF)
- Sets/removes cookie `htm-dev-mode=4815162342` on `.on24.com`
- **Interception:** tabs whose URL's domain is in DEV/PREVIEW get `chrome.debugger.attach` + `Fetch.enable` (`attachTab`/`detachTab`/`syncTab`/`syncAllTabs`). Patterns = the raw map-local globs, or `*` when any rewrite rule applies to the state. On `Fetch.requestPaused` the mode is the **tab's** (`tabStates`, set by `enableInterception`), not the request host's — assets are served from CDNs such as `orionqa.akamaized.net`. Then: apply rewrites (`applyRewrites`, JS `String.replace` with `$n`) → first matching map-local rule (`mapLocalTarget`, `globToRegex`) → fetch `/m/<id>/<path>` from the local server → `Fetch.fulfillRequest` (200, server Content-Type, base64 body) or, if missing/server down, `Fetch.continueRequest` (with `url` when a rewrite changed it). Every paused request is answered exactly once.
- Attach triggers: `setState`, `webNavigation.onBeforeNavigate`, `tabs.onUpdated` (url), `storage.onChanged`, `init()` (re-attaches all open tabs after a worker restart). Navigation-triggered attaches pass `reloadAfter: true`: when they perform a *new* attach the document request was already in flight un-intercepted, so the tab is reloaded once (in-flight attaches are deduplicated per tab in `attaching`). `onDetach` with `canceled_by_user` (user clicked Cancel on the debugging bar) marks the tab as user-detached until its next top-level navigation. A 20 s `getPlatformInfo` keep-alive runs while any tab is attached. Debugger sessions outlive the worker, so `attachedTabs` is rebuilt from `chrome.debugger.getTargets()` on startup (`ensureReady`), `detachTab` always calls `chrome.debugger.detach`, and `attachTab` re-attaches when a remembered session no longer answers.
- `syncRules()` keeps a single kind of `declarativeNetRequest` dynamic rule: no-cache request headers per active domain
- **Globals (injected in DEV/PREVIEW only, paused in OFF):** `chrome.storage.local.globals` = `{ '.on24.com': [{ name, value }] }` (value = raw string). `syncGlobals()` (queued via `scheduleGlobalsSync`, run at `init()`, in `setState` before the reload, and on `storage.onChanged` for `globals` *or* `domainStates`) unregisters all user scripts and registers one per domain whose state is not OFF (OFF domains keep their list but get no script): `id: 'globals:<domain>'`, `matches: ['*://*.<d>/*', '*://<d>/*']`, inline `js: [{ code }]` from `buildGlobalsCode`, `world: 'MAIN'`, `runAt: 'document_start'`, `allFrames: true` (no other properties: `chrome.userScripts.register` rejects unknown keys such as `matchOriginAsFallback`, and the error only shows in the worker console). The code defines each variable as a locked accessor on `window` (getter returns the value, setter is a no-op) so it exists before any page script and survives page assignments. Values are `JSON.parse`d when possible (`true`, `42`, `{"a":1}`), otherwise kept as strings. Messages: `getState` also returns `{ domain, globals, userScripts }`; `setGlobals` saves the active tab domain's list, re-registers, and reloads the tab; `openExtensionDetails` opens `chrome://extensions/?id=…`. Requires the `userScripts` permission **and** the per-extension "Allow User Scripts" toggle (chrome://extensions → Dev Mode → Details, Chrome 138+); `userScriptsAvailable()` detects it and the popup shows a hint otherwise. Registrations persist across worker restarts and browser sessions.
- Generates dynamic badge icons using OffscreenCanvas
- Auto-reloads the tab when state changes

**options.html / options.js** - Settings page (gear icon in popup, or chrome://extensions → Details → Extension options):
- Any number of Map Local (`pattern`, `localPath`, `modes`) and Rewrite (`regex`, `replacement`, `modes`) rules, each with an enabled flag
- Validates regexes with `new RegExp`, writes `chrome.storage.local.settings`; background then re-syncs interception and pushes folders to the server
- Shows local-server status (dot + text under the title)

**popup.html / popup.js** - Dropdown menu UI:
- Styled dark theme dropdown with three options, gear button to settings
- **Globals** section below the modes: saved variables render as inline chips `name = value` with × to delete, plus a name/value form with + (Enter also adds). Editing saves via `setGlobals` and keeps the popup open while the tab reloads. Hidden on non-http(s) tabs; red hint when "Allow User Scripts" is off. In OFF the section gets `.disabled`: a "Not injected while Off" badge, grayed chips/inputs, inputs and buttons disabled
- Shows local server status when the active mode uses Map Local rules
- Communicates with background.js via chrome.runtime.sendMessage

**local-server/serve.js** - Static file server for Map Local (see above)

**manifest.json** - Extension configuration (Manifest V3):
- Permissions: `cookies`, `debugger`, `declarativeNetRequest`, `tabs`, `webNavigation`, `storage`, `userScripts`
- Host permissions: `<all_urls>`

## Key Implementation Details

**States:**
| State | Icon | Label | Cookie | Cache | Rules |
|-------|------|-------|--------|-------|-------|
| OFF | Gray | OFF | deleted | enabled | none (tab detached) |
| DEV | Green | DEV | SET (`htm-dev-mode=4815162342`) | disabled | rules whose `modes` include `dev` |
| PREVIEW | Yellow | PRE | deleted | disabled | rules whose `modes` include `preview` |

**Settings model** (`chrome.storage.local.settings`, seeded from `DEFAULT_SETTINGS` in background.js when missing):
```js
{
  mapLocal: [{ id, enabled, pattern: 'https://*/view/orion/*', localPath: '/Users/jnova/Projects/orion/static', modes: ['dev','preview'] }],
  rewrites: [{ id, enabled, regex: '/(.*)/dist/production-(css|js)-(.*).(css|js)(.*)', replacement: '/$1/dist/production-$2.$4', modes: ['preview'] }]
}
```

**Globals model** (`chrome.storage.local.globals`, separate from `settings` so the options page never overwrites it):
```js
{ '.on24.com': [{ name: 'isNurturePage', value: 'true' }] }   // per root domain, same keys as domainStates
```

**Request flow (Fetch domain):** Rewrite runs before Map Local, so in PREVIEW `…/dist/production-js-<hash>.js` → `…/dist/production-js.js` → local `static/labs/dist/production-js.js`, while the page still sees the hashed URL. HTML documents and iframes are mapped the same way as assets (no origin change, cookies and same-origin API calls keep working).

**Known QA quirk (not extension-related):** `gatewayqa.on24.com` landing pages sometimes answer a Tomcat default 404 when the page is *reloaded* shortly after loading (any reload, including Cmd+R with the extension disabled). Verified 2026-09-24: identical requests replayed with curl always get 200; the 404 arrives on a reused keep-alive connection. Mode switches reload the tab, so they can surface it. Infra issue (load-balancer persistence), reported by the user.

**Debugging bar:** Chrome shows *"Dev Mode started debugging this browser"* on attached tabs. It can be hidden by launching Chrome with `--silent-debugger-extension-api`. DevTools can be open at the same time (multi-client).

**UI Features:**
- Dark theme popup with animated menu items, click ripple, active indicator
- Options page shares the popup's theme tokens
