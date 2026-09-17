---
title: Browser
description: The built-in headless browser an agent drives directly — navigate, click, type, read, screenshot, and hand control to a human.
---

`browser` is an internal plugin. It lives in the server's own source rather than under `PLUGINS_DIR`, and it declares `auth: { type: "none" }`. It is therefore always connected and needs no setup. Its fifteen tools drive a warm headless Chromium session that belongs to one user.

It is internal on purpose. The handlers reach straight into the browser-session layer. Keeping that out of the plugin context means a third-party plugin can never drive a user's logged-in browser and steal their cookies. The name `browser` is reserved, and a plugin directory using it is refused at load time.

## At a glance

| | |
|---|---|
| Plugin id | `browser` |
| Auth | None (internal, always connected) |
| Tools | 15 |
| Session lifetime | `BROWSER_SESSION_TTL_SECONDS`, default 300 seconds idle |

## The per-user session model

There is exactly one browser per user, backed by a persistent profile on disk. Every action tool opens the session if it is not already running, and refreshes its idle timer. A sequence of calls therefore reuses one warm browser instead of paying the startup cost each time.

**One user, one browser, many tabs.** `browser_start` opens a new tab and returns its `session_id`. Every other driving tool takes that id and acts on that tab only. Two agents (or one agent with subagents) each call `browser_start` and get their own tab; they never step on each other. All tabs live in one Chromium with one profile and one cookie jar, so a login in one tab is visible in the others, and downloads from any tab land in the same [workspace](files.md). A user may hold `BROWSER_TAB_LIMIT` tabs at once (default 8); `browser_start` past that returns `BROWSER_TAB_LIMIT`. `browser_tabs` lists what is open. An id that is not one of your open tabs is refused with `BROWSER_TAB_NOT_FOUND`.

`session_id` is not a credential and not a routing key. Behind a load balancer every `browser_*` call still has to reach the replica that owns the Chromium process (see [browser session pod affinity](../field-notes/2026-09-10-browser-session-pod-affinity.md)); the server derives that routing key from the bearer itself, so the agent never sees or carries it. Until v0.31, a `session_id` minted by a pre-v0.30 `browser_start` still works and drives the default tab.

The cookie-auth capture flow uses that same browser. The two **share** it rather than excluding each other. Capture and the `browser_*` tools resolve the same warm session, so a capture can start while an agent is driving. `browser_close` ends one tab, not the browser; the profile — and the logged-in state in it — survives regardless.

Because the profile persists, sites the user logged into stay logged in across sessions. The server kills an idle session after `BROWSER_SESSION_TTL_SECONDS`. The profile itself is separately subject to `BROWSER_PROFILE_TTL_DAYS`.

## Tools

| Tool | Purpose |
|---|---|
| `browser_start` | Open a new tab and return its `session_id`. Once per independent task |
| `browser_navigate` | Navigate to a URL; returns the final URL and page title |
| `browser_read_text` | Read the page's visible text (`document.body.innerText`) |
| `browser_evaluate` | Run JavaScript in the page and get its value back — click by selector, scrape the DOM, wait on a promise |
| `browser_screenshot` | Capture the current viewport as a downscaled image |
| `browser_click` | Click at viewport coordinates `(x, y)` with left, right, or middle button |
| `browser_type` | Type text into the focused element |
| `browser_key` | Press a key or chord — `Enter`, `Tab`, `ctrl+a`, `ArrowDown` |
| `browser_scroll` | Scroll up, down, left, or right; default 600 pixels |
| `browser_expect_download` | Arm a wait for a download, **before** the click that triggers it |
| `browser_await_download` | Wait for that download and get the file now in your [workspace](files.md) |
| `browser_upload_file` | Put a workspace file into an `<input type="file">` |
| `browser_close` | Close this tab; the browser and profile stay |
| `browser_tabs` | List open tabs with their `session_id`, url, title |
| `browser_live_url` | Mint a short-lived URL for a human to watch and take over |

## Screenshots and the token budget

Screenshots cost vision tokens, and a browsing loop can burn a context window on pictures of pages that have not changed. Two mechanisms keep that in check.

