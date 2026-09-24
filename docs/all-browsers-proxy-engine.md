# Dev Mode for every browser: local MITM proxy engine (design)

Design document written 2026-09-24. Status: **not implemented**; the Chrome extension and `npm run install-service` remain the working setup. See the FAQ for the decisions taken with the user.

## FAQ (answers already given to the user, kept for the doc)

- **VPNs (FortiClient, Surfshark, …):** no conflict. The proxy is an HTTP proxy on loopback; its upstream connections are routed and DNS-resolved through the active VPN like the browser's own. Caveats: the PAC must be set on every network service (`setup.sh` does all enabled ones; a service created at connect time needs `npm run proxy-refresh`); a corporate client that pushes its own proxy/PAC can overwrite ours → optional `upstreamProxy` setting (`settings.upstreamProxy = 'http://host:port'`) so the proxy chains to theirs (plain `CONNECT` through the upstream for tunnels, absolute-URI requests for plain HTTP).
- **Local app:** a Node process (`serve.js`, registered as a launchd agent but started on demand via the generated "Dev Mode.app" launcher, optionally at login). No menu bar; the web UI at `http://127.0.0.1:4815/` is the only control surface.
- **Cookie:** request `Cookie` header rewritten (server-side parity) + `Set-Cookie` on HTML responses (page-side parity); stripped/expired in OFF and PREVIEW.
- **Globals:** `<script>` inserted first in `<head>` of every HTML document (iframes included), same locked-accessor code, compressed responses handled, CSP nonce added.
- **Map Local / rewrites:** same rule model, same order (rewrite → map local), files served straight from disk, HTML documents included.
- **Minimal configuration (DEFAULT, user decision):** the PAC sends every non-loopback host to the proxy, no host list needed. With all domains OFF everything is tunneled untouched (no decryption, no cost). With any domain in DEV/PREVIEW, hosts are MITMed and the active mode applies everywhere (own domain → its mode; else Referer/Origin root domain; else the single non-off mode). Hosts in `excludeHosts` (seeded with Apple/Microsoft/Google-update domains, editable in the UI) always go DIRECT, because pinned system services would break while a mode is on. `scopedProxy: true` is the optional optimization that limits the PAC to configured domains + `assetHosts`. Cost while a mode is on: HTTP/1.1 for all sites.
- **Chrome extension:** removed entirely (user decision). The repo becomes the local server only; every browser, Chrome included, switches modes from the web UI at `http://127.0.0.1:4815/`. No toolbar badge anywhere (a menu-bar app could be added later, out of scope).
- **"Dev Mode started debugging this browser" bar:** gone; `chrome.debugger` is no longer used anywhere.
- **Which browsers:** any browser honoring the macOS system proxy: Chrome, Safari, Edge, Brave, Arc, Opera, Vivaldi, Firefox (default "Use system proxy settings"). Not: browsers manually pointed at another proxy, Tor Browser.
- **Certificate:** one-time install of a locally generated CA is unavoidable for HTTPS interception (same as Charles/Proxyman). Key stays in `~/.devmode-serve/`. The UI "Trust certificate" button installs it with one native password prompt; Firefox gets its preference written by the "Configure Firefox" button. Without it HTTPS errors appear only while a mode is on.
- **Daily use / commands:** none. One-time `npm run setup` (installs the launchd agent, creates the "Dev Mode" launcher app and opens the UI); trust, system proxy, Firefox, uninstall are buttons in the UI with native macOS dialogs. On/Off never touches VPN or network settings (see next bullet). A per-browser checklist verifies proxy + certificate live in whichever browser the page is opened in.
- **On/Off = start/stop the process (user decision):** the user wants nothing running when unused (note: an idle Node process is ~30-40 MB RAM, 0% CPU; the choice is about principle, not measured cost). **Off** button: the server persists state and exits; launchd does not restart it (`KeepAlive: false`, `RunAtLoad: false` by default). With the server down the PAC URL is unreachable and macOS/browsers fall back to direct connections: nothing runs, nothing intercepts. **On**: setup creates `/Applications/Dev Mode.app` with the built-in `osacompile` (AppleScript: `launchctl kickstart gui/<uid>/com.devmode.serve` then `open http://127.0.0.1:4815/`), so a Dock/Spotlight icon starts the service and opens the UI; `npm run serve` is the terminal equivalent. Optional **auto-quit** after N minutes with every domain OFF (`settings.autoQuitMinutes`, default 0 = disabled). "Start at login" is an optional checklist item, off by default. Caveat: the system proxy keeps pointing at the PAC URL while the server is down; browsers treat an unreachable PAC as "no proxy" but the first request after a stop may stall briefly while they find out. Disabling the system proxy on every Off is not done because it needs an admin password each time.
- **Global or per browser:** global. All state lives in the server, so mode, cookie, Map Local, rewrites and globals apply to every browser at once; switching DEV in Safari also affects Chrome and Firefox. Per-browser modes are not planned (possible later via User-Agent, which the proxy sees after decryption).
- **Status (2026-09-24):** design only, nothing implemented. The current Chrome extension and `npm run install-service` remain the working setup until this plan is executed.

