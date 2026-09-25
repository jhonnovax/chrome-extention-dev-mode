# Dev Mode for every browser: local MITM proxy engine + Chrome extension (design)

Design document written 2026-09-24, revised the same day after the decision to **keep the Chrome extension**. Status: **not implemented**; the current Chrome extension (chrome.debugger engine) and `npm run install-service` remain the working setup. See the FAQ for the decisions taken with the user.

## FAQ (answers already given to the user, kept for the doc)

- **VPNs (FortiClient, Surfshark, …):** no conflict. The proxy is an HTTP proxy on loopback; its upstream connections are routed and DNS-resolved through the active VPN like the browser's own. Caveats: the PAC must be set on every network service (the checklist does all enabled ones; a service created at connect time needs `npm run proxy-refresh`); a corporate client that pushes its own proxy/PAC can overwrite ours → optional `upstreamProxy` setting (`settings.upstreamProxy = 'http://host:port'`) so the proxy chains to theirs (plain `CONNECT` through the upstream for tunnels, absolute-URI requests for plain HTTP). A VPN/corporate client that *inspects TLS* (its own CA) breaks the proxy's upstream verification → `settings.upstreamCaFile` (PEM added to the upstream agent's trust store).
- **Local app:** a Node process (`local-server/serve.js`, registered as a launchd agent `com.devmode.serve` but **started on demand**, see below). No menu bar. Two control surfaces: the Chrome extension popup (primary, Chrome only) and the web UI at `http://127.0.0.1:4815/` (every browser, settings, checklist).
- **Chrome extension: kept, as the Chrome UI client (user decision, revised).** Chrome is the primary browser; the extension keeps its badge and popup but no longer intercepts anything: `chrome.debugger`, `chrome.userScripts` and `declarativeNetRequest` are dropped. Chrome traffic goes through the proxy engine like every other browser; the extension configures Chrome's proxy itself with `chrome.proxy` (no macOS system-proxy change needed for Chrome), starts the server on demand and shows state. The repo keeps both: extension files at the root (so the loaded unpacked extension keeps its ID and storage), engine in `local-server/`.
- **State: the server owns it (user decision).** Modes, rules and globals live in `~/.devmode-serve.json` v2. The extension reads/writes them through the HTTP API and keeps a cached snapshot in `chrome.storage.local` only for display while the server is down. Switching DEV in the Chrome popup also switches Safari and Firefox; switching in Safari's web UI is picked up by the Chrome badge.
- **"Dev Mode started debugging this browser" bar:** gone; `chrome.debugger` is no longer used anywhere.
- **Cookie:** request `Cookie` header rewritten (server-side parity) + `Set-Cookie` on HTML responses (page-side parity); stripped/expired in OFF and PREVIEW. In Chrome the extension additionally removes the cookie with `chrome.cookies` when a domain goes OFF (exact and immediate).
- **Globals:** `<script>` inserted first in `<head>` of every HTML document (iframes included), same locked-accessor code, compressed responses handled, CSP nonce added.
- **Map Local / rewrites:** same rule model, same order (rewrite → map local), files served straight from disk, HTML documents included.
- **Minimal configuration (DEFAULT, user decision):** the PAC sends every non-loopback host to the proxy, no host list needed. With all domains OFF everything is tunneled untouched (no decryption). With any domain in DEV/PREVIEW, hosts are MITMed and the active mode applies everywhere (own domain → its mode; else Referer/Origin root domain; else the single non-off mode). Hosts in `excludeHosts` (seeded with Apple/Microsoft/Google-update domains, editable in the UI) always go DIRECT, because pinned system services would break while a mode is on. `scopedProxy: true` is the optional optimization that limits the PAC to configured domains + `assetHosts`. Cost while a mode is on: HTTP/1.1 for all sites.
- **Which browsers:** any browser honoring the macOS system proxy: Safari, Firefox (default "Use system proxy settings"), Edge, Brave, Arc, Opera, Vivaldi. Chrome is configured by the extension instead. Not: browsers manually pointed at another proxy, Tor Browser.
- **Certificate:** one-time install of a locally generated CA is unavoidable for HTTPS interception (same as Charles/Proxyman), Chrome included. Key stays in `~/.devmode-serve/`. The UI "Trust certificate" button installs it with one native password prompt (Chrome must be restarted once afterwards; it caches keychain trust); Firefox gets its preference written by the "Configure Firefox" button. Without it HTTPS errors appear only while a mode is on.
- **On/Off = start/stop the process, automatically (user decision, revised):** the user wants nothing running when unused and nothing to do besides the toggle. Switching any domain to DEV/PREVIEW in the Chrome popup **starts the server automatically**: a Chrome *native messaging host* (a tiny bash script Chrome launches on the extension's behalf, registered once by `npm run setup`) runs `launchctl kickstart` on the agent. When every domain is OFF the server **exits by itself** after a grace period (`idleQuitSeconds`, default 60) unless a web UI page is open in some browser. Modes are session state: the server always boots with every domain OFF. `Dev Mode.app` / `npm run serve` remain as starters for Safari/Firefox-only sessions. On/Off never touches VPN or network settings.
- **Daily use / commands:** none. One-time `npm run setup` (installs the launchd agent, registers the native messaging host for the extension, creates the "Dev Mode" launcher app and opens the UI); trust, system proxy, Firefox, uninstall are buttons in the UI with native macOS dialogs. A per-browser checklist verifies proxy + certificate live in whichever browser the page is opened in.
- **Global or per browser:** global. All state lives in the server, so mode, cookie, Map Local, rewrites and globals apply to every browser at once. Per-browser modes are not planned (possible later via User-Agent, which the proxy sees after decryption).
- **Status (2026-09-24):** design only, nothing implemented.

## Context

The extension gives four things on on24.com domains: the `htm-dev-mode` cookie (DEV), no-cache headers (DEV/PREVIEW), transparent rewrites + Map Local (via `chrome.debugger` Fetch domain), and window globals injected before page JS (via `chrome.userScripts`). The user needs the same behaviour in **Chrome-family, Firefox and Safari** with full parity, with Chrome as the primary browser and the others used occasionally.

An extension port cannot deliver that: Safari has no blocking `webRequest`, no body replacement, and unreliable DNR regex redirects; Firefox would need a second interception engine. The chosen direction is to move the engine into the existing zero-dependency Node local server (`local-server/serve.js`, port 4815, launchd agent `com.devmode.serve`) as an HTTPS-intercepting proxy scoped by a PAC file. Safari/Firefox follow the macOS system proxy and are controlled from the server's web UI; Chrome keeps the extension as its UI, which configures Chrome's proxy itself and starts the server on demand.

User decisions: the Chrome extension **stays** as Chrome's UI client and both parts live in this repo; the server **owns all state**; Chrome **uses the proxy engine too**; the server runs **on demand from the toggle** (auto-start, auto-quit); the proxy handles **every host by default** with no host list to maintain; `orionqa.akamaized.net` is the only seeded `assetHosts` entry (only relevant in the optional scoped mode).

Environment facts (verified): Node 24 at `/Users/jnova/.nvm/versions/node/v24.20.0/bin/node` (absolute path already in the plist; has `zlib.brotliDecompressSync`/`zstdDecompressSync`; `node:crypto` cannot sign X.509), `/usr/bin/openssl` (LibreSSL 3.3.6, supports `req -addext`) and Homebrew OpenSSL present, `/bin/bash` 3.2, network services `Wi-Fi`, `Thunderbolt Bridge`, `VPN` (no auto-proxy set today), launchd agent currently running with KeepAlive, `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` exists (holds a working reference host manifest), Chromium/Brave/Edge/Arc support folders exist, Chrome/Safari/Firefox installed (Firefox never launched), macOS TCC blocks reading Chrome's profile preferences from the terminal, `~/.devmode-serve.json` = `{ mounts: { 'ml-orion': '/Users/jnova/Projects/orion/static' } }`. Git history shows an early version used `chrome.proxy` → `127.0.0.1:8888` (commit `562d6a6`), so this is a return to a proxy design, now self-hosted.

## Key design decisions

| # | Decision | Why |
|---|---|---|
| D1 | **One port 4815** serves UI/API/`/m/` (relative URLs), plain HTTP proxying (absolute URIs) and `CONNECT` (TLS MITM or tunnel). | One service, one known port; Node's `http.Server` already splits `request`/`connect`/`upgrade`. `req.url[0] === '/'` → local, else proxy. |
| D2 | Certs minted by shelling out to **`/usr/bin/openssl`** (`execFileSync`), zero npm deps. One CA + one shared leaf key; per-host leaf cert cached on disk and in memory. | `node:crypto` cannot sign certs; hand-rolled DER is risky. Absolute path because launchd's PATH is minimal. |
| D3 | Mode for a request: own configured domain → its mode; else Referer/Origin root domain's mode; else the single non-off mode across domains; else OFF. Optional `assetHosts` per domain only matter in scoped mode. | With proxy-all there is no host list to maintain; CSS-loaded fonts/images carry the CDN as Referer, and the single-active-mode fallback covers the rest. |
| D4 | DEV cookie: rewrite the **request `Cookie` header** (authoritative) and **sync the browser jar** via `Set-Cookie` on HTML responses (DEV: set; OFF/PREVIEW: expire when present). Own domains stay MITMed while the server runs, even when OFF, so the expiry reaches Safari/Firefox during the grace period; Chrome removes it via `chrome.cookies`. | Exact server parity with no navigation race; `document.cookie` stays consistent for page JS. |
| D5 | **Proxy-all PAC by default** (user decision): every non-loopback host except `excludeHosts` → `PROXY 127.0.0.1:4815; DIRECT`. CONNECT tunnels everything while all domains are OFF and MITMs everything while any domain is DEV/PREVIEW. `scopedProxy` (optional) limits the PAC to configured domains + `assetHosts` + `extraProxyHosts` (+ the probe host). | Zero configuration; PAC content never depends on the mode so toggling never needs a PAC refresh; `; DIRECT` keeps browsing alive if the server is down. |
| D6 | **Server owns state**; the Chrome extension is a UI client over the HTTP API (badge, popup, launcher) with a display-only cache in `chrome.storage.local`. `options.html/js` move into the web UI. | One config, one rule engine; edits in any browser apply everywhere; no `chrome.storage` ↔ server sync logic beyond a one-time migration. |
| D7 | Two UIs, one model: the **extension popup** (mode switcher + globals for the current tab, status) in Chrome, the **web UI** (`http://127.0.0.1:4815/`: mode switcher, globals, rules, checklist, advanced) everywhere. The popup gear opens the web UI. | Chrome keeps its one-click toolbar UX; settings are edited in a single place. |
| D8 | Rules live in `local-server/rules.js` (pure functions moved from `background.js`, `node --test`able). | Nothing else evaluates rules any more. |
| D9 | HTML injection: send `Accept-Encoding: identity` upstream for document requests on domains with globals, plus a sync-zlib decompress fallback (gzip/deflate/br/zstd). Response sent identity with recomputed `Content-Length`. | Avoids decompression in the common case. |
| D10 | **Chrome proxy via `chrome.proxy`** (`pac_script` with inline data, scope `regular`), set only while a mode is on, **without `; DIRECT`**, returning `DIRECT` for every loopback name. Cleared (or set to `direct` when the system auto-proxy points at our PAC) when all domains are OFF. | Chrome needs no admin dialog; a dead server must not silently fall back and poison Chrome's bad-proxy memory for ~5 min; Chrome's implicit loopback bypass does not apply to `pac_script`, so the worker's own `fetch` to `:4815` would otherwise loop through the proxy. |
| D11 | **On-demand start through Chrome native messaging.** `chrome.runtime.sendNativeMessage('com.devmode.serve', …)` launches `local-server/native-host.sh`, which runs `launchctl kickstart` (fallback `bootstrap` + `kickstart`) and waits for `/__health`. Plist: `RunAtLoad=false`, `KeepAlive=false`, `ThrottleInterval=1`. | An extension cannot spawn processes; native messaging is the only Chrome-blessed way, registered once by `setup.sh`. |
| D12 | **Idle-quit + SSE.** The server exits when all domains are OFF and no *active* request arrived for `idleQuitSeconds` and no `GET /__events` client is connected. `GET /__health` and `GET /__state` are passive. Modes reset to OFF on boot. | "Nothing runs when unused" with no user action; an open web UI tab (even hidden) keeps it alive so Safari can restart a mode; badge polling never keeps it alive. |

## File layout

```
manifest.json, background.js, popup.html, popup.js, icons/   Chrome extension 2.0 = UI client (repo root, unchanged location)
local-server/
  serve.js            entry: args (--port/--host/--init-ca/--print-pac), state load, CA init, one http server,
                      wires request/connect/upgrade, idle-quit timer
  state.js            ~/.devmode-serve.json v2 load/save (atomic tmp+rename, 0600), migration from { mounts },
                      DEFAULT_SETTINGS (moved from background.js:22-37), change listeners, modes reset on boot
  rules.js            pure functions moved from background.js: normalizeState, extractDomain (:99), globToRegex (:225),
                      applyRewrites (:233), mapLocalMatch (from mapLocalTarget :243, returns { rule, relPath }),
                      buildGlobalsCode (:165), resolveMode(host, headers, state), hostInScope(host, state)
  ca.js               ensureCa(), certFor(host), secureContextFor(host), caTrusted()
  actions.js          trustCa(), enableSystemProxy()/disableSystemProxy() (osascript admin dialog), installService(),
                      configureFirefox(), uninstall(); checklist() gathers every status; used by api.js and CLI flags
  proxy.js            proxyRequest / handleConnect / proxyUpgrade, upstream via http/https.request, hop-by-hop hygiene
  transform.js        applyCookie, syncCookieJar, applyNoCache, noStoreResponse, injectGlobals, decompressBody
  static.js           MIME table + traversal guard + index.html + streaming (extracted from serve.js:20-46,169-195)
  api.js              /__health /__state /__settings /__globals /__events /__ca.pem /proxy.pac /__config(compat) + UI
  pac.js              buildPac(state, { fallback })
  ui/index.html, ui/ui.js   web UI (ported options.html/js + domain modes + globals + status/checklist)
  native-host.sh      Chrome native messaging host (bash 3.2, no node): kickstart the agent, wait for /__health, reply { ok }
  test/rules.test.js, test/state.test.js, test/pac.test.js, test/transform.test.js   node --test
  install-launchd.sh  existing; plist gets RunAtLoad/KeepAlive false, ThrottleInterval 1, --restart (launchctl kickstart -k)
  setup.sh            NEW (thin): launchd install + native host manifests + "Dev Mode.app" launcher + open UI; --extension-id, --uninstall / --purge
  DevMode.applescript source for the launcher app (osacompile)
options.html, options.js   DELETED in phase 8 (render/validate code and theme ported to ui/ first)
package.json          scripts: setup, uninstall, serve, restart-service, proxy-refresh, test
CLAUDE.md, README.md  rewritten for the new architecture (setup, browsers, trust, lifecycle, troubleshooting)
```

## Data model: `~/.devmode-serve.json` v2

```js
{
  version: 2,
  domains: { '.on24.com': { mode: 'off'|'dev'|'preview', assetHosts: ['orionqa.akamaized.net'] } },   // mode reset to 'off' on boot
  globals: { '.on24.com': [{ name, value }] },                 // unchanged shape
  settings: { mapLocal: [...], rewrites: [...],                // unchanged shapes (DEFAULT_SETTINGS)
              idleQuitSeconds: 60,                                    // 0 disables; server exits after all domains OFF that long (phases 1-7: 0)
              migratedFromExtension: false,                           // set once the extension pushed its legacy chrome.storage (or the web UI saved settings)
              scopedProxy: false,                                     // default: proxy every host
              excludeHosts: ['*.apple.com', '*.icloud.com', '*.mzstatic.com', '*.microsoft.com', '*.gvt1.com', 'clients*.google.com'],
              extraProxyHosts: [], upstreamProxy: '',                  // upstreamProxy: chain to a VPN/corporate proxy
              upstreamCaFile: '' },                                    // extra PEM for upstream verification behind TLS-inspecting VPNs
}
```
Migration: file without `version` → v2 with `domains` seeded `{ '.on24.com': { mode: 'off', assetHosts: ['orionqa.akamaized.net'] } }`, settings = defaults, old `mounts` folded into `mapLocal[].localPath` where ids match (unknown ids kept in `legacyMounts`, served by `/m/` until phase 8). `mounts` for the legacy `/m/` route are derived from `mapLocal`. Secrets in `~/.devmode-serve/`: `ca.key` (0600), `ca.pem`, `leaf.key`, `certs/<host>.pem`.

Extension cache (`chrome.storage.local`, display only): `{ cache: { domains, globals, health }, migratedToServer: true }`.

## HTTP API (127.0.0.1:4815)

| Route | Method | Notes |
|---|---|---|
| `/__health` | GET (passive) | `{ ok, version, port, idleQuitSeconds, migratedFromExtension, ca: { exists, sha256, trusted }, proxy: { pacUrl, services: [{ name, enabled, url }] }, mounts }` (trusted/services via `execFile`, cached 30 s) |
| `/__state` | GET (passive) / POST / DELETE | GET `?url=` → `{ domain, mode, globals }`; POST `{ domain|url, mode, assetHosts? }` → `{ domain, mode, allOff }` |
| `/__settings` | GET / POST | server-side validation mirroring `options.js:192-222` → 400 `{ errors }`; first POST sets `migratedFromExtension` |
| `/__globals` | GET / POST | `?domain=` / `{ domain, globals }`; normalization from `background.js:614-623` |
| `/__events` | GET | SSE stream of state changes; while any client is connected the server never idle-quits |
| `/__ca.pem` | GET | download CA |
| `/proxy.pac` | GET | `application/x-ns-proxy-autoconfig`, no-store; `?fallback=none` → Chrome variant without `; DIRECT` |
| `/__checklist`, `/__actions/<…>`, `/__probe` | see Onboarding | `/__actions/quit` persists state and exits |
| `/m/<id>/…` | GET/HEAD | legacy static route, unchanged |
| `/__config` | POST | compatibility for the 1.x extension until phase 8: **functional**, writes `mapLocal[id].localPath` for matching ids, unknown ids into `legacyMounts`; returns `{ ok, mounts }` as today (`background.js:264`, `options.js:115-118` rely on it) |
| `/`, `/ui.js` | GET | web UI |

Security: bind 127.0.0.1; local routes require `Host` ∈ {`127.0.0.1:4815`, `localhost:4815`} (DNS rebinding); mutating `/__*` calls require header `X-DevMode: 1` **and** (no `Origin`, or `Origin` ∈ {`http://127.0.0.1:4815`, `http://localhost:4815`}, or `Origin` starting with `chrome-extension://`) — extension POSTs carry the `chrome-extension://` origin, worker GETs carry none, and web pages cannot send `X-DevMode` without a preflight; no CORS on `/__*`; `/m/` and `/__health` keep today's permissive `BASE_HEADERS` (serve.js:90-99). Proxy refuses loopback:4815 targets (loop guard).

Idle-quit: timer armed whenever every domain is OFF; reset by *active* requests (`/`, `/ui.js`, mutating `/__*`, `/__checklist`); suspended while a `/__events` client is connected; disarmed when a mode turns on; on fire → persist, `server.closeAllConnections()`, destroy MITM sockets, `process.exit(0)` (open Safari/Firefox tunnels are reset, WebSockets drop). Proxy traffic never resets it (all OFF ⇒ tunnels only, except own domains kept MITMed for the cookie expiry).

## PAC (`pac.js`)

```js
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === 'localhost' || shExpMatch(host, '*.localhost') ||
      host === '127.0.0.1' || host === '::1' || host === '[::1]') return 'DIRECT';
  if (shExpMatch(host, '*.apple.com') || /* … each excludeHosts entry */) return 'DIRECT';
  // default (scopedProxy: false):
  return 'PROXY 127.0.0.1:4815; DIRECT';          // system PAC (Safari/Firefox)
  // '?fallback=none' (Chrome, set by the extension): return 'PROXY 127.0.0.1:4815';
  // scopedProxy: true instead emits one line per configured domain / assetHost / extraProxyHost / probe host:
  //   if (dnsDomainIs(host, '.on24.com') || host === 'on24.com') return 'PROXY 127.0.0.1:4815; DIRECT';
  //   if (shExpMatch(host, 'orionqa.akamaized.net') || host === 'probe.devmode.invalid') return 'PROXY 127.0.0.1:4815; DIRECT';
  //   return 'DIRECT';
}
```
`hostInScope()` in `rules.js` drives both the PAC and the CONNECT decision so they never disagree. CONNECT: excluded or out-of-scope host → tunnel; in scope and every domain OFF → tunnel (own configured domains excepted: still MITMed while the server runs, D4); in scope and any domain DEV/PREVIEW → MITM. With `upstreamProxy` set, tunnels and upstream requests go through that proxy instead of directly. `test/pac.test.js` asserts `FindProxyForURL('http://127.0.0.1:4815/__health', '127.0.0.1') === 'DIRECT'` for both variants (the extension's own fetches must never go through the proxy).

## Certificates (`ca.js`)

- `ensureCa()`: `openssl genrsa -out ca.key 2048`; `openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=Dev Mode Local CA/O=devmode-serve" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -addext "subjectKeyIdentifier=hash" -out ca.pem`; `openssl genrsa -out leaf.key 2048`.
- `certFor(host)` (host validated `/^[a-z0-9.-]+$/i`): CSR from `leaf.key` with `/CN=<host>`; extfile `basicConstraints=CA:FALSE`, `keyUsage=digitalSignature,keyEncipherment`, `extendedKeyUsage=serverAuth`, `subjectAltName=DNS:<host>` (or `IP:`), `authorityKeyIdentifier=keyid`, `subjectKeyIdentifier=hash`; `openssl x509 -req -CA ca.pem -CAkey ca.key -set_serial 0x<random 16 bytes> -days 397 -sha256 -extfile …`. Reuse cached cert while > 7 days valid. (Apple rules: SAN, EKU serverAuth, ≤825 days, RSA ≥2048, SHA-256.)
- `secureContextFor(host)`: memoized `tls.createSecureContext({ key: leafKey, cert: leaf + ca })` for the SNI callback.
- `caTrusted()`: `/usr/bin/security verify-cert -c <leaf.pem> -L -R offline` exit 0, cached 60 s.
- Trust: `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ca.pem` (user keychain, GUI password prompt; needs a GUI session, the launchd agent has one). Chrome reads keychain trust at startup → restart Chrome once. Firefox: `security.enterprise_roots.enabled=true`.
- Upstream verification: `https.request({ rejectUnauthorized: true, ca: [bundled roots, settings.upstreamCaFile] })`.

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
  kind==='own'  → transform.applyCookie(headers, ctx)                         // D4 request side (also in OFF: strips the cookie)
  mode!=='off'  → transform.applyNoCache(headers)                              // drop If-None-Match/If-Modified-Since/If-Range; no-cache
  wantsInject = kind==='own' && mode!=='off' && globals[domain]?.length && isDocumentRequest(req)   // Sec-Fetch-Dest document|iframe|frame, else Accept: text/html (plain-http hosts get no Sec-Fetch-*)
  wantsInject → headers['accept-encoding'] = 'identity'
  up = (https|http).request(target, { method, headers, agent: keepAlive, rejectUnauthorized: true }); req.pipe(up)
  on response:
     rh = headers minus hop-by-hop
     mode!=='off'                       → noStoreResponse(rh)   // Cache-Control: no-store; drop etag/last-modified/expires/age
     kind==='own' && document response  → syncCookieJar(rh, ctx, hadCookie)   // D4 response side (OFF: Max-Age=0 when hadCookie)
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

## Chrome extension 2.0 (phase 8)

Lifecycle invariant: **Chrome PAC set ⇔ server up ∧ some domain DEV/PREVIEW.**

- **manifest.json**: permissions `proxy`, `nativeMessaging`, `tabs`, `storage`, `alarms`, `cookies` (kept only for the OFF cleanup); drop `debugger`, `declarativeNetRequest`, `webNavigation`, `userScripts`; `host_permissions: ['http://127.0.0.1:4815/*']`; no `options_ui`; version 2.0.0 (align `package.json`, today 1.3.0 vs 1.1.0). Unpacked extensions may show "needs new permissions" after the manifest change → re-enable in `chrome://extensions`.
- **background.js** (rewrite; keep `createIcon`/badge code, `extractDomain` (:99), `isActionableUrl` (:94), message plumbing):
  - `api(path, init)` adds `X-DevMode: 1`. Every mutating call goes through `ensureServer()`; badge reads never start the server and cache "down" for 5 s.
  - **Start** (toggle to DEV/PREVIEW): `ensureServer()` = `GET /__health`; if down → `sendNativeMessage('com.devmode.serve', { action: 'start' })`, then poll `/__health` (host already waited up to 8 s) → `POST /__state { url, mode }` → `chrome.proxy.settings.clear()` then `set({ value: { mode: 'pac_script', pacScript: { data: <GET /proxy.pac?fallback=none> } }, scope: 'regular' })` (clear+set resets Chrome's bad-proxy list) → reload tab → badge. The popup stays open until `setState` resolves so "Starting…" is visible (today it closes after 150 ms, `popup.js:157`).
  - **Stop** (toggle to OFF): `POST /__state` → on `allOff`: `chrome.cookies.remove` `htm-dev-mode` for the domain, then Chrome proxy → `{ mode: 'direct' }` if the cached `/__health.proxy.services` shows our PAC URL on any network service (Chrome would otherwise follow the system PAC and stall when the server is gone), else `settings.clear()`. The server idle-quits later.
  - **Reconcile** `reconcileProxy()` on `onStartup`, `onInstalled`, popup open, badge refresh and a 30 s `chrome.alarms` tick (minimum period): server down or all OFF → proxy direct/clear, badge gray; server up with a mode on but no PAC (Safari's web UI switched DEV) → set PAC. `chrome.proxy.settings.get().levelOfControl !== 'controlled_by_this_extension'/'controllable_by_this_extension'` → popup warns "proxy controlled by another extension/policy"; `chrome.proxy.onProxyError` logged.
  - **Migration** (inside `ensureServer()`, retried until both POSTs return 200, then `chrome.storage.local.migratedToServer = true`): if `/__health.migratedFromExtension` is false, **merge** legacy `settings` into `POST /__settings` (add `mapLocal`/`rewrites` entries by `id` only when absent, so web-UI edits made during phases 1–7 win) and `globals` per domain only when the server has none; `domainStates` is not migrated (modes reset on boot). Then prune `chrome.storage.local` to `{ cache, migratedToServer }`. On `onInstalled` (reason `update`): guarded cleanup `chrome.userScripts?.unregister()`, `chrome.declarativeNetRequest?.updateDynamicRules({ removeRuleIds })`, `chrome.cookies.remove` for each former `domainStates` key.
  - `openSettings()` → `ensureServer()` → `chrome.tabs.create({ url: 'http://127.0.0.1:4815/' })`.
- **popup.html/js**: same UI; renders from the server response, or from `cache` while the server is down (all domains then show OFF with the existing `.disabled` styling). Status line states: "Starting…", "Certificate not trusted" (from `/__health.ca.trusted`, links to the checklist), "proxy controlled by another extension/policy", and native host errors: `chrome.runtime.lastError` "Specified native messaging host not found." / "Access to the specified native messaging host is forbidden." → "Run npm run setup (extension id: <chrome.runtime.id>)"; "Native host has exited." → "see ~/Library/Logs/devmode-native-host.log".
- **options.html / options.js**: deleted; render/validate code (`options.js:20-172, 192-222`) and the theme tokens are ported to `local-server/ui/` first.

## Native messaging host (`local-server/native-host.sh`, registered by `setup.sh`)

- Manifest `com.devmode.serve.json` = `{ name: 'com.devmode.serve', description, path: '<abs repo>/local-server/native-host.sh', type: 'stdio', allowed_origins: ['chrome-extension://<id>/'] }` written to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` and, when those folders exist, `Google/Chrome Beta|Canary|Dev`, `Chromium`, `BraveSoftware/Brave-Browser`, `Microsoft Edge`, `Arc/User Data`. Chrome re-reads it on each call, no restart. `setup.sh` does `chmod +x native-host.sh` (git may not keep the bit).
- Extension ID of an unpacked extension = first 32 hex chars of SHA-256 of the exact absolute folder path (no trailing slash, no symlink resolution), digits `0-9a-f → a-p` (Chrome `GenerateIdForPath`); for this folder `cmhdalbecfgakiophlokkjdhgdjlnimc` (unverified: TCC blocks reading Chrome's preferences from the terminal). `setup.sh --extension-id <id>` overrides; the popup shows `chrome.runtime.id` next to the "run npm run setup" hint. Moving/renaming the folder changes the ID and wipes `chrome.storage` → rerun setup.
- Script constraints: Chrome launches it with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (no nvm, so no node); it uses only `launchctl`, `curl`, `id`, `od`, `head`. Framing in bash 3.2 (variables cannot hold NUL): `len=$(head -c 4 | od -An -tu4 | tr -d ' ')`, `body=$(head -c "$len")`; reply `printf '\x%02x\x%02x\x%02x\x%02x' $((n&255)) $((n>>8&255)) $((n>>16&255)) $((n>>24&255))` followed by the JSON. Nothing else may write to stdout/stderr (`>/dev/null 2>>"$LOG"`), log to `~/Library/Logs/devmode-native-host.log`.
- Actions: `start` → `launchctl kickstart gui/$(id -u)/com.devmode.serve`; on failure `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.devmode.serve.plist && kickstart`; plist missing → `{ ok: false, error: 'not-installed' }`; then poll `curl -s http://127.0.0.1:4815/__health` up to 8 s → `{ ok: true }` / `{ ok: false, error: 'timeout' }`. Plist `ThrottleInterval=1` so quit-then-start within 10 s works (launchd default throttle is 10 s).

## Onboarding and per-browser checklist (no terminal in daily use)

User requirement: minimal, GUI-driven; certificate and proxy handled from the UI; starting/stopping the proxy must never interfere with VPNs.

- **First run:** `npm run setup` installs the launchd agent (user-level `launchctl bootstrap`, no admin; `RunAtLoad`/`KeepAlive` false), registers the native messaging host, creates `/Applications/Dev Mode.app` (`osacompile`: kickstart + open UI), starts the service once and opens `http://127.0.0.1:4815/`. Also shipped as a double-clickable `Dev Mode Setup.command` (same steps). Everything else happens in the UI.
- **Starting the server:** the Chrome popup toggle (primary, automatic); `Dev Mode.app` or `npm run serve` for Safari/Firefox-only sessions. **Stopping:** automatic idle-quit; the web UI also has an Off button (`POST /__actions/quit`). The macOS auto-proxy URL stays configured while the server is down: an unreachable PAC means direct connections for Safari/Firefox after a short detection delay (no password prompt, no system change, VPN settings never touched). Chrome never sees an unreachable PAC because the extension clears its own proxy setting.
- **Checklist card**, system-level items with a button next to any ✘:
  1. Service installed (`launchctl print gui/<uid>/com.devmode.serve`) → "Install service" (user-level, no prompt); native host registered for the extension ID → "Register Chrome host"; "Dev Mode.app" present in /Applications → "Create launcher" (`osacompile`).
  2. CA generated (`~/.devmode-serve/ca.pem`) → automatic on server start.
  3. CA trusted in login keychain (`security verify-cert`) → "Trust certificate": server runs `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ca.pem`; macOS shows its native password dialog (the agent runs in the user's GUI session). Once. Restart Chrome afterwards.
  4. System proxy set on every enabled network service (`networksetup -getautoproxyurl` per service, incl. the VPN service) → "Enable system proxy" / "Disable": server runs `networksetup -setautoproxyurl … && -setautoproxystate … on` through `osascript -e 'do shell script "…" with administrator privileges'`, which shows the native admin dialog. Once at setup, once at uninstall. Re-shown as ✘ with "Fix" when a VPN client overwrites it. Only needed for browsers other than Chrome.
  5. Firefox (only if `/Applications/Firefox.app` exists): `security.enterprise_roots.enabled` present in every profile's `user.js` → "Configure Firefox" writes `user_pref("security.enterprise_roots.enabled", true);` into each profile (Firefox never overwrites `user.js`; takes effect on next Firefox start) and tells the user to restart Firefox.
- **This-browser live probe** (the row that makes the checklist per browser): the page, open in any browser, does two fetches to a reserved probe host that DNS never resolves, e.g. `probe.devmode.invalid`. The PAC always routes it to the proxy (also in scoped mode) and the proxy answers it itself (never upstream):
  - `http://probe.devmode.invalid/__probe` succeeds only if **this browser** is using the proxy → "Proxy ✔/✘" (✘ → hints: enable system proxy / browser is using its own proxy settings / restart browser to refetch PAC).
  - `https://probe.devmode.invalid/__probe` succeeds only if this browser also **trusts the CA** → "Certificate ✔/✘" (✘ in Firefox → "Configure Firefox + restart"; elsewhere → "Trust certificate").
  - Result shown as "This browser: <UA name> — Proxy ✔ Certificate ✔". The server remembers the last result per browser name (`/__probe` posts back UA + outcome) so the card lists all browsers seen with their status. Chrome's row reads "Proxy: managed by extension" (its PAC is only set while a mode is on, so the probe would show ✘ while OFF).
- **Detected browsers list:** `/Applications/*.app` scan for Chrome, Chromium, Edge, Brave, Arc, Opera, Vivaldi, Firefox, Safari → rows "not verified yet — open this page in <browser>" with an "Open" button (`open -a "<Browser>" http://127.0.0.1:4815/`) until the probe has run there.
- **Uninstall** button: disable system proxy (admin dialog), remove the launchd agent and the native host manifests, optionally delete the CA from the keychain (confirm), keep config unless "also delete settings" is ticked.
- API: `GET /__checklist` (all items + last probe per browser), `POST /__actions/<trust-ca|enable-proxy|disable-proxy|install-service|register-host|configure-firefox|uninstall|quit>` (long-running, returns `{ ok, error }`; each requires `X-DevMode: 1` + origin rule), `GET /__probe` (served on the probe host for both http and https, `Cache-Control: no-store`, CORS `Access-Control-Allow-Origin: http://127.0.0.1:4815`).
- VPN interaction guarantees: the toggle, the mode switches and the automatic start/stop never touch network services; only step 4 and Uninstall do, and only the auto-proxy fields (never DNS, routes or VPN configs).

## Web UI (`local-server/ui/`)

Same tokens as `popup.html`/`options.html`. Sections, top to bottom: **Mode switcher** (per domain: `domain | OFF/DEV/PREVIEW segmented control | ×`, add domain normalized to `.root.tld`; styled like the popup); **Status** (server version, CA trusted + download link + trust command, PAC status per network service, Firefox hint, recent TLS failures per host with an "exclude" button); **Globals** per domain (rows as in the popup); **Map Local** and **Rewrites** cards (ported from `options.js`); **Checklist** card; **Advanced** (`scopedProxy`, `assetHosts`, `extraProxyHosts`, `excludeHosts`, `upstreamProxy`, `upstreamCaFile`, `idleQuitSeconds`, view PAC, note that PAC-affecting changes need `npm run proxy-refresh`). The page keeps `GET /__events` (SSE) open for live state and to keep the server alive while it is open; no health polling.

## Setup / uninstall

`local-server/setup.sh` (thin): `install-launchd.sh --port 4815` (plist gets `RunAtLoad`/`KeepAlive` false, `ThrottleInterval` 1; absolute node path as today), native host manifests (see above; `--extension-id` override), generate `/Applications/Dev Mode.app` with `osacompile -o` from `local-server/DevMode.applescript` (kickstart + open UI), start the service once, wait for `/__health`, `open http://127.0.0.1:4815/`. The CA is generated on first server start; trust, system proxy and Firefox are handled by the checklist UI (native dialogs). The same actions exist as CLI flags: `node serve.js --trust-ca | --enable-proxy | --disable-proxy | --configure-firefox` (the UI buttons call the same `actions.js` functions). All system binaries are called by absolute path (`/usr/bin/openssl`, `/usr/bin/security`, `/usr/sbin/networksetup`, `/usr/bin/osascript`).
`--uninstall`: same as the UI Uninstall button; keep config and CA unless `--purge`.
`package.json` scripts: `setup`, `uninstall`, `serve`, `restart-service`, `proxy-refresh` (autoproxystate off→on per service, admin dialog), `test` (`node --test local-server/test`).

## Implementation phases (each leaves Dev Mode usable in Chrome; phases 1–7 keep the 1.x extension working; update CLAUDE.md per phase)

1. **Server refactor + state v2 + API + web UI + SSE**: split `serve.js` into `state.js`/`static.js`/`api.js`/`rules.js`; v2 migration; functional `/__config` compatibility and `/m/`; `ui/` (ported options + mode switcher + `/__events`). Idle-quit code present but `idleQuitSeconds: 0` (the installed plist still has `KeepAlive` and the 1.x extension keeps modes in `chrome.storage`, so the server must not exit yet). Tests: `rules`, `state`. Test: `node --test`, curl each `/__*`, old extension still maps locally.
2. **CA**: `ca.js`, `--init-ca`, `/__ca.pem`, `caTrusted()`. Test: `openssl x509 -text` (CA `basicConstraints=CA:TRUE`, leaf SAN/EKU), `openssl verify -CAfile`.
3. **Proxy skeleton + PAC**: absolute-URI proxying, CONNECT tunnel for all hosts, `pac.js` with both variants and the loopback list. Test: curl via proxy for http and https, fetch `/proxy.pac`, `test/pac.test.js`.
4. **TLS MITM**: `mitmServer` + SNI for in-scope hosts, WebSocket upgrade, hop-by-hop hygiene, `x-dev-mode` header, `closeAllConnections` plumbing. Test: `curl --proxy … --cacert ca.pem -sI https://gatewayqa.on24.com/`.
5. **Mode transforms**: `resolveMode`, cookie (incl. OFF-while-running expiry), no-cache, rewrites, map-local from disk.
6. **Globals injection**: `injectGlobals`, decompress fallback, CSP nonce, `Sec-Fetch-Dest` gating with the `Accept: text/html` fallback fixture (plain-http hosts get no `Sec-Fetch-*`); unit fixtures.
7. **System integration + on-demand start**: `actions.js` (trust CA, enable/disable proxy via osascript admin dialog, install service, register host, configure Firefox, uninstall, quit), `/__checklist`, `/__actions/*`, probe host + `/__probe`, checklist card and per-browser rows in the UI, `native-host.sh`, `setup.sh` (native host manifests, `--extension-id`), plist changes (`RunAtLoad`/`KeepAlive` false, `ThrottleInterval` 1), `Dev Mode.app`; verify in Chrome, Safari, Firefox that each shows "Proxy ✔ Certificate ✔".
8. **Extension 2.0 + cutover**: rewrite `background.js`/`popup.*` as the API client (proxy via `chrome.proxy`, native start, reconcile, migration, cleanup of 1.x leftovers), delete `options.html`/`options.js`, manifest permissions; enable `idleQuitSeconds: 60`; remove `/__config` and `legacyMounts`; rewrite `CLAUDE.md` and `README.md`; bump `package.json` and `manifest.json` to 2.0.0.

## Verification

Shell (`PROXY="--proxy http://127.0.0.1:4815 --cacert ~/.devmode-serve/ca.pem"`):
- `curl -s http://127.0.0.1:4815/__health | jq`; POST `/__state` with `X-DevMode: 1` works, without it → 403; with `Origin: chrome-extension://abc` + header → 200; with `Origin: https://evil.example` → 403.
- `/proxy.pac`: DIRECT for loopback names (`127.0.0.1`, `localhost`, `[::1]`) and each `excludeHosts` entry, PROXY for everything else; `?fallback=none` has no `DIRECT` fallback; with `scopedProxy: true` it lists only on24 + `orionqa.akamaized.net` + the probe host.
- Lifecycle (`idleQuitSeconds: 60`): `POST /__state {off}` → `{ allOff: true }`, process gone after ~60 s, `launchctl print gui/$(id -u)/com.devmode.serve | grep 'last exit code'` = 0; with a `curl -N /__events` client connected it stays; after a fresh kickstart every mode is OFF; quit then start within 10 s works (ThrottleInterval).
- Native host: `printf '\x12\x00\x00\x00{"action":"start"}' | local-server/native-host.sh | tail -c +5` → `{"ok":true}` and `/__health` answers (`{"action":"start"}` is 18 bytes, hence `\x12`); with the agent booted out it still starts (bootstrap fallback); with the plist missing → `not-installed`.
- Migration: with the 1.x extension's storage populated, load 2.0 → `/__settings` and `/__globals?domain=.on24.com` contain the old values once; rules edited in the web UI beforehand are kept.
- DEV: `curl $PROXY -sv https://gatewayqa.on24.com/ -o /dev/null 2>&1 | grep -iE 'x-dev-mode|set-cookie'` → `Set-Cookie: htm-dev-mode=…`; OFF (server still up, grace window) with `-H 'Cookie: htm-dev-mode=4815162342'` → `Max-Age=0`.
- Request-side cookie/no-cache: temporary rewrite to `https://httpbin.org/headers` (or a local echo host in `extraProxyHosts`) shows the cookie and no `If-None-Match`.
- PREVIEW: `curl $PROXY -sI https://orionqa.akamaized.net/view/orion/labs/dist/production-js-abc123.js -H 'Referer: https://gatewayqa.on24.com/'` → `x-dev-mode: preview; asset; map-local`, `content-type: text/javascript`; missing file → upstream response.
- Globals: `curl $PROXY -s https://gatewayqa.on24.com/ -H 'Sec-Fetch-Dest: document' | grep -c 'data-devmode="globals"'` → 1, also with `-H 'Accept-Encoding: br'` and with only `Accept: text/html`; CSP header gains `'nonce-…'`.
- Large asset size via proxy equals direct download; `security verify-cert -c certs/gatewayqa.on24.com.pem -L -R offline` exits 0.

Chrome (extension re-enabled after the permission change, `npm run setup` run once, CA trusted from the checklist, Chrome restarted once; `chrome://settings/certificates` lists "Dev Mode Local CA"):
- Popup OFF→DEV with the server stopped: status "Starting…", server comes up, `chrome://net-internals/#proxy` shows the PAC script and an empty bad-proxies list, page reloads with `x-dev-mode: dev; own`, `document.cookie` has `htm-dev-mode`, `window.isNurturePage` overridden, badge green, no debugging bar.
- DEV→OFF: proxy direct/cleared immediately, cookie gone, a plain reload shows no `x-dev-mode`, server exits after the grace, badge gray.
- Kill the server with DEV on, wait 30 s: badge gray and proxy cleared by reconcile; toggle DEV again → works, bad-proxies list empty.
- Quit Chrome with DEV on, reopen: badge gray, Chrome proxy not pointing at the PAC; server started only on the next toggle.
- Safari's web UI sets DEV while Chrome is open → Chrome badge green and PAC set within 30 s.
- Gear opens `http://127.0.0.1:4815/`; rules edited there apply on the next request in every browser.
- Proxy-all sanity: with DEV on, `https://example.com` shows the "Dev Mode Local CA" chain and Apple services (App Store, iCloud sync) keep working thanks to `excludeHosts`.

Safari: Web Inspector Network shows `x-dev-mode`, no certificate warning, globals present; checklist row "Proxy ✔ Certificate ✔"; a hidden web UI tab keeps the server alive (SSE); server down → pages load direct after a short stall.
Firefox: Network Settings = "Use system proxy settings", `security.enterprise_roots.enabled` true, CA listed in `about:certificates` after a restart; same checks; mode switched from the web UI.
All: switching mode in either UI + reload flips cookie/injection. Also verify the known QA 404-on-reload quirk (CLAUDE.md) is not made worse.

## Risks

- HTTP/1.1 on both legs (`ALPNProtocols: ['http/1.1']`): dev-only perf cost. HSTS fine with trusted CA; browsers skip pinning for local roots.
- Apple cert rules: keep the extfile exactly as specified or Safari shows "certificate not valid" while curl works. Chrome caches keychain trust: restart it once after "Trust certificate".
- PAC caching: exclude-list or scope changes need `npm run proxy-refresh` for Safari/Firefox (Chrome gets a fresh PAC from the extension on every mode switch). Chrome remembers a failed proxy ~5 min: mitigated by no `; DIRECT` in Chrome's PAC and clear+set on every switch; `chrome://net-internals/#proxy` → clear bad proxies if it ever happens. Server stopped → system PAC unreachable → Safari/Firefox go direct after a short detection delay; open tunnels are reset at exit (WebSockets drop).
- Proxy-all + a mode on: every app honoring the system proxy is MITMed; certificate-pinned ones (Apple services, some Electron apps) fail until added to `excludeHosts` or the mode is switched OFF. The seeded exclude list covers the known system hosts; the web UI shows recent TLS failures per host with an "exclude" button. Chrome is only affected while its PAC is set (a mode on).
- Cookie lingering: the DEV cookie is removed exactly in Chrome (`chrome.cookies`); in Safari/Firefox it expires on the next on24 document load while the server is still up (grace window) or on the next DEV→OFF session; document this.
- Upstream TLS through corporate/VPN inspection: Node verifies with its bundled roots, not the keychain → `upstreamCaFile` setting and a checklist row.
- Native messaging: the extension ID depends on the folder path (TCC prevents confirming it automatically); `--extension-id` override and the popup hint cover a mismatch. The host must never write to stdout except the framed reply, or Chrome kills it.
- Keychain trust and `networksetup` prompt for a password; the VPN service must be included or the proxy is bypassed while the VPN is up (Safari/Firefox only).
- Only HTML documents needing injection are buffered (8 MB cap); everything else streams.
- Badge only in Chrome; other browsers rely on the web UI and the `x-dev-mode` response header. A macOS menu-bar app could be added later, out of scope.
