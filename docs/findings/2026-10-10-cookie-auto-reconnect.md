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
  - *Agent tabs could read chromium's debug endpoint.* `/json/list` on the
    debug port lists every target, private ones included, and `/json/close/<id>`
    kills one. Every agent tab now fails its requests to that port through
    `Fetch` interception (any host spelling, script navigations included), and
    `browser_navigate` / the live-url route refuse loopback URLs. An iframe
    pointed at the endpoint already failed to load in chromium; the e2e keeps
    that pinned.

## Known gaps

- Apps that only react to keydown events may not register the native-setter
  value; add a `press` step.
- Reconnect failures from MFA, captcha or a gone IdP session end in "needs
  reconnect" by design.
- The in-process run record is lost on a restart, after which only the DB
  record (and the 409 on API-key DELETE) holds the cooldown.
- The cooldown is per integration: two integrations whose recipes use the same
  login each get their own window.
- `cancel` and `session/import` accept an API key and end the "human is
  mid-connect" lock, so an agent can let a recipe run under a human's live
  connect. No credential is exposed (the recipe tab is private); it only
  defeats the courtesy.