## Context

The extension gives four things on on24.com domains: the `htm-dev-mode` cookie (DEV), no-cache headers (DEV/PREVIEW), transparent rewrites + Map Local (via `chrome.debugger` Fetch domain), and window globals injected before page JS (via `chrome.userScripts`). The user needs the same behaviour in **Chrome-family, Firefox and Safari** with full parity.

An extension port cannot deliver that: Safari has no blocking `webRequest`, no body replacement, and unreliable DNR regex redirects; Firefox would need a second interception engine. The chosen direction is to move the engine into the existing zero-dependency Node local server (`local-server/serve.js`, port 4815, launchd agent `com.devmode.serve`) as an HTTPS-intercepting proxy scoped by a PAC file. Every browser follows the macOS system proxy and is controlled from the server's web UI; the Chrome extension is retired.

User decisions already taken: the Chrome extension is **removed entirely** once the proxy works (git history keeps it); the proxy handles **every host by default** with no host list to maintain; `orionqa.akamaized.net` is the only seeded `assetHosts` entry (only relevant in the optional scoped mode).

Environment facts (verified): Node 24 (has `zlib.brotliDecompressSync`/`zstdDecompressSync`; `node:crypto` cannot sign X.509), `/usr/bin/openssl` (LibreSSL) and Homebrew OpenSSL 3.6 present, network services `Wi-Fi`, `Thunderbolt Bridge`, `VPN` (no auto-proxy set today), launchd agent currently running, Firefox installed but never launched, `~/.devmode-serve.json` = `{ mounts: { 'ml-orion': '/Users/jnova/Projects/orion/static' } }`. Git history shows an early version used `chrome.proxy` → `127.0.0.1:8888` (commit `562d6a6`), so this is a return to a proxy design, now self-hosted.

## Key design decisions

| # | Decision | Why |
|---|---|---|
| D1 | **One port 4815** serves UI/API/`/m/` (relative URLs), plain HTTP proxying (absolute URIs) and `CONNECT` (TLS MITM or tunnel). | One service, one known port; Node's `http.Server` already splits `request`/`connect`/`upgrade`. `req.url[0] === '/'` → local, else proxy. |
| D2 | Certs minted by shelling out to **`/usr/bin/openssl`** (`execFileSync`), zero npm deps. One CA + one shared leaf key; per-host leaf cert cached on disk and in memory. | `node:crypto` cannot sign certs; hand-rolled DER is risky. Absolute path because launchd's PATH is empty. |
| D3 | Mode for a request: own configured domain → its mode; else Referer/Origin root domain's mode; else the single non-off mode across domains; else OFF. Optional `assetHosts` per domain only matter in scoped mode. | With proxy-all there is no host list to maintain; CSS-loaded fonts/images carry the CDN as Referer, and the single-active-mode fallback covers the rest. |
| D4 | DEV cookie: rewrite the **request `Cookie` header** (authoritative) and **sync the browser jar** via `Set-Cookie` on HTML responses (DEV: set; OFF/PREVIEW: expire when present). | Exact server parity with no navigation race; `document.cookie` stays consistent for page JS. |
| D5 | **Proxy-all PAC by default** (user decision): every non-loopback host except `excludeHosts` → `PROXY 127.0.0.1:4815; DIRECT`. CONNECT tunnels everything while all domains are OFF and MITMs everything while any domain is DEV/PREVIEW. `scopedProxy` (optional) limits the PAC to configured domains + `assetHosts` + `extraProxyHosts`. | Zero configuration; PAC content never depends on the mode so toggling never needs a PAC refresh; `; DIRECT` keeps browsing alive if the server is down. |
| D6 | Extension **deleted** entirely in the last phase (user decision): `manifest.json`, `background.js`, `popup.*`, `options.*`, `icons/`. | One engine, one UI, no browser-specific code. |
| D7 | The **server web UI** (`http://127.0.0.1:4815/`) is the only UI: mode switcher on top, then globals, rules, status. | Same page in every browser. |
| D8 | Rules live in `local-server/rules.js` (pure functions moved from `background.js`, `node --test`able). | Nothing else evaluates rules any more. |
| D9 | HTML injection: send `Accept-Encoding: identity` upstream for document requests on domains with globals, plus a sync-zlib decompress fallback (gzip/deflate/br/zstd). Response sent identity with recomputed `Content-Length`. | Avoids decompression in the common case. |

