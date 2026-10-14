# dev-mode-chrome-extention

Chrome extension that toggles development mode (OFF / DEV / PREVIEW) per tab, with Map Local and Rewrite rules
served through `chrome.debugger` and per-domain globals. See `CLAUDE.md` for the architecture.

## Modes are per tab and never stored

Every tab starts **OFF**. Picking DEV or PREVIEW in the popup applies to the current tab only: it reloads and gets the
mode's rewrites, Map Local, cookie and globals on the fly, and keeps the mode while it navigates (even to other
sites). Closing the tab forgets it; a new tab (also one opened from a DEV tab) starts OFF, and so does every tab after
a browser restart or an extension reload. The `htm-dev-mode` cookie is sent only by the DEV tab: it is added to that
tab's requests and never stored in Chrome's cookie jar, so another tab on the same URL is served normally. Rules and
globals stay saved settings (synced through your Google account).

## Debugging bar

While any tab is in DEV or PREVIEW, Chrome shows the bar *"Dev Mode started debugging this browser"*. It is Chrome's
own infobar for extensions using `chrome.debugger`, and Chrome shows it in **every tab of every window**, also on tabs
that are OFF. It disappears when every tab is OFF (the extension then holds no debugger session). Clicking
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
`chrome.storage.session.set({ activeTabOnly: false })` (lasts until the browser quits).
