---
title: Browser
description: The built-in headless browser an agent drives directly — navigate, click, type, read, screenshot, and hand control to a human.
---

`browser` is an internal plugin. It lives in the server's own source rather than under `PLUGINS_DIR`, and it declares `auth: { type: "none" }`. It is therefore always connected and needs no setup. Its nine tools drive a warm headless Chromium session that belongs to one user.

It is internal on purpose. The handlers reach straight into the browser-session layer. Keeping that out of the plugin context means a third-party plugin can never drive a user's logged-in browser and steal their cookies. The name `browser` is reserved, and a plugin directory using it is refused at load time.

## At a glance

| | |
|---|---|
| Plugin id | `browser` |
| Auth | None (internal, always connected) |
| Tools | 9 |
| Session lifetime | `BROWSER_SESSION_TTL_SECONDS`, default 300 seconds idle |

## The per-user session model

There is exactly one browser per user, backed by a persistent profile on disk. Every action tool opens the session if it is not already running, and refreshes its idle timer. A sequence of calls therefore reuses one warm browser instead of paying the startup cost each time.

The cookie-auth capture flow uses that same browser. The two **share** it rather than excluding each other. Capture and the `browser_*` tools resolve the same warm session, so a capture can start while an agent is driving. `browser_close` ends the process but keeps the profile, so the logged-in state survives.

Because the profile persists, sites the user logged into stay logged in across sessions. The server kills an idle session after `BROWSER_SESSION_TTL_SECONDS`. The profile itself is separately subject to `BROWSER_PROFILE_TTL_DAYS`.

## Tools

| Tool | Purpose |
|---|---|
| `browser_navigate` | Navigate to a URL; returns the final URL and page title |
| `browser_read_text` | Read the page's visible text (`document.body.innerText`) |
| `browser_screenshot` | Capture the current viewport as a downscaled image |
| `browser_click` | Click at viewport coordinates `(x, y)` with left, right, or middle button |
| `browser_type` | Type text into the focused element |
| `browser_key` | Press a key or chord — `Enter`, `Tab`, `ctrl+a`, `ArrowDown` |
| `browser_scroll` | Scroll up, down, left, or right; default 600 pixels |
| `browser_close` | Close the session, keep the profile |
| `browser_live_url` | Mint a short-lived URL for a human to watch and take over |

## Screenshots and the token budget

Screenshots cost vision tokens, and a browsing loop can burn a context window on pictures of pages that have not changed. Two mechanisms keep that in check.

**Downscaling.** Shots are JPEG by default at quality 60, scaled so the width does not exceed `maxWidth` — default **1000** pixels. `format`, `quality` (1–100), and `maxWidth` are all overridable per call.

**The unchanged short-circuit.** The server hashes each capture and compares it to the previous one for that session. If the pixels are identical it returns `{ unchanged: true }` and no image at all. A screenshot after an action that did nothing costs almost nothing.

The cheaper habit is to prefer `browser_read_text` for text-heavy pages, forms, and reading, and reserve `browser_screenshot` for cases where layout or pixels actually matter. `browser_read_text` truncates at 20,000 characters by default and tells you whether it truncated.

## Human takeover

`browser_live_url` returns a URL into the portal's browser canvas — `${PORTAL_URL}/browser?t=<token>` — carrying a signed token whose lifetime is `CONNECT_TTL_SECONDS` (default 600 seconds).

Opening it attaches a live view of the *same* session the agent is driving. A person can take over by hand to solve a CAPTCHA, complete an SSO prompt, or click through a consent screen. They can then leave the page. The agent's next tool call continues in the browser they just used. This is the escape hatch for anything an agent cannot or should not do itself.

The live-view connection is authorized by an `Authorization` header on every request, not through the URL, and the browser canvas only accepts connections from allowed origins.

## Notes and gotchas

> [!WARNING] `browser_navigate` accepts only http and https, and does not block private addresses
> The URL is validated as a URL and then explicitly required to start with `http://` or `https://`, which rules out `file://` and other schemes. There is no private-IP or metadata-endpoint block, so a session can reach anything on the network the server sits on. Treat a URL an agent picked up from untrusted page content as untrusted, and run the server where that reachability is acceptable.

Clicks are coordinates, not selectors. Take a screenshot to find a target, then click it — and click a field before `browser_type`, which types into whatever currently has focus.

`browser_close` is worth calling when the agent is done. It ends the Chromium process early rather than waiting for the idle reaper, and the profile is untouched.