## File layout

```
local-server/
  serve.js            entry: args (--port/--host/--init-ca/--print-pac), state load, CA init, one http server,
                      wires request/connect/upgrade
  state.js            ~/.devmode-serve.json v2 load/save (atomic tmp+rename, 0600), migration from { mounts },
                      DEFAULT_SETTINGS (moved from background.js:22-37), change listeners
  rules.js            pure functions moved from background.js: normalizeState, extractDomain (:99), globToRegex (:225),
                      applyRewrites (:233), mapLocalMatch (from mapLocalTarget :243, returns { rule, relPath }),
                      buildGlobalsCode (:165), resolveMode(host, headers, state), hostInScope(host, state)
  ca.js               ensureCa(), certFor(host), secureContextFor(host), caTrusted()
  actions.js          trustCa(), enableSystemProxy()/disableSystemProxy() (osascript admin dialog), installService(),
                      configureFirefox(), uninstall(); checklist() gathers every status; used by api.js and CLI flags
  proxy.js            proxyRequest / handleConnect / proxyUpgrade, upstream via http/https.request, hop-by-hop hygiene
  transform.js        applyCookie, syncCookieJar, applyNoCache, noStoreResponse, injectGlobals, decompressBody
  static.js           MIME table + traversal guard + index.html + streaming (extracted from serve.js:20-46,169-195)
  api.js              /__health /__state /__settings /__globals /__ca.pem /proxy.pac /__config(legacy) + UI
  pac.js              buildPac(state)
  ui/index.html, ui/ui.js   web UI (ported options.html/js + domain modes + globals + status/setup)
  test/rules.test.js, test/transform.test.js   node --test
  install-launchd.sh  existing; add EnvironmentVariables PATH and --restart (launchctl kickstart -k)
  setup.sh            NEW (thin): launchd install + "Dev Mode.app" launcher + open UI; --uninstall / --purge
  DevMode.applescript source for the launcher app (osacompile)
manifest.json, background.js, popup.*, options.*, icons/   DELETED in phase 8 (popup/options CSS + render code ported to ui/ first)
package.json          scripts: setup, uninstall, serve, restart-service, proxy-refresh, test
CLAUDE.md, README.md  rewritten for the new architecture (setup, browsers, trust, troubleshooting)
```

## Data model: `~/.devmode-serve.json` v2

```js
{
  version: 2,
  domains: { '.on24.com': { mode: 'off'|'dev'|'preview', assetHosts: ['orionqa.akamaized.net'] } },
  globals: { '.on24.com': [{ name, value }] },                 // unchanged shape
  settings: { mapLocal: [...], rewrites: [...],                // unchanged shapes (DEFAULT_SETTINGS)
              autoQuitMinutes: 0,                                     // >0: exit after all domains OFF for that long
              startAtLogin: false,                                    // checklist item; sets RunAtLoad in the plist
              scopedProxy: false,                                     // default: proxy every host
              excludeHosts: ['*.apple.com', '*.icloud.com', '*.mzstatic.com', '*.microsoft.com', '*.gvt1.com', 'clients*.google.com'],
              extraProxyHosts: [], upstreamProxy: '' },                 // upstreamProxy: chain to a VPN/corporate proxy
}
```
Migration: file without `version` → v2 with `domains` seeded `{ '.on24.com': { mode: 'off', assetHosts: ['orionqa.akamaized.net'] } }`, settings = defaults, old `mounts` folded into `mapLocal[].localPath` where ids match. `mounts` for the legacy `/m/` route are derived from `mapLocal`. Secrets in `~/.devmode-serve/`: `ca.key` (0600), `ca.pem`, `leaf.key`, `certs/<host>.pem`.

