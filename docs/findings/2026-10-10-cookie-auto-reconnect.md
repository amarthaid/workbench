# Cookie auto-reconnect: what a real login form taught us

**Date:** 2026-10-10

## What we built

A cookie integration can declare `session` (what a dead response looks like) and
`reconnect` (login steps). On a dead response `ctx.http` runs the recipe in the
user's own chromium, captures cookies, and retries once. Spec:
`docs/superpowers/specs/2026-10-10-cookie-auto-reconnect-design.md`. Plugin
guide: Auto-reconnect in `plugins/auth-modes`.

## What we found

- **`pressKey` Enter never submitted a form.** The first real-chromium run (a
  Fastify fixture with a password form) hung on the post-login wait. The key
  event was `rawKeyDown` without `text: "\r"`, so chromium produced no
  keypress and no implicit form submission. Unit tests with a fake page could
  not see this. It also fixes the `browser_key` tool.
- **Deliver the credential in an isolated world, not the main world.** A
  `Runtime.callFunctionOn` that re-checks `location.hostname` in the page's own
  world trusts prototypes (`String`, `Array`, the input value setter) the page
  can patch. The call goes to an isolated world resolved from the element's
  `backendNodeId`; an element outside the main frame fails closed, and a
  navigation destroys the context so the call fails closed too. The value is a
  `CallArgument`, never expression text. `Input.insertText` was dropped: it
  types into whatever has focus, with no host or element binding.
- **Navigation is suffix-matched, credentials are exact.** The navigation guard
  accepts subdomains of `targetDomain`/`cookieDomains`/`allowHosts` (an SSO
  redirect legitimately lands on subdomains). Credential delivery requires the
  exact hostname in `targetDomain` or `allowHosts`, or any sibling subdomain
  could collect a password. Cost: a login on `login.idp.example.net` needs that
  host listed explicitly.
- **Manifests are not schema-validated at load.** The zod schema was never on
  the plugin load path, so a malformed recipe (non-array `steps`, a bad `goto`)
  would crash or misbehave at the first dead session. The loader now runs
  `validateCookieRecipe`, drops the `reconnect` block with a warning, and keeps
  the integration. The validator itself must tolerate junk input without
  throwing. URL rules resolve through the URL parser rather than regexes, which
  rejects `//host` and whitespace/control-character tricks.
- **"Busy" was first modelled as "browser open", which made every reconnect
  busy.** `activeProfiles` holds a user for the whole life of a warm chromium.
  Busy now means a portal connect is in progress: a process-local marker with a
  10 minute TTL, set by the cookie connect start paths and cleared on
  capture/cancel/import.
- **A step that timed out kept running.** Racing a step against the deadline
  left the losing step alive, able to type the password or press Enter after
  the run had already been declared failed. An abort flag now stops it before it
  delivers, and the tab is closed before the failure is recorded. The deadline is
  enforced per step.
- **No DDL.** Bindings, `deadAt` and the last attempt ride in
  `connections.config` under `reconnect`. `storeCookies` clears `deadAt`, so a
  manual connect or import also resets it. `hasValidCookies` returns false while
  `deadAt` is set.
- **Cluster routing moves the call, not the reconnect.** The chromium lives in
  one process (finding 2026-09-10), so tool calls on recipe integrations get
  browser affinity and run on the owner. Paths that cannot be forwarded still
  mark the connection dead but do not reconnect. The `/mcp` handler moved to
  `src/mcp/route.ts` to test the owner gate on the real route.
- **Bindings are portal-session only.** An agent that could rebind which vault
  entry is typed into a login form would control credential routing. An
  API-key-only request is refused with nothing written. The panel lives on
  AppDetail only: bindings need an existing connection row.
- **macOS keychain prompts.** Spawned chromium asked for the login keychain on
  every e2e run. `--use-mock-keychain --password-store=basic` (what Playwright
  passes) fixes it and is a no-op in the Linux container.
- **Chromium e2e result.** Password form, SSO button to a fake IdP host, and a
  never-completing MFA page all behave: cookies captured and the call retried, or
  failure with `deadAt` set and a cooldown. The probe URL builder is only
  unit-covered; the e2e overrides the probe and uses absolute `http` gotos.
- **`text=` cannot target `fill`.** It matches clickable elements only; a fill
  must hit a real editable input.