**Downscaling.** Shots are JPEG by default at quality 60, scaled so the width does not exceed `maxWidth` — default **1000** pixels. `format`, `quality` (1–100), and `maxWidth` are all overridable per call.

**The unchanged short-circuit.** The server hashes each capture and compares it to the previous one for that session. If the pixels are identical it returns `{ unchanged: true }` and no image at all. A screenshot after an action that did nothing costs almost nothing.

The cheaper habit is to prefer `browser_read_text` for text-heavy pages, forms, and reading, and reserve `browser_screenshot` for cases where layout or pixels actually matter. `browser_read_text` truncates at 20,000 characters by default and tells you whether it truncated.

## Human takeover

`browser_live_url` returns a URL into the portal's browser canvas — `${PORTAL_URL}/browser?t=<token>` — carrying a signed token whose lifetime is `CONNECT_TTL_SECONDS` (default 600 seconds).

Opening it attaches a live view of the *same* session the agent is driving — the portal's canvas dials the very page target the tools speak to, so the human sees the agent's tab, not a new one. A person can take over by hand to solve a CAPTCHA, complete an SSO prompt, or click through a consent screen. They can then leave the page. The agent's next tool call continues in the browser they just used. This is the escape hatch for anything an agent cannot or should not do itself.

The link is a claim, not a capability: the person opening it has to be signed in to the portal as the same workbench user, or the server refuses with an account mismatch before warming anything. The live-view connection is then authorized by an `Authorization` header on every request, not through the URL, the browser canvas only accepts connections from allowed origins, and every request after the first carries the same per-user routing key the server uses for the agent's tool calls — the portal mints it from `/attach`, so the view and the tools land on the same replica. The live view shows the default tab, even when the agent has several open. Closing the tab detaches the view; it does not close the browser.

## Notes and gotchas

> [!WARNING] `browser_navigate` accepts only http and https, and does not block private addresses
> The URL is validated as a URL and then explicitly required to start with `http://` or `https://`, which rules out `file://` and other schemes. There is no private-IP or metadata-endpoint block, so a session can reach anything on the network the server sits on. Treat a URL an agent picked up from untrusted page content as untrusted, and run the server where that reachability is acceptable.

Clicks are coordinates, not selectors. Take a screenshot to find a target, then click it — and click a field before `browser_type`, which types into whatever currently has focus. When a selector is what you have, `browser_evaluate` is the Playwright-shaped escape hatch:

```
browser_evaluate({ session_id, expression: "document.querySelector('button.submit').click()" })
browser_evaluate({ session_id, expression: "Array.from(document.querySelectorAll('tr')).map(r => r.innerText)" })
browser_evaluate({ session_id, expression: "new Promise(r => setTimeout(() => r(document.title), 1000))" })
```

The expression runs in the page's main world with the page's cookies, and a promise is awaited. The result has to be a plain JSON value — DOM nodes and functions come back as `{}` — and a result over 100,000 characters is refused as `RESULT_TOO_LARGE` rather than cut off, so narrow the expression. An exception comes back as `EVALUATION_FAILED` with the message. The page's content is untrusted input; do not let it choose what you evaluate next.

## Moving files in and out

A download is a side effect of a click, not something you can ask for by URL — the agent does not know the URL, that is the whole reason it is clicking. So the sequence is arm, act, await:

```
browser_expect_download()   ->  { handle }
browser_click(x, y)             the download button
browser_await_download()    ->  { name, bytes, expiresAt }
```

Arming first is deliberate. If `browser_click` waited implicitly, every click would pay a timeout for a download that usually is not coming.

Downloads land in the [files workspace](files.md) **whether or not a wait was armed** — routing is set when the session starts, so a download nobody waited for still shows up in `files_list` instead of vanishing into a temp directory. Captured files are deleted 24 hours after they land, so hand anything worth keeping to a durable destination in the same run.

Going the other way, `browser_upload_file({ selector, name })` puts a workspace file into a file input. `name` is a workspace-relative filename and never a path: it is resolved server-side against your own directory, symlinks included. Chromium will upload whatever path it is given to whatever form is on the page, so that resolution is load-bearing rather than decorative.

`browser_close` is worth calling when the agent is done with a tab. It ends that tab immediately rather than waiting for the idle reaper; the browser, the profile, and any other tabs are untouched.
