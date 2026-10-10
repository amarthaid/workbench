# Cookie auth: auto-reconnect

## Goal

When a cookie-auth integration's session dies, workbench logs back in by itself
— in the user's own chromium, from a recipe the plugin declares — captures the
fresh cookies, and retries the call. The cookie equivalent of an OAuth refresh
on 401.

Two login shapes drive the design:

- **SSO** (Google, Keycloak, …): the identity-provider session in the
  persistent chromium profile usually outlives the app session. Re-login is
  "open the login page, click *Sign in with …*".
- **Username/password**: the user keeps the credentials in the workbench vault;
  re-login fills the form from it.

## Success criteria

- A tool call on a cookie integration whose session died returns the real
  result, not "reconnect in the portal", when the plugin declares a recipe and
  the recipe can complete without a human.
- Concurrent calls on a dead session trigger one reconnect, not N.
- A recipe that cannot complete (MFA, captcha, IdP session also gone, wrong
  password, selector drift) fails fast, marks the connection *needs reconnect*,
  and stops retrying for a cooldown — it never hammers a login form.
- Credential plaintext reaches only a `fill` step on an allowlisted host (amended
  during implementation: precisely, a CallArgument of `Runtime.callFunctionOn`
  bound to the verified element, in an isolated world, on an exact-match host). It
  never appears in a tool result, error, log line or audit row.
- Plugins without the new manifest blocks behave exactly as today.

## Non-goals

- LLM-driven login, recorded/user-authored recipes, a recipe editor UI.
- Solving MFA or captcha. Those end in *needs reconnect*.
- Proactive keep-alive (scheduled probing before a call fails).
- Per-app recipes for any specific deployment. Those live with the plugins that
  use them, outside this repo.

## Design

### 1. Manifest contract

`CookieConfig` gains two optional blocks (TS type in `shared/src/types.ts`,
zod schema in `shared/src/schemas.ts`):

```ts
interface CookieConfig {
  type: "cookie";
  loginUrl: string;
  targetDomain: string;
  cookieDomains?: string[];
  session?: {
    /** Request that proves the session is alive. Used to verify a reconnect. */
    probe?: { path: string; alive: number[] };          // GET, relative to targetDomain
    /** A ctx.http response matching this means the session is dead. */
    dead: { status: number[]; redirectTo?: string };   // redirectTo: Location path prefix
  };
  reconnect?: {
    /** Vault-backed slots the recipe fills, bound per connection by the user. */
    credentials?: { key: string; label: string; secret?: boolean }[];
    /** Hosts outside cookieDomains the recipe may visit (the IdP). */
    allowHosts?: string[];
    steps: ReconnectStep[];
    timeoutMs?: number;                                  // whole run; default 30000, max 120000
  };
}

type ReconnectStep =
  | { goto: string }                                     // "loginUrl" | absolute URL | path on targetDomain
  | { click: string; optional?: boolean; timeoutMs?: number }
  | { fill: string; value: string; timeoutMs?: number }  // value may contain {{cred:key}}
  | { press: string }                                    // e.g. "Enter"
  | { waitFor: string; timeoutMs?: number }              // selector appears
  | { waitUrl: string; timeoutMs?: number };             // URL starts with (absolute or path)
```

(Amended during implementation: `goto` and `waitUrl` accept only `"loginUrl"`
(goto), a single-slash path, or an http(s) URL on `targetDomain`/`cookieDomains`/
`allowHosts`; no whitespace or control characters; resolved with the URL parser,
so protocol-relative `//host` is rejected. A runtime validator in the loader
(`stripInvalidRecipe`) drops an invalid recipe with a warning, because manifests
are not schema-validated at load. `text=` selectors cannot be used for `fill`.)

Selectors are CSS, or `text=<label>` (case-insensitive substring match against
the visible text of `button`, `a`, `[role=button]`, `input[type=submit]`).

Schema rules:

