# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension (Manifest V3) that toggles development mode for on24.com domains by managing a cookie (`htm-dev-mode`) plus user-configurable **Map Local** and **Rewrite** rules, implemented Charles-style with `chrome.debugger` (Fetch domain): the page keeps its real URL/origin, only the response body (map local, read straight from disk via `file://`) or the outgoing URL (rewrite) is changed. No proxy and no local server. In DEV/PREVIEW, per-domain **Globals** (e.g. `window.isNurturePage = true`) are injected before any page JS runs via `chrome.userScripts`; in OFF they are kept but not injected.

**Config lives in the cloud:** rules and globals are stored in `chrome.storage.sync` (`sync-schema.js`), so they follow the Google account signed into Chrome to every Chrome profile/machine where this extension is loaded. The extension ID is fixed by the `key` field in `manifest.json` (public key; the private key is at `~/.devmode-extension-key.pem`, outside the repo, only needed to pack a CRX), so the ID is `kiodgandllfdichppoigkhkdjbajpnpn` on every machine. Modes (`domainStates`) stay in `chrome.storage.local`, per machine.

**Future direction (design only, not implemented):** [docs/all-browsers-proxy-engine.md](docs/all-browsers-proxy-engine.md) describes moving the engine into a local MITM proxy in `local-server/` (recreated from scratch; the old static server was removed in 1.4) so DEV/PREVIEW, Map Local, rewrites and globals work in every browser (Chrome family, Firefox, Safari); the Chrome extension stays as Chrome's UI client and config editor and configures Chrome's proxy via `chrome.proxy`. The final package is the extension plus that mandatory local companion.

## Development

No build step required. This is a plain JavaScript extension. No local server, no setup scripts.

**To test changes:**
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory
4. On the extension card → Details, turn on **Allow User Scripts** (globals) and **Allow access to file URLs** (Map Local). Both are per-extension toggles; without them the popup/options show a red hint and the feature falls back (no injection / real site).
5. After code changes, click the refresh icon on the extension card