- **Security review follow-ups.**
  - *The cooldown lived on a row an agent can delete.* `DELETE
    /api/connections/:i` and session import both take an API key, and the
    failure record sat in `connections.config`: delete, re-import, retry reset
    it (deleting mid-run meant the failure was never written at all). The
    runner now also remembers the last recipe run in-process (recipes only run
    on the chromium owner, so that is where every run starts), an API-key
    DELETE inside the cooldown is a 409, and portal-session clears stamp
    `clearedAt` so they still lift a run only the process remembers.
  - *A "success" that dies at once had no cooldown.* A probe-less recipe that
    lands anywhere but the login URL counts as success; with a non-replayable
    body there is no retry to catch it, so every call re-ran the recipe. A
    recipe success now holds the window like a failure. The fast path (reusing
    the profile's live session) types nothing and holds nothing.
  - *Exact host was not enough for delivery.* `http://` on the right host
    received the value in cleartext (recipe `goto` may be `http`), and the
    target node came from main-world script, which can hand over a node from
    another frame. The isolated-world function now also requires
    `isSecureContext` (loopback `http` still qualifies, so local fixtures work)
    and `this.ownerDocument === document && this.isConnected`.
  - *Agent tabs could read any chromium's debug endpoint.* Every user's
    chromium listens on its own `127.0.0.1:<port>`; `/json/list` there lists
    every target (another user's private recipe tab included) and
    `GET /json/close/<id>` kills one. A GET with side effects needs no readable
    response (`<img src>` is enough), so CORS does not help, and a block on the
    session's own port only (the first fix) left every other user's port open.
    Now the **browser-target** client sets `Target.setAutoAttach` with
    `waitForDebuggerOnStart`, so every new target (agent tabs, `window.open`
    and `target=_blank` popups, workers) is attached paused, given `Fetch`
    interception for all URLs and resource types, and only then resumed; each
    guarded page auto-attaches its out-of-process iframes the same way. A
    paused request is failed (`BlockedByClient`) when its host is loopback or
    unspecified on any port (IP literal forms normalised by the URL parser,
    hostnames resolved, cached 60 s) or the server's internal host, and fails
    closed on a URL it cannot parse. Every redirect hop is paused as its own
    request. The guard is installed before the session is handed out; if the
    browser socket that carries it drops, chromium is killed. Private recipe
    tabs and their popups are released unintercepted. `browser_navigate` and
    the live-url route keep a literal pre-check as a fast error. Page-level
    auto-attach does not see popups (the first attempt missed them in real
    chromium); only the browser target does. Cost: about 0.4 ms per request
    (200 sequential same-origin fetches: ~210 ms guarded vs ~130 ms unguarded),
    plus one DNS lookup per new hostname per minute.

  - *Fix round on the guard.* Every error path now fails the request: an
    unparsable URL, an unknown scheme, a DNS error or timeout (negative results
    cached 10 s, at most 8 lookups at once), a handler exception, and a request
    from a session the guard never set up. A target of any type whose guard
    cannot be set up is closed, never resumed. Dedicated workers have no Fetch
    domain (`'Fetch.enable' wasn't found`); their requests are paused on the
    owning page's session (pinned by the e2e), so one runs only under a guarded
    parent. Shared and service workers take Fetch on their own session.
    `Network.enable` on a paused service worker hangs until it is resumed, and
    `Network.setBlockedURLs` did not block a WebSocket in a page either, so the
    Network domain is not used. Guard setup for targets that exist at install
    time is awaited. The cooldown is applied after the fast path, so a session
    the profile can hand back is recovered inside the window.
    `BROWSER_LOOPBACK_ALLOW_PORTS` opens listed loopback ports (dev servers) in
    any environment, never a live chromium debug port or the server's `PORT`.
  - *DevTools sockets need an origin no page can have.* `--remote-allow-origins`
    was `http://127.0.0.1`, the origin of any page served from loopback port
    80. It is now `http://workbench-cdp.invalid` (`src/auth/cdp-origin.ts`),
    sent by every server-side CDP client.
  - *The recipe tab is not guarded, on purpose.* Its steps are trusted plugin
    manifest data driven by the server, no agent can reach the tab (it is
    hidden from every `browser_*` tool and the live view), and e2e fixtures run
    on 127.0.0.1.
  - *Credentials are delivered to https only* (or loopback http, for local
    fixtures): `isSecureContext` in the isolated-world deliver function.
  - *409 after a success.* A recipe success now holds the window, so an API-key
    `DELETE /api/connections/:i` within 10 minutes of an automatic reconnect
    gets `409 RECONNECT_COOLDOWN` even though nothing failed. Disconnect from the
    portal, or wait.

## Known gaps

- Apps that only react to keydown events may not register the native-setter
  value; add a `press` step.
- Reconnect failures from MFA, captcha or a gone IdP session end in "needs
  reconnect" by design.
- The in-process run record is lost on a restart, after which only the DB
  record (and the 409 on API-key DELETE) holds the cooldown.
- DNS rebinding: a hostname is resolved by the guard and again by chromium,
  so an answer that flips from public to loopback between the two lookups gets
  through. IP literals and `localhost` names are not affected. Chromium's
  DevTools HTTP handler likely rejects a non-IP, non-`localhost` Host header,
  which would leave the debug endpoints out of reach through a rebound name
  (unverified).
- WebSockets: Fetch never pauses a WebSocket handshake and `Network.setBlockedURLs`
  did not block one, so an agent page can open a plain WebSocket to a loopback
  service (pinned by an e2e "residual" case). DevTools sockets stay refused by
  origin. The guard's "any port" covers HTTP(S) only.
- `BROWSER_ALLOW_LOOPBACK` (test only, ignored when `NODE_ENV=production`) lets
  agent tabs reach loopback so chromium e2e fixtures on 127.0.0.1 load.
- The cooldown is per integration: two integrations whose recipes use the same
  login each get their own window.
- `cancel` and `session/import` accept an API key and end the "human is
  mid-connect" lock, so an agent can let a recipe run under a human's live
  connect. No credential is exposed (the recipe tab is private); it only
  defeats the courtesy.