- `reconnect` requires `session.dead` (nothing would trigger it otherwise).
- `{{cred:key}}` is valid only inside `fill.value`, and `key` must be declared
  in `credentials`.
- Every absolute URL in `goto`/`waitUrl` must be on `targetDomain`,
  `cookieDomains` or `allowHosts`.

Example — SSO:

```ts
session: { probe: { path: "/api/v1/me", alive: [200] }, dead: { status: [401, 302] } },
reconnect: {
  allowHosts: ["accounts.google.com"],
  steps: [
    { goto: "loginUrl" },
    { click: "text=Sign in with Google" },
    { click: "[data-email]", optional: true, timeoutMs: 3000 },  // account picker, sometimes
    { waitUrl: "/dashboard" },
  ],
},
```

Example — password:

```ts
reconnect: {
  credentials: [
    { key: "username", label: "Username" },
    { key: "password", label: "Password", secret: true },
  ],
  steps: [
    { goto: "loginUrl" },
    { fill: "#username", value: "{{cred:username}}" },
    { fill: "#password", value: "{{cred:password}}" },
    { press: "Enter" },
    { waitUrl: "/" },
  ],
},
```

### 2. Connection state (no DDL)

Everything lives in the existing `connections.config` JSON column under a
`reconnect` key:

```ts
interface ReconnectState {
  bindings?: Record<string, string>;      // credential key -> vault entry name
  deadAt?: number;                        // set when the session is known dead and not recovered
  last?: { at: number; ok: boolean; error?: string };   // error = step index + reason, never values
}
```

- Bindings are vault entry *names*, not secrets.
- `storeCookies` keeps writing only `cookies`/`access_token`; a successful
  reconnect (or a manual connect / import) clears `deadAt`.
- `hasValidCookies` returns false when `deadAt` is set, so `execute_tools`,
  `list_integrations` and `GET /api/connections` show the integration as not
  connected instead of letting every call fail upstream.

### 3. Detection and retry (`ctx.http`)

In the cookie branch of `plugins/context.ts`, after the fetch (only when the
manifest declares `session`; without it nothing below runs):

1. If the response does not match `session.dead`, return it (as today).
   A match is `status ∈ dead.status`, and when `redirectTo` is set, a 3xx also
   needs a `Location` whose path starts with it.
2. No `reconnect` block → set `deadAt`, return the response unchanged. Plugins
   that already throw "session expired" keep working; core now knows too.
3. Otherwise call `reconnectSession(userId, integration)` (section 4).
   - Success → reload cookies, re-issue the request once, return that response
     (whatever it is: no second reconnect inside one call).
   - The retry happens only when the body can be replayed (`undefined`,
     `string`, `URLSearchParams`, `ArrayBuffer`/`Uint8Array`). A streamed body
     returns the original response; the next call uses the new cookies.
   - Failure → return the original response.

A login-bounce `401`/`302` means the upstream never processed the request, so
re-issuing a non-GET is safe.

`execute_tools`' existing connected-check: when `deadAt` is set, a `reconnect`
block exists and the cooldown has passed, it calls `reconnectSession` before
rejecting with not-connected. A user whose session died overnight therefore
gets a working first call, not a "not connected" error.

### 4. Reconnect runner (`auth/reconnect/`)

`reconnectSession(userId, integration): Promise<boolean>`

- **Single flight** keyed `userId:integration` (the `refreshLocks` pattern from
  `custom-apps/oauth.ts`, including the swallowed `.finally()` rejection).
- **Cooldown**: when `last.ok === false` and `now - last.at < 10 min`, return
  false without running. This bounds login attempts to ≤6/hour per connection,
  under typical lockout thresholds.
- **Ownership guard** (section 5): if this process may not own the user's
  chromium, set `deadAt` and return false.
- **Busy guard** (amended during implementation): busy means a portal cookie
  connect is in progress (`connect-lock.ts`, process-local, 10-minute TTL, set by
  the connect start paths, cleared on capture/cancel/import). Return false
  *without* recording a failure. `activeProfiles` is not consulted: a warm browser
  holds it for its whole life, so gating on it made every reconnect busy.