## HTTP API (127.0.0.1:4815)

| Route | Method | Notes |
|---|---|---|
| `/__health` | GET | `{ ok, version, port, ca: { exists, sha256, trusted }, proxy: { pacUrl, services: [{ name, enabled, url }] }, mounts }` (trusted/services via `execFile`, cached 30 s) |
| `/__state` | GET / POST / DELETE | GET `?url=` → `{ domain, mode, globals }`; POST `{ domain|url, mode, assetHosts? }` |
| `/__settings` | GET / POST | server-side validation mirroring `options.js:192-222` → 400 `{ errors }` |
| `/__globals` | GET / POST | `?domain=` / `{ domain, globals }`; normalization from `background.js:607-616` |
| `/__ca.pem` | GET | download CA |
| `/proxy.pac` | GET | `application/x-ns-proxy-autoconfig`, no-store |
| `/m/<id>/…` | GET/HEAD | legacy static route, unchanged |
| `/__config` | POST | legacy, kept until phase 8 |
| `/`, `/ui.js` | GET | web UI |

Security: bind 127.0.0.1; local routes require `Host` ∈ {`127.0.0.1:4815`, `localhost:4815`} (DNS rebinding); mutating `/__*` calls require header `X-DevMode: 1` and same-origin (`Origin`/`Sec-Fetch-Site` check); no CORS on `/__*` (the UI is same-origin); `/m/` and `/__health` keep today's permissive `BASE_HEADERS` (serve.js:90-99). Proxy refuses loopback:4815 targets (loop guard). `/__config` and the old `chrome-extension://` Origin check stay only until phase 8.

## PAC (`pac.js`)

```js
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'DIRECT';
  if (shExpMatch(host, '*.apple.com') || /* … each excludeHosts entry */) return 'DIRECT';
  // default (scopedProxy: false):
  return 'PROXY 127.0.0.1:4815; DIRECT';
  // scopedProxy: true instead emits one line per configured domain / assetHost / extraProxyHost:
  //   if (dnsDomainIs(host, '.on24.com') || host === 'on24.com') return 'PROXY 127.0.0.1:4815; DIRECT';
  //   if (shExpMatch(host, 'orionqa.akamaized.net')) return 'PROXY 127.0.0.1:4815; DIRECT';
  //   return 'DIRECT';
}
```
`hostInScope()` in `rules.js` drives both the PAC and the CONNECT decision so they never disagree. CONNECT: excluded or out-of-scope host → tunnel; in scope and every domain OFF → tunnel; in scope and any domain DEV/PREVIEW → MITM. With `upstreamProxy` set, tunnels and upstream requests go through that proxy instead of directly.

## Certificates (`ca.js`)

- `ensureCa()`: `openssl genrsa -out ca.key 2048`; `openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=Dev Mode Local CA/O=devmode-serve" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -addext "subjectKeyIdentifier=hash" -out ca.pem`; `openssl genrsa -out leaf.key 2048`.
- `certFor(host)` (host validated `/^[a-z0-9.-]+$/i`): CSR from `leaf.key` with `/CN=<host>`; extfile `basicConstraints=CA:FALSE`, `keyUsage=digitalSignature,keyEncipherment`, `extendedKeyUsage=serverAuth`, `subjectAltName=DNS:<host>` (or `IP:`), `authorityKeyIdentifier=keyid`, `subjectKeyIdentifier=hash`; `openssl x509 -req -CA ca.pem -CAkey ca.key -set_serial 0x<random 16 bytes> -days 397 -sha256 -extfile …`. Reuse cached cert while > 7 days valid. (Apple rules: SAN, EKU serverAuth, ≤825 days, RSA ≥2048, SHA-256.)
- `secureContextFor(host)`: memoized `tls.createSecureContext({ key: leafKey, cert: leaf + ca })` for the SNI callback.
- `caTrusted()`: `/usr/bin/security verify-cert -c <leaf.pem> -L -R offline` exit 0, cached 60 s.
- Trust: `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ca.pem` (user keychain, GUI password prompt). Firefox: `security.enterprise_roots.enabled=true`.

