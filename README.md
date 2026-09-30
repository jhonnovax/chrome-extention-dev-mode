# dev-mode-chrome-extention

Chrome extension that toggles development mode (OFF / DEV / PREVIEW) per domain, with Map Local and Rewrite rules
served through `chrome.debugger` and per-domain globals. See `CLAUDE.md` for the architecture.

## Debugging bar

While any tab is in DEV or PREVIEW, Chrome shows the bar *"Dev Mode started debugging this browser"*. It is Chrome's
own infobar for extensions using `chrome.debugger`, and Chrome shows it in **every tab of every window**, also on tabs
whose domain is OFF. It disappears when every domain is OFF (the extension then holds no debugger session). Clicking
**Cancel** on it detaches all sessions, so mapping stops in every tab until they navigate again.

There is no extension API to hide it. Chrome skips it only when launched with the flag below (per launch, Chrome
fully quit first) or for a policy-installed extension:

```sh
open -na "Google Chrome" --args --silent-debugger-extension-api
```

To keep it out of the way, the extension debugs **only the active tab of each window**: switching to an OFF tab
detaches the DEV/PREVIEW tab you left, and Chrome closes the bar a few seconds later (its own auto-close timer, not
adjustable). The price: a DEV/PREVIEW tab in the background is served from the real site until you switch back to it
(it reloads then if it navigated meanwhile). Hidden switch for debugging, from the worker console:
`chrome.storage.local.set({ activeTabOnly: false })`.
