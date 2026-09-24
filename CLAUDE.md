# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension (Manifest V3) that toggles development mode for on24.com domains by managing a cookie (`htm-dev-mode`) plus user-configurable **Map Local** and **Rewrite** rules implemented with `declarativeNetRequest`. No proxy is used.

## Development

No build step required. This is a plain JavaScript extension.

**To test changes:**
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory
4. After code changes, click the refresh icon on the extension card

**Local server for Map Local rules** (a Chrome extension cannot read disk, so mapped requests are redirected to `http://127.0.0.1:4815`):
```
npm run install-service      # macOS launchd agent com.devmode.serve: starts at login, auto-restarts
npm run uninstall-service
npm run serve                # or run it manually in a terminal
```
`local-server/serve.js` is zero-dependency and has no folder configuration of its own: the extension POSTs `{ mounts: { <ruleId>: <folder> } }` to `/__config` on startup and whenever settings are saved (only `chrome-extension://` origins are accepted; persisted in `~/.devmode-serve.json`). Files are served at `/m/<ruleId>/<path>` with permissive CORS + `Cache-Control: no-store`. `GET /__health` returns `{ ok, port, mounts: { id: { dir, exists } } }` for the popup/options status. Log: `~/Library/Logs/devmode-serve.log`. The port is fixed (`LOCAL_PORT` in background.js, `--port` in the install script).

## Architecture

**background.js** - Service worker containing extension logic:
- Manages three states: OFF, DEV, PREVIEW (per root domain, persisted in `chrome.storage.local.domainStates`; unknown/legacy values such as `prod` normalize to OFF)
- Sets/removes cookie `htm-dev-mode=4815162342` on `.on24.com`
- `syncRules()` rebuilds the **entire** DNR dynamic rule set from `domainStates` + `settings` whenever either changes (`chrome.storage.onChanged`), on install/startup and on worker start. Rule IDs are assigned sequentially on every rebuild.
- Generates dynamic badge icons using OffscreenCanvas
- Auto-reloads the tab when state changes

**options.html / options.js** - Settings page (gear icon in popup, or chrome://extensions → Details → Extension options):
- Any number of Map Local and Rewrite rules, each with enabled flag and the modes it applies to
- Validates regexes with `chrome.declarativeNetRequest.isRegexSupported`, writes `chrome.storage.local.settings`
- Shows the `serve.js` command per Map Local rule and a live health dot

**popup.html / popup.js** - Dropdown menu UI:
- Styled dark theme dropdown with three options, gear button to settings
- Shows local server status when the active mode uses Map Local rules
- Communicates with background.js via chrome.runtime.sendMessage

**content.js** - Content script (`document_start`, top frame only):
- Asks background whether the current domain's mode uses Map Local; if so, does one `fetch(http://127.0.0.1:4815/__health, { targetAddressSpace: 'loopback' })`
- This triggers Chrome's Local Network Access permission prompt (Chrome 142+; permission `local-network-access`, `loopback-network` on 145+). Redirected sub-resources cannot trigger the prompt themselves and fail with "Permission was denied for this request to access the loopback address space"
- Reloads the page once when the permission flips to `granted`. Prompt-less alternative: policy `LocalNetworkAccessAllowedForUrls`

**local-server/serve.js** - Static file server for Map Local (see above)

**manifest.json** - Extension configuration (Manifest V3):
- Permissions: `cookies`, `declarativeNetRequest`, `tabs`, `webNavigation`, `storage`
- Host permissions: `<all_urls>` (needed for redirects to 127.0.0.1 and header modification)

## Key Implementation Details

**States:**
| State | Icon | Label | Cookie | Cache | Rules |
|-------|------|-------|--------|-------|-------|
| OFF | Gray | OFF | deleted | enabled | none |
| DEV | Green | DEV | SET (`htm-dev-mode=4815162342`) | disabled | rules whose `modes` include `dev` |
| PREVIEW | Yellow | PRE | deleted | disabled | rules whose `modes` include `preview` |

**Settings model** (`chrome.storage.local.settings`, seeded from `DEFAULT_SETTINGS` in background.js when missing):
```js
{
  mapLocal: [{ id, enabled, pattern: 'https://*/view/orion/*', localPath: '/Users/jnova/Projects/orion/static', modes: ['dev','preview'] }],
  rewrites: [{ id, enabled, regex: '/(.*)/dist/production-(css|js)-(.*).(css|js)(.*)', replacement: '/$1/dist/production-$2.$4', modes: ['preview'] }]
}
```

**DNR rules generated per active domain** (`background.js` `syncRules()`):
- No-cache request headers (priority 1, `requestDomains`)
- Rewrite: `regexFilter` → `redirect.regexSubstitution` (priority 3). Matched span is replaced; `$n` → `\n`
- Map Local: glob → anchored RE2 (`*` = capture group) → `http://127.0.0.1:4815/m/<ruleId>/\<last group>` (priority 2)
- Rewrite and Map Local rules are emitted twice: scoped by `initiatorDomains` (page sub-resources) and `requestDomains` (direct navigation)
- Chrome re-evaluates redirected requests, so Rewrite → Map Local chains (`production-js-<hash>.js` → `production-js.js` → local file)
- CSP / CSP-Report-Only response headers removed on `main_frame`/`sub_frame` of domains with an active Map Local rule
- Permissive CORS / CORP response headers set on `http://127.0.0.1:4815/` responses

**UI Features:**
- Dark theme popup with animated menu items, click ripple, active indicator
- Options page shares the popup's theme tokens