## Proxy flow (`proxy.js`)

```
'request':  url starts with '/'      → api/ui/static
            url starts with 'http://' → proxyRequest(req, res, url)
'connect':  host loopback:4815 → 403
            !hostInScope(host) → net.connect tunnel, '200 Connection Established', pipe both ways (+head)
            else → '200 Connection Established'; unshift(head); mitmServer.emit('connection', socket)
   mitmServer = https.createServer({ SNICallback: (n, cb) => cb(null, secureContextFor(n || socket.connectHost)),
                                     ALPNProtocols: ['http/1.1'] }, (req, res) => proxyRequest(...))   // never listen()ed
'upgrade' (both servers) → proxyUpgrade: https.request with Upgrade headers, on 'upgrade' write status+headers, pipe both ways

proxyRequest(req, res, url):
  ctx = resolveMode(host, headers, state)          // { domain, mode, kind: own|asset|referer|global|none }
  target = mode!=='off' ? applyRewrites(url, settings, mode) : url
  if mode!=='off' && (hit = mapLocalMatch(target)) && file exists →
      serveFile(res, file, { Cache-Control: no-store, X-Dev-Mode: '<mode>; map-local', CORS echo of Origin }); return
      (missing file → log once, fall through with original url, parity with background.js:488-489)
  headers = clone minus hop-by-hop (connection, proxy-connection, keep-alive, te, trailer, transfer-encoding,
            proxy-authorization, upgrade); host = target host
  kind==='own'  → transform.applyCookie(headers, ctx)                         // D4 request side
  mode!=='off'  → transform.applyNoCache(headers)                              // drop If-None-Match/If-Modified-Since/If-Range; no-cache
  wantsInject = kind==='own' && globals[domain]?.length && isDocumentRequest(req)   // Sec-Fetch-Dest document|iframe|frame, else Accept: text/html
  wantsInject → headers['accept-encoding'] = 'identity'
  up = (https|http).request(target, { method, headers, agent: keepAlive, rejectUnauthorized: true }); req.pipe(up)
  on response:
     rh = headers minus hop-by-hop
     mode!=='off'                       → noStoreResponse(rh)   // Cache-Control: no-store; drop etag/last-modified/expires/age
     kind==='own' && document response  → syncCookieJar(rh, ctx, hadCookie)   // D4 response side
     rh['x-dev-mode'] = `${mode}; ${kind}` (+ '; rewrite' when target !== url)
     wantsInject && text/html && len <= 8 MB → buffer, decompressBody, injectGlobals(html, buildGlobalsCode(list), csp),
                                               drop content-encoding, set content-length, write
     else → writeHead + pipe (streaming)
  upstream error → 502 text; client abort → up.destroy()
```

`resolveMode`: (1) `domains[extractDomain(host)]` → `own`; (2) domain whose `assetHosts` glob-matches host (tie-break by Referer/Origin root domain, then first non-off) → `asset`; (3) `domains[extractDomain(Referer|Origin host)]` → `referer`; (4) exactly one non-off mode across domains → `global`; (5) `{ mode: 'off', kind: 'none' }`. Only `own` gets the cookie and globals; rewrites, map-local and no-cache apply to every kind.

## Transforms (`transform.js`)

- **Cookie** (`own` only): request: parse `Cookie`, DEV → set/replace `htm-dev-mode=4815162342`, else drop it; remember `hadCookie`. Response (documents only): DEV && !hadCookie → `Set-Cookie: htm-dev-mode=4815162342; Domain=on24.com; Path=/; Secure; SameSite=None; Max-Age=31536000`; OFF/PREVIEW && hadCookie → same with `Max-Age=0`. Preserve existing `set-cookie` arrays.
- **No-cache** (any non-off mode, incl. asset hosts): as above.
- **Globals** `injectGlobals(html, code, cspHeader)`: tag `<script data-devmode="globals"[ nonce]>code</script>`, `code` = `buildGlobalsCode` output with `</` → `<\/` and non-ASCII → `\uXXXX`. Insert after first `<head…>`, else after `<html…>`, else after `<!doctype…>`, else prepend. CSP: pick `script-src-elem` > `script-src` > `default-src`; if it already allows inline (`'unsafe-inline'` w/o nonce/hash/strict-dynamic) do nothing; else append `'nonce-<16B base64>'` and set attribute; same for `<meta http-equiv="Content-Security-Policy">`. Iframes need nothing special (each frame is its own response). `decompressBody`: gzip/x-gzip → gunzip, deflate → inflate (raw fallback), br → brotli, zstd → zstd, unknown → skip injection and pipe original.