- **Per-run deadline** (amended during implementation): `timeoutMs` is enforced
  per step, not only around the whole run. On timeout an abort flag stops the
  orphaned step from delivering a credential or submitting, and the tab is closed
  before the failure is written.

Run:

1. **Fast path.** `captureLiveCookies` → `filterCookies` → probe. The profile
   often already holds a live app session (the human used the app in the live
   view, or the app renewed its own cookie). Probe passes → store, done. No
   probe declared → skip the fast path.
2. **Steps.** Open a dedicated tab (`openTab`), so the agent's tab is never
   navigated. Run steps in order under the overall `timeoutMs`. Per-step
   default timeout 10 s.
   - Before every step and again right before every `fill`, the current page
     host must be on `targetDomain`/`cookieDomains`/`allowHosts` (navigation:
     suffix match, subdomains accepted; credential delivery: exact hostname match
     against `targetDomain` + `allowHosts` only, amended during implementation). Otherwise
     abort with `HOST_NOT_ALLOWED`. A recipe typo or a phishing redirect never
     receives a password.
   - `{{cred:key}}` resolves at fill time via `readSecretValue(userId,
     bindings[key])`; no binding or missing entry → abort with
     `CREDENTIAL_UNBOUND:<key>`. `touchUsed` on success.
   - `optional: true` click: not found within its timeout → skip.
3. **Capture + verify.** `captureLiveCookies` → `filterCookies`, which must
   yield ≥1 cookie. Then probe with the new cookies, if declared; the status
   must be in `alive`. With no probe, success = ≥1 cookie and the tab's URL is
   no longer `loginUrl`.
4. **Commit.** `storeCookies`, clear `deadAt`, `last = {ok:true}`. On failure:
   set `deadAt`, `last = {ok:false, error}`.
5. Close the tab in `finally`.

Errors carry the step index, step kind and a reason code (`TIMEOUT`,
`SELECTOR_NOT_FOUND`, `HOST_NOT_ALLOWED`, `CREDENTIAL_UNBOUND`, `NO_COOKIES`,
`PROBE_FAILED:<status>`) — never selector values filled or page text.

**DOM layer** (`auth/reconnect/dom.ts`): the existing `click`/`typeText` are
coordinate-based. It adds:

- `waitForSelector(page, sel, timeoutMs)` → polls `Runtime.evaluate` for the
  element's centre point (CSS or `text=`), visible and enabled.
- `clickSelector` → `waitForSelector`, then the existing `click(x, y)`.
- `fillSelector` → focus, clear the value, `Input.insertText`. React-style inputs
  see real input events.
- `waitForUrl` → polls `location.href`.

(Amended during implementation.) `fillSelector` does one page-side locate,
editability check, focus and value-free clear, then verifies `activeElement`;
otherwise it fails without delivering. The credential is delivered through
`Runtime.callFunctionOn` on the prepared element's `objectId`, in an isolated
world (`Page.createIsolatedWorld` + `DOM.resolveNode`), as a `CallArgument` and
never in expression text. The function re-checks `location.hostname` against an
exact-match array and sets the value with the native setter plus `input`/`change`
events. An isolated world is used because page scripts can patch main-world
prototypes (`String`, `Array`, the input value setter) to defeat the host check.
A navigation destroys the objectId's context, so the call fails closed. Not
`Input.insertText`. `pressKey` Enter now carries `text: "\r"` so forms submit.
The chromium launch adds `--use-mock-keychain --password-store=basic`.

### 5. Routing (cluster)

A user's chromium lives in one process (finding 2026-09-10). Instead of
forwarding the reconnect, **route the call**:

- `touchesBrowser` generalises to `needsBrowserAffinity(executions, directTool,
  registry)`. It is also true when any execution's tool belongs to a cookie
  integration with a `reconnect` block. `/mcp` and `POST /rest/:integration`
  both use it, so those tool calls run on the owner and reconnect in place.