**Sync:** Chrome must be signed in with the "Extensions" sync data type on for the config to reach other machines; otherwise `chrome.storage.sync` silently behaves like local storage. Quotas: 100 KB total, 8 KB per key, 120 writes/min (one rule or one domain's globals list is one key). Sync is Chrome-only (Edge/Brave have their own sync).

## Architecture

**sync-schema.js** - Config store shared by `background.js` (`importScripts`) and `options.js` (`<script>`), exposed as `DevModeConfig`:
- Keys in `chrome.storage.sync`: `meta { schema, updatedAt }`, `rule:<id>` (`{ kind: 'mapLocal'|'rewrite', order, enabled, modes, pattern, localPath | regex, replacement }`), `globals:<domain>` (`[{ name, value }]`)
- `readConfig()` → `{ mapLocal, rewrites, globals, seeded }`; with no `meta` key it returns `DEFAULT_SETTINGS` **without writing**, so a fresh machine never overwrites cloud data. `writeSettings({ mapLocal, rewrites })` = one `set()` + one `remove()` of dropped rule keys; `writeGlobals(domain, list)`. Quota errors propagate to the caller.

**background.js** - Service worker containing extension logic:
- Manages three states: OFF, DEV, PREVIEW (per root domain, persisted in `chrome.storage.local.domainStates`; unknown/legacy values such as `prod` normalize to OFF)
- Sets/removes cookie `htm-dev-mode=4815162342` on `.on24.com`
- `getConfig()`/`getSettings()` read the sync store through `DevModeConfig` with an in-memory cache invalidated on `storage.onChanged` (area `sync`). `migrateLocalConfig()` (on `onInstalled`) moves pre-1.4 `chrome.storage.local.settings/globals` into sync once, only when the sync store is still empty.
- **Interception:** tabs whose URL's domain is in DEV/PREVIEW get `chrome.debugger.attach` + `Fetch.enable` (`attachTab`/`detachTab`/`syncTab`/`syncAllTabs`). Patterns = the raw map-local globs, or `*` when any rewrite rule applies to the state. On `Fetch.requestPaused` the mode is the **tab's** (`tabStates`, set by `enableInterception`), not the request host's — assets are served from CDNs such as `orionqa.akamaized.net`. Then: apply rewrites (`applyRewrites`, JS `String.replace` with `$n`) → first matching map-local rule (`mapLocalTarget`, `globToRegex`) → `fileUrlFor(localPath, lastWildcard)` (`file://` URL under the rule's folder; empty or trailing-slash paths get `index.html`; paths escaping the folder are refused) → `fetch(file://…)` from the worker (needs "Allow access to file URLs", checked with `chrome.extension.isAllowedFileSchemeAccess()` cached 5 s) → `Fetch.fulfillRequest` (200, Content-Type from the `MIME` table, base64 body) or, if the file is missing or file access is off, `Fetch.continueRequest` (with `url` when a rewrite changed it), warning once per URL. Every paused request is answered exactly once.
- Attach triggers: `setState`, `webNavigation.onBeforeNavigate`, `tabs.onUpdated` (url), `storage.onChanged`, `init()` (re-attaches all open tabs after a worker restart). Navigation-triggered attaches pass `reloadAfter: true`: when they perform a *new* attach the document request was already in flight un-intercepted, so the tab is reloaded once (in-flight attaches are deduplicated per tab in `attaching`). `onDetach` with `canceled_by_user` (user clicked Cancel on the debugging bar) marks the tab as user-detached until its next top-level navigation. A 20 s `getPlatformInfo` keep-alive runs while any tab is attached. Debugger sessions outlive the worker, so `attachedTabs` is rebuilt from `chrome.debugger.getTargets()` on startup (`ensureReady`), `detachTab` always calls `chrome.debugger.detach`, and `attachTab` re-attaches when a remembered session no longer answers. **OFF always wins:** `attachTab`/`enableInterception` re-read the tab's mode (`currentTabState`) after every await and detach instead of enabling when it became OFF, `detachTab` waits for an in-flight attach before detaching, `tabStates` is cleared whenever `domainStates` changes, and a `Fetch.requestPaused` on an OFF tab is passed through untouched and detaches the tab. An OFF tab must behave as if the extension were not installed: no debugger session, no Map Local, no rewrites, no globals.
- `syncRules()` keeps a single kind of `declarativeNetRequest` dynamic rule: no-cache request headers per active domain
- **Globals (injected in DEV/PREVIEW only, paused in OFF):** `globals:<domain>` in sync (value = raw string). `syncGlobals()` (queued via `scheduleGlobalsSync`, run at `init()`, in `setState` before the reload, and on `storage.onChanged` for `globals:` keys *or* `domainStates`) unregisters all user scripts and registers one per domain whose state is not OFF (OFF domains keep their list but get no script): `id: 'globals:<domain>'`, `matches: ['*://*.<d>/*', '*://<d>/*']`, inline `js: [{ code }]` from `buildGlobalsCode`, `world: 'MAIN'`, `runAt: 'document_start'`, `allFrames: true` (no other properties: `chrome.userScripts.register` rejects unknown keys such as `matchOriginAsFallback`, and the error only shows in the worker console). The code defines each variable as a locked accessor on `window` (getter returns the value, setter is a no-op) so it exists before any page script and survives page assignments. Values are `JSON.parse`d when possible (`true`, `42`, `{"a":1}`), otherwise kept as strings. Messages: `getState` also returns `{ domain, globals, userScripts, usesMapLocal, fileAccess }`; `setGlobals` saves the active tab domain's list to sync, re-registers, and reloads the tab; `openExtensionDetails` opens `chrome://extensions/?id=…`. Requires the `userScripts` permission **and** the per-extension "Allow User Scripts" toggle (Chrome 138+); `userScriptsAvailable()` detects it and the popup shows a hint otherwise. Registrations persist across worker restarts and browser sessions.
- `storage.onChanged`: area `local` + `domainStates` → DNR rules, tab sync, globals; area `sync` (fires for local edits and for changes arriving from another machine) → cache invalidation, tab sync when a `rule:` key changed, globals when a `globals:` key changed.
- Generates dynamic badge icons using OffscreenCanvas
- Auto-reloads the tab when state changes