## Extension removal (phase 8)

- Delete `manifest.json`, `background.js`, `popup.html`, `popup.js`, `options.html`, `options.js`, `icons/`. Before deleting, port what the UI reuses: popup theme tokens and the mode buttons (`popup.html`), globals rows (`popup.html:370-380`), options render/validate code (`options.js:20-172`) with `chrome.storage` → `fetch('/__settings')`, and the pure rule functions from `background.js` (already moved in phase 1).
- No automatic migration of `chrome.storage.local` is possible without the extension. The seeded defaults equal today's real rules (`DEFAULT_SETTINGS`); the user re-enters globals in the web UI once. Document this in the changelog.
- Remove the extension from `chrome://extensions` manually (documented in README).

## Onboarding and per-browser checklist (no terminal in daily use)

User requirement: minimal, GUI-driven; certificate and proxy handled from the UI; starting/stopping the proxy must never interfere with VPNs.

- **First run:** `npm run setup` only installs the launchd agent (user-level `launchctl bootstrap`, no admin) and opens `http://127.0.0.1:4815/`. Also shipped as a double-clickable `Dev Mode Setup.command`. Everything else happens in the UI.
- **Off button (top of the UI):** `POST /__actions/quit` → server persists state, closes listeners and exits; launchd does not restart it. The macOS auto-proxy URL stays configured; an unreachable PAC means direct connections. No password prompt, no system change, VPN settings never touched. **On:** `/Applications/Dev Mode.app` (generated by setup via `osacompile`) runs `launchctl kickstart gui/<uid>/com.devmode.serve` and opens the UI; also `npm run serve`. Optional auto-quit (`settings.autoQuitMinutes`) when every domain has been OFF that long.
- **Checklist card**, system-level items with a button next to any ✘:
  1. Service installed (`launchctl print gui/<uid>/com.devmode.serve`) → "Install service" (user-level, no prompt); "Start at login" checkbox (rewrites the plist's `RunAtLoad`); "Dev Mode.app" present in /Applications → "Create launcher" (`osacompile`).
  2. CA generated (`~/.devmode-serve/ca.pem`) → automatic on server start.
  3. CA trusted in login keychain (`security verify-cert`) → "Trust certificate": server runs `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ca.pem`; macOS shows its native password dialog (the agent runs in the user's GUI session, so the dialog appears). Once.
  4. System proxy set on every enabled network service (`networksetup -getautoproxyurl` per service, incl. the VPN service) → "Enable system proxy" / "Disable": server runs `networksetup -setautoproxyurl … && -setautoproxystate … on` through `osascript -e 'do shell script "…" with administrator privileges'`, which shows the native admin dialog. Once at setup, once at uninstall. Re-shown as ✘ with "Fix" when a VPN client overwrites it.
  5. Firefox (only if `/Applications/Firefox.app` exists): `security.enterprise_roots.enabled` present in every profile's `user.js` → "Configure Firefox" writes `user_pref("security.enterprise_roots.enabled", true);` into each profile (Firefox never overwrites `user.js`; takes effect on next Firefox start) and tells the user to restart Firefox.
- **This-browser live probe** (the row that makes the checklist per browser): the page, open in any browser, does two fetches to a reserved probe host that DNS never resolves, e.g. `probe.devmode.invalid`. The PAC always routes it to the proxy and the proxy answers it itself (never upstream):
  - `http://probe.devmode.invalid/__probe` succeeds only if **this browser** is using the proxy → "Proxy ✔/✘" (✘ → hints: enable system proxy / browser is using its own proxy settings / restart browser to refetch PAC).
  - `https://probe.devmode.invalid/__probe` succeeds only if this browser also **trusts the CA** → "Certificate ✔/✘" (✘ in Firefox → "Configure Firefox + restart"; elsewhere → "Trust certificate").
  - Result shown as "This browser: <UA name> — Proxy ✔ Certificate ✔". The user opens the same URL once in Chrome, Safari, Firefox, Edge… and each shows its own row; the server remembers the last result per browser name (`/__probe` posts back UA + outcome) so the card lists all browsers seen with their status.
- **Detected browsers list:** `/Applications/*.app` scan for Chrome, Chromium, Edge, Brave, Arc, Opera, Vivaldi, Firefox, Safari → rows "not verified yet — open this page in <browser>" with an "Open" button (`open -a "<Browser>" http://127.0.0.1:4815/`) until the probe has run there.
- **Uninstall** button: disable system proxy (admin dialog), remove the launchd agent, optionally delete the CA from the keychain (confirm), keep config unless "also delete settings" is ticked.
- New API: `GET /__checklist` (all items + last probe per browser), `POST /__actions/<trust-ca|enable-proxy|disable-proxy|install-service|configure-firefox|uninstall>` (long-running, returns `{ ok, error }`; each requires `X-DevMode: 1` + same-origin), `GET /__probe` (served on the probe host for both http and https, `Cache-Control: no-store`, CORS `Access-Control-Allow-Origin: http://127.0.0.1:4815`).
- VPN interaction guarantees: the toggle and the mode switches never touch network services; only steps 4 and Uninstall do, and only the auto-proxy fields (never DNS, routes or VPN configs).

## Web UI (`local-server/ui/`)

Same tokens as `popup.html`/`options.html`. Sections, top to bottom: **Mode switcher** (per domain: `domain | OFF/DEV/PREVIEW segmented control | ×`, add domain normalized to `.root.tld`; the primary control, styled like the popup); **Status** (server version, CA trusted + download link + trust command, PAC status per network service, Firefox hint, recent TLS failures per host with an "exclude" button); **Globals** per domain (rows as in the popup); **Map Local** and **Rewrites** cards; **Advanced** (`scopedProxy`, `assetHosts`, `extraProxyHosts`, `excludeHosts`, `upstreamProxy`, view PAC, note that PAC-affecting changes need `npm run proxy-refresh`). The page polls `/__health` every few seconds like `options.js:102` does today.

## Setup / uninstall

`local-server/setup.sh` (thin): `install-launchd.sh --port 4815` (plist gets `EnvironmentVariables.PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `RunAtLoad`/`KeepAlive` false unless `startAtLogin`), generate `/Applications/Dev Mode.app` with `osacompile -o` from `local-server/DevMode.applescript` (kickstart + open UI), start the service once, wait for `/__health`, `open http://127.0.0.1:4815/`. The CA is generated on first server start; trust, system proxy and Firefox are handled by the checklist UI (native dialogs). The same actions exist as CLI flags for scripting/CI-less power users: `node serve.js --trust-ca | --enable-proxy | --disable-proxy | --configure-firefox` (the UI buttons call the same `actions.js` functions).
`--uninstall`: same as the UI Uninstall button; keep config and CA unless `--purge`.
`package.json` scripts: `setup`, `uninstall`, `serve`, `restart-service`, `proxy-refresh` (autoproxystate off→on per service, admin dialog), `test` (`node --test local-server/test`).

## Implementation phases (each testable; phases 1-7 leave the current extension working)

1. **Server refactor + state + API + UI**: split `serve.js` into `state.js`/`static.js`/`api.js`/`rules.js`; v2 migration; keep `/__config` and `/m/`; ship `ui/`. Test: `node --test`, curl each `/__*`, old extension still maps locally.
2. **CA**: `ca.js`, `--init-ca`, `/__ca.pem`, `caTrusted()`. Test: `openssl x509 -text`, `openssl verify -CAfile`.
3. **Proxy skeleton + PAC**: absolute-URI proxying, CONNECT tunnel for all hosts, `pac.js`. Test: curl via proxy for http and https, fetch `/proxy.pac`.
4. **TLS MITM**: `mitmServer` + SNI for in-scope hosts, WebSocket upgrade, hop-by-hop hygiene, `x-dev-mode` header. Test: `curl --proxy … --cacert ca.pem -sI https://gatewayqa.on24.com/`.
5. **Mode transforms**: `resolveMode`, cookie, no-cache, rewrites, map-local from disk.
6. **Globals injection**: `injectGlobals`, decompress fallback, CSP nonce, `Sec-Fetch-Dest` gating; unit fixtures.
7. **System integration + checklist**: `actions.js` (trust CA, enable/disable proxy via osascript admin dialog, install service, configure Firefox, uninstall), `/__checklist`, `/__actions/*`, probe host + `/__probe`, checklist card and per-browser rows in the UI, thin `setup.sh`; verify in Chrome, Safari, Firefox that each shows "Proxy ✔ Certificate ✔".
8. **Extension removal + cleanup**: delete `manifest.json`, `background.js`, `popup.*`, `options.*`, `icons/`; remove `/__config` and the `chrome-extension://` origin check; rewrite `CLAUDE.md` and `README.md`; bump `package.json` to 2.0.0.

## Verification

Shell (`PROXY="--proxy http://127.0.0.1:4815 --cacert ~/.devmode-serve/ca.pem"`):
- `curl -s http://127.0.0.1:4815/__health | jq`; POST `/__state` with `X-DevMode: 1` works, without it → 403.
- `/proxy.pac`: DIRECT for loopback and each `excludeHosts` entry, PROXY for everything else; with `scopedProxy: true` it lists only on24 + `orionqa.akamaized.net`.
- DEV: `curl $PROXY -sv https://gatewayqa.on24.com/ -o /dev/null 2>&1 | grep -iE 'x-dev-mode|set-cookie'` → `Set-Cookie: htm-dev-mode=…`; OFF with `-H 'Cookie: htm-dev-mode=4815162342'` → `Max-Age=0`.
- Request-side cookie/no-cache: temporary rewrite to `https://httpbin.org/headers` (or a local echo host in `extraProxyHosts`) shows the cookie and no `If-None-Match`.
- PREVIEW: `curl $PROXY -sI https://orionqa.akamaized.net/view/orion/labs/dist/production-js-abc123.js -H 'Referer: https://gatewayqa.on24.com/'` → `x-dev-mode: preview; asset; map-local`, `content-type: text/javascript`; missing file → upstream response.
- Globals: `curl $PROXY -s https://gatewayqa.on24.com/ -H 'Sec-Fetch-Dest: document' | grep -c 'data-devmode="globals"'` → 1, also with `-H 'Accept-Encoding: br'`; CSP header gains `'nonce-…'`.
- Large asset size via proxy equals direct download; `security verify-cert -c certs/gatewayqa.on24.com.pem -L -R offline` exits 0.

Browsers:
- Chrome: `chrome://net-internals/#proxy` shows the PAC; Network panel shows `x-dev-mode`; `document.cookie` has `htm-dev-mode` in DEV; `window.isNurturePage` overridden; no debugging bar; extension uninstalled.
- Proxy-all sanity: with all domains OFF, unrelated HTTPS sites load with their original certificates (tunneled); with DEV on, `https://example.com` shows the "Dev Mode Local CA" chain and Apple services (App Store, iCloud sync) keep working thanks to `excludeHosts`.
- Safari: Web Inspector Network shows `x-dev-mode`, no certificate warning, globals present.
- Firefox: Network Settings = "Use system proxy settings", `security.enterprise_roots.enabled` true, CA listed in `about:certificates`; same checks; mode switched from the web UI.
- All: switching mode in the web UI + reload flips cookie/injection with no extension involved. Also verify the known QA 404-on-reload quirk (CLAUDE.md) is not made worse.

## Risks

- HTTP/1.1 on both legs (`ALPNProtocols: ['http/1.1']`): dev-only perf cost. HSTS fine with trusted CA; browsers skip pinning for local roots.
- Apple cert rules: keep the extfile exactly as specified or Safari shows "certificate not valid" while curl works.
- PAC caching: exclude-list or scope changes need `npm run proxy-refresh`; Chrome remembers a failed proxy ~5 min (`chrome://net-internals/#proxy` → clear bad proxies). Server stopped (Off) → PAC unreachable → browsers go direct after a short detection delay.
- Proxy-all + a mode on: every app honoring the system proxy is MITMed; certificate-pinned ones (Apple services, some Electron apps) fail until added to `excludeHosts` or the mode is switched OFF. The seeded exclude list covers the known system hosts; the web UI shows recent TLS failures per host with an "exclude" button.
- Keychain trust and `networksetup` prompt for a password; the VPN service must be included or the proxy is bypassed while the VPN is up.
- Only HTML documents needing injection are buffered (8 MB cap); everything else streams.
- No badge in any browser; the web UI (and the `x-dev-mode` response header) is the indicator. A macOS menu-bar app could be added later, out of scope.
