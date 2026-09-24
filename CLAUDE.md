# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension (Manifest V3) that toggles development mode for on24.com domains by managing a cookie (`htm-dev-mode`) plus user-configurable **Map Local** and **Rewrite** rules, implemented Charles-style with `chrome.debugger` (Fetch domain): the page keeps its real URL/origin, only the response body (map local) or the outgoing URL (rewrite) is changed. No proxy is used.

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
- **Interception:** tabs whose URL's domain is in DEV/PREVIEW get `chrome.debugger.attach` + `Fetch.enable` (`attachTab`/`detachTab`/`syncTab`/`syncAllTabs`). Patterns = the raw map-local globs, or `*` when any rewrite rule applies to the state. On `Fetch.requestPaused`: apply rewrites (`applyRewrites`, JS `String.replace` with `$n`) → first matching map-local rule (`mapLocalTarget`, `globToRegex`) → fetch `/m/<id>/<path>` from the local server → `Fetch.fulfillRequest` (200, server Content-Type, base64 body) or, if missing/server down, `Fetch.continueRequest` (with `url` when a rewrite changed it). Every paused request is answered exactly once.
- Attach triggers: `setState`, `webNavigation.onBeforeNavigate`, `tabs.onUpdated` (url), `storage.onChanged`, `init()` (re-attaches all open tabs after a worker restart). Navigation-triggered attaches pass `reloadAfter: true`: when they perform a *new* attach the document request was already in flight un-intercepted, so the tab is reloaded once (in-flight attaches are deduplicated per tab in `attaching`). `onDetach` with `canceled_by_user` (user clicked Cancel on the debugging bar) marks the tab as user-detached until its next top-level navigation. A 20 s `getPlatformInfo` keep-alive runs while any tab is attached. Debugger sessions outlive the worker, so `attachedTabs` is rebuilt from `chrome.debugger.getTargets()` on startup (`ensureReady`), `detachTab` always calls `chrome.debugger.detach`, and `attachTab` re-attaches when a remembered session no longer answers.
- `syncRules()` keeps a single kind of `declarativeNetRequest` dynamic rule: no-cache request headers per active domain
- Generates dynamic badge icons using OffscreenCanvas
- Auto-reloads the tab when state changes

**options.html / options.js** - Settings page (gear icon in popup, or chrome://extensions → Details → Extension options):
- Any number of Map Local (`pattern`, `localPath`, `modes`) and Rewrite (`regex`, `replacement`, `modes`) rules, each with an enabled flag
- Validates regexes with `new RegExp`, writes `chrome.storage.local.settings`; background then re-syncs interception and pushes folders to the server
- Shows local-server status (dot + text under the title)

**popup.html / popup.js** - Dropdown menu UI:
- Styled dark theme dropdown with three options, gear button to settings
- Shows local server status when the active mode uses Map Local rules
- Communicates with background.js via chrome.runtime.sendMessage

**local-server/serve.js** - Static file server for Map Local (see above)

**manifest.json** - Extension configuration (Manifest V3):
- Permissions: `cookies`, `debugger`, `declarativeNetRequest`, `tabs`, `webNavigation`, `storage`
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

**Request flow (Fetch domain):** Rewrite runs before Map Local, so in PREVIEW `…/dist/production-js-<hash>.js` → `…/dist/production-js.js` → local `static/labs/dist/production-js.js`, while the page still sees the hashed URL. HTML documents and iframes are mapped the same way as assets (no origin change, cookies and same-origin API calls keep working).

**Known QA quirk (not extension-related):** `gatewayqa.on24.com` landing pages sometimes answer a Tomcat default 404 when the page is *reloaded* shortly after loading (any reload, including Cmd+R with the extension disabled). Verified 2026-09-24: identical requests replayed with curl always get 200; the 404 arrives on a reused keep-alive connection. Mode switches reload the tab, so they can surface it. Infra issue (load-balancer persistence), reported by the user.

**Debugging bar:** Chrome shows *"Dev Mode started debugging this browser"* on attached tabs. It can be hidden by launching Chrome with `--silent-debugger-extension-api`. DevTools can be open at the same time (multi-client).

**UI Features:**
- Dark theme popup with animated menu items, click ripple, active indicator
- Options page shares the popup's theme tokens