**options.html / options.js** - Settings page (gear icon in popup, or chrome://extensions → Details → Extension options):
- Any number of Map Local (`pattern`, `localPath`, `modes`) and Rewrite (`regex`, `replacement`, `modes`) rules, each with an enabled flag
- Validates regexes with `new RegExp`, writes through `DevModeConfig.writeSettings`; a sync/quota error is shown in the footer and nothing is saved. "Restore defaults" uses `DevModeConfig.defaults()`.
- Banner under the title: file access state (`chrome.extension.isAllowedFileSchemeAccess()`, click → extension details); each Map Local rule shows the last file the worker served or failed to find (`getMapLocalStats` message; a folder cannot be probed from an extension page because Chrome only lists `file://` directories on navigation). Re-renders on remote sync changes when no input is focused.

**popup.html / popup.js** - Dropdown menu UI:
- Styled dark theme dropdown with three options, gear button to settings
- **Globals** section below the modes: saved variables render as inline chips `name = value` with × to delete, plus a name/value form with + (Enter also adds). Editing saves via `setGlobals` and keeps the popup open while the tab reloads. Hidden on non-http(s) tabs; red hint when "Allow User Scripts" is off. In OFF the section gets `.disabled`: a "Not injected while Off" badge, grayed chips/inputs, inputs and buttons disabled
- `#file-access` line: shown only when the active mode uses a Map Local rule and "Allow access to file URLs" is off (click → extension details)
- Communicates with background.js via chrome.runtime.sendMessage

**manifest.json** - Extension configuration (Manifest V3):
- `key`: fixed public key → stable extension ID (needed for `chrome.storage.sync` to be the same store on every machine)
- Permissions: `cookies`, `debugger`, `declarativeNetRequest`, `tabs`, `webNavigation`, `storage`, `userScripts`
- Host permissions: `<all_urls>` (covers `file://` once the toggle is on)

## Key Implementation Details

**States:**
| State | Icon | Label | Cookie | Cache | Rules |
|-------|------|-------|--------|-------|-------|
| OFF | Gray | OFF | deleted | enabled | none (tab detached) |
| DEV | Green | DEV | SET (`htm-dev-mode=4815162342`) | disabled | rules whose `modes` include `dev` |
| PREVIEW | Yellow | PRE | deleted | disabled | rules whose `modes` include `preview` |

**Settings model** (`chrome.storage.sync`, one key per rule; `DEFAULT_SETTINGS` in sync-schema.js is returned while the store is empty):
```js
'rule:ml-orion':           { kind: 'mapLocal', order: 0, enabled: true, pattern: 'https://*/view/orion/*', localPath: '/Users/jnova/Projects/orion/static', modes: ['dev','preview'] }
'rule:rw-production-hash': { kind: 'rewrite',  order: 1, enabled: true, regex: '/(.*)/dist/production-(css|js)-(.*).(css|js)(.*)', replacement: '/$1/dist/production-$2.$4', modes: ['preview'] }
```
`readConfig()` hands them to the rest of the code in the old array shapes: `{ mapLocal: [{ id, enabled, pattern, localPath, modes }], rewrites: [{ id, enabled, regex, replacement, modes }] }`.

**Globals model** (`chrome.storage.sync`):
```js
'globals:.on24.com': [{ name: 'isNurturePage', value: 'true' }]   // per root domain, same keys as domainStates
```

**Request flow (Fetch domain):** Rewrite runs before Map Local, so in PREVIEW `…/dist/production-js-<hash>.js` → `…/dist/production-js.js` → `file:///Users/jnova/Projects/orion/static/labs/dist/production-js.js`, while the page still sees the hashed URL. HTML documents and iframes are mapped the same way as assets (no origin change, cookies and same-origin API calls keep working). `localPath` is synced as typed; on a machine where the folder does not exist the options page flags it and requests fall through to the real site.

**Known QA quirk (not extension-related):** `gatewayqa.on24.com` landing pages sometimes answer a Tomcat default 404 when the page is *reloaded* shortly after loading (any reload, including Cmd+R with the extension disabled). Verified 2026-09-24: identical requests replayed with curl always get 200; the 404 arrives on a reused keep-alive connection. Mode switches reload the tab, so they can surface it. Infra issue (load-balancer persistence), reported by the user.

**Debugging bar:** Chrome shows *"Dev Mode started debugging this browser"* while the extension is attached to any tab; recent Chrome versions show that infobar in every tab of the window (it is per browser/window, not per tab), so an OFF tab can still show it while another tab is in DEV/PREVIEW. It can be hidden by launching Chrome with `--silent-debugger-extension-api`. DevTools can be open at the same time (multi-client).

**UI Features:**
- Dark theme popup with animated menu items, click ripple, active indicator
- Options page shares the popup's theme tokens