- The owner check: an AsyncLocalStorage flag `browserAffinityVerified`, set
  when the inbound request carried a verified `X-Browser-Session` (or always
  when `INTERNAL_MCP_URL` is unset — single process). `reconnectSession` runs
  only with the flag set.
- Paths not forwarded (`/c/:integration/*` curl proxy) still detect the dead
  session and set `deadAt`, but do not reconnect when clustered. The next
  routed tool call, or `execute_tools`' pre-check, does.

### 6. Portal

- **AppDetail only** (amended during implementation): bindings need an existing
  connection row (409 otherwise), so there is no panel in the connect modal. When the manifest declares
  `reconnect.credentials`, an *Auto-reconnect* section shows one vault-entry
  picker per slot (fed from `GET /api/vault`, metadata only), plus a link to add
  a vault entry. Saved via
  `PUT /api/connections/:integration/reconnect {bindings}`. The endpoint
  validates that keys are declared and entries exist, and is portal-session
  only (amended during implementation: 403 `PORTAL_SESSION_REQUIRED` for a
  non-portal bearer; an API-key-only request gets 401; nothing is written).
- **SSO recipes.** No credentials, so no setup UI. It just works.
- **AppDetail status line.** "Auto-reconnected 2h ago", "Auto-reconnect failed
  (step 3: SELECTOR_NOT_FOUND) — reconnect manually", or "Session expired —
  reconnect". It is read from `GET /api/connections`, which gains
  `autoReconnect: {supported, bound, last?}` per cookie integration.

### 7. Audit

Each attempt that runs (not a cooldown skip) writes an audit row with the
existing `REFRESH` action, the integration and `ok`/error code. It is the
first emitter of that action.

## Security notes

- New server-side caller of `readSecretValue`; update the caller list in the
  `vault/store.ts` header comment.
- Cluster routing (amended during implementation): the `/mcp` handler moved to
  `src/mcp/route.ts` (`registerMcpRoute`) so the owner gate is tested on the real
  route.
- Recipes are plugin code — trusted at the same level as plugin handlers.
  The host allowlist protects against recipe mistakes and hostile redirects,
  not hostile plugins.
- Vault scrub still applies to tool results. The runner never returns page
  content, so there is nothing new to scrub.

## Testing

- **Schema:** valid SSO and password recipes parse. Rejected: `{{cred:x}}`
  outside `fill`, undeclared cred key, `reconnect` without `session.dead`,
  `goto` to an undeclared host.
- **Dead matcher:** status lists, `redirectTo` prefix vs other 3xx.
- **ctx.http:** dead → reconnect → retry once returns retried response. No
  recipe → `deadAt` set, response passthrough. Streamed body → no retry. Reconnect
  failure → original response.
- **Runner** (fake page): single flight (N concurrent → 1 run), cooldown skip,
  busy skip records nothing, host guard aborts before `fill`, unbound
  credential, optional click skip, fast path short-circuits steps, errors
  carry no secret.
- **Routing:** `needsBrowserAffinity` true for a recipe integration's tool,
  false for one without. `reconnectSession` refuses without the affinity flag
  when clustered.
- **Chromium integration** (`*.chromium.test.ts` style): local Fastify fixture
  app with (a) password form → session cookie, (b) "Sign in with SSO" button →
  fake IdP host → cookie, (c) MFA page that never completes → failure + `deadAt`.
- **Portal:** bindings endpoint validation; status line renders from
  `autoReconnect`.

## Rollout

- Touches auth → ships as an RC (`v0.32.0-rc.1`).
- Docs: plugin-author section on `session`/`reconnect` in the cookie-auth docs
  page. A finding doc is written after implementation, and release notes too.
- Deployments then add `session` + `reconnect` blocks to their own cookie
  plugins. Plugins that hand-roll `SESSION_DEAD` throws can delete them once
  `session.dead` is declared.
