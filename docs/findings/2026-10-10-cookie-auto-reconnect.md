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

## Known gaps

- Apps that only react to keydown events may not register the native-setter
  value; add a `press` step.
- Reconnect failures from MFA, captcha or a gone IdP session end in "needs
  reconnect" by design.
