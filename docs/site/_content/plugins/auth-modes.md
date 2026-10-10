---
title: Auth modes
description: The four auth types a manifest can declare — oauth2, apikey, cookie, none — with the exact manifest shape, the connect experience, and what ctx.http does for each.
---

`manifest.auth` is a discriminated union on `type`. Pick the one the target
service supports. It determines the whole connection experience and how
`ctx.http()` authenticates.

| `type` | Use when | Credential stored | `ctx.http()` attaches |
|---|---|---|---|
| `oauth2` | The service has an OAuth 2.0 app you can register | Access + refresh token, encrypted | `Authorization: Bearer <token>` |
| `apikey` | The service authenticates with a long-lived key in a header | The secret field, encrypted | `<headerName>: <key>`, verbatim |
| `cookie` | There is no API auth — only a browser login | Captured cookies | A filtered `Cookie` header |
| `none` | No credential at all | Nothing | `Bearer` from `getToken()`, which will throw |

## `oauth2`

The default choice, and what 14 of the 16 shipped plugins use.

```ts
export interface OAuthConfig {
  type: "oauth2";
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  instance?: { label: string; placeholder?: string; default: string };
}
```

```ts
auth: {
  type: "oauth2",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/generative-language.retriever"],
},
```

**Operator setup.** Register an OAuth app with the provider, set the redirect URI
to `${SERVER_PUBLIC_URL}/api/auth/plugin/<name>/callback`, and put the
credentials in env vars named from the plugin name (`google-gemini` →
`GOOGLE_GEMINI_CLIENT_ID` / `GOOGLE_GEMINI_CLIENT_SECRET`).

**What the user sees.** From the portal, clicking Connect redirects them to the
provider's consent screen and back. From an agent, `connect({ integration })`
returns a workbench link plus a `connectionId` to pass to `wait_for_connection` —
not the provider URL directly. The link names the workbench user the agent is
connected to; opening it while signed in as anyone else produces a mismatch page
instead of the consent screen. Only after that check passes does the server build
the provider's consent URL and send the user there.

**Refresh tokens.** `ctx.getToken()` refreshes automatically 30 seconds before
expiry, but only if a `refresh_token` was issued. That usually requires an
explicit scope. Atlassian needs `offline_access` in the scope list. Google needs
`access_type=offline`, which the server adds for you.

Add an `instance` block when the product can be self-hosted. See
[the manifest reference](manifest.md).

## `apikey`

For services authenticated by a long-lived key sent in a header. New Relic is the
shipped example.

```ts
export interface ApiKeyConfig {
  type: "apikey";
  headerName: string;      // value sent verbatim — no "Bearer " added
  fields: ApiKeyField[];   // exactly one field sets secret: true
  allowedHosts?: string[];
}

export interface ApiKeyField {
  key: string;             // form name and getConfig() key
  label: string;           // portal field label
  description?: string;    // helper text under the label
  placeholder?: string;
  secret?: boolean;        // the credential — encrypted, masked input
  options?: string[];      // renders a <select> instead of a text input
  optional?: boolean;      // may be left blank at connect time
}
```

The New Relic manifest's `auth` block, abridged (field descriptions and comments
are shortened here — read `packages/plugins/newrelic/manifest.ts` for the exact text):

```ts
auth: {
  type: "apikey",
  // NerdGraph authenticates with the user API key in the `Api-Key` header.
  headerName: "Api-Key",
  // All tool traffic goes to NerdGraph; pin the key to New Relic's hosts so it
  // can never leak to another destination.
  allowedHosts: ["api.newrelic.com", "api.eu.newrelic.com"],
  fields: [
    {
      key: "apiKey",
      label: "New Relic User API Key",
      description: "The User API key for authenticating requests to New Relic's APIs.",
      placeholder: "Enter New Relic User API Key",
      secret: true,
    },
    {
      key: "region",
      label: "Account Region",
      description: "The region of the New Relic account, either 'US' or 'EU'.",
      placeholder: "US",
      options: ["US", "EU"],
    },
    {
      key: "accountId",
      label: "Default Account ID",
      description: "Optional. The numeric account ID tools use when you don't pass accountId explicitly.",
      placeholder: "1234567",
      optional: true,
    },
  ],
},
```

**How the fields split.** Exactly one field sets `secret: true`. That value is
stored encrypted as the connection's access token and is the *only* thing
`ctx.http()` sends. Every other field is stored as per-connection config and read
back with `ctx.getConfig()[field.key]` — so a handler gets `region` and
`accountId`, but never `apiKey`.

**What the user sees.** A portal modal rendering one input per field: masked for
the secret one, a `<select>` where `options` is set, and required unless
`optional: true`. No redirect, no provider consent screen.

**What `ctx.http()` does.** Sets `headers[headerName] = <secret>` with no
transformation — no `Bearer` prefix is added. If the API wants
`Authorization: Bearer <key>`, either bake the prefix into the value the user
pastes or choose a header where the raw key is correct.

> [!DANGER] `allowedHosts` is optional, and omitting it means no host check at all
> Unlike the cookie branch, `ctx.http()` for `apikey` auth validates the host only
> when `allowedHosts` is non-empty. A plugin that passes a user- or tool-supplied
> URL to `ctx.http()` without it will forward the API key to whatever host it is
> given. Set `allowedHosts`, or guard the host in the handler.

Matching is case-insensitive, strips a leading dot, and accepts an exact host or
any subdomain of a listed host.

## `cookie`

For services with no usable API auth, where the only way in is a browser login.
The server drives a headless Chromium to the login page, the user signs in live,
and the resulting cookies are captured and stored.

```ts
export interface CookieConfig {
  type: "cookie";
  loginUrl: string;
  targetDomain: string;
  cookieDomains?: string[];
}
```

`httpbin-cookie` is the reference plugin, kept deliberately minimal:

```ts
export default {
  name: "httpbin-cookie",
  version: "1.0.0",
  displayName: "HTTPBin (cookie demo)",
  description: "Reference cookie-auth plugin for testing.",
  // No logo on purpose — exercises the portal's default cog fallback.
  categories: ["demo"],
  auth: {
    type: "cookie" as const,
    loginUrl: "https://httpbin.org/cookies/set?session=test123",
    targetDomain: "httpbin.org",
    cookieDomains: [".httpbin.org"],
  },
};
```

Its tools are ordinary — `ctx.http()` handles everything:

```ts
export const getHeaders = {
  name: "httpbin_get_headers",
  description: "Get request headers (useful to verify Cookie header is injected)",
  integration: "httpbin-cookie",
  inputSchema: z.object({}),
  handler: async (ctx: any, _args: any) => {
    const res = await ctx.http("https://httpbin.org/headers");
    return res.json();
  },
};
```

| Field | Purpose |
|---|---|
| `loginUrl` | Where Chromium navigates when the user clicks Connect. |
| `targetDomain` | The host tools call. Always part of the allowed set. |
| `cookieDomains` | Additional domains cookies may be captured from and sent to. |

**No env vars needed.** There is no OAuth app to register.

**What the user sees.** A portal login view where they complete the real login
flow in a live browser session, then click Capture. From an agent,
`connect({ integration })` returns a workbench link and a `connectionId`. Opening
the link requires being signed in to workbench as the user the agent is connected
to; only then does the server warm the browser session and show the live login
view.

**What `ctx.http()` does.** Checks the URL host against `targetDomain` plus
`cookieDomains` — this check is mandatory and cannot be disabled — filters
cookies by expiry and by domain match to that host, sets one `Cookie` header, and
forces `redirect: "manual"` so the session can never follow a redirect off the
allowed hosts. Your handler sees any 3xx directly.

> [!WARNING] `loginUrl` must be reachable from the server
> The login runs in Chromium on the workbench host, not on the user's machine. If
> the service is only reachable over a VPN, the workbench host needs that VPN.

### Auto-reconnect

A cookie session eventually dies. Declare `session` and `reconnect` on the
manifest and the server logs back in by itself, in the user's own Chromium,
captures the fresh cookies, and retries the call once. Plugins without these
blocks behave exactly as before.

```ts
export interface CookieConfig {
  type: "cookie";
  loginUrl: string;
  targetDomain: string;
  cookieDomains?: string[];
  session?: {
    probe?: { path: string; alive: number[] };        // GET, relative to targetDomain
    dead: { status: number[]; redirectTo?: string };  // redirectTo: Location path prefix
  };
  reconnect?: {
    credentials?: { key: string; label: string; secret?: boolean }[];
    allowHosts?: string[];                            // hosts outside cookieDomains (the IdP)
    steps: ReconnectStep[];
    timeoutMs?: number;                               // whole run; default 30000, max 120000
  };
}
```

`session.dead` says what a dead session looks like in a `ctx.http()` response: a
status in `status`, and, when `redirectTo` is set, a 3xx whose `Location` path
starts with it. `reconnect` is rejected without `session.dead`. `session.probe`
is optional; with it, a reconnect only counts once the probe returns a status in
`alive`. Without it, success is "at least one cookie captured, and the tab has
left `loginUrl`" (its URL no longer starts with it).

**SSO.** The identity provider's session in the persistent profile usually
outlives the app session, so the recipe just clicks through:

```ts
session: { probe: { path: "/api/v1/me", alive: [200] }, dead: { status: [401, 302] } },
reconnect: {
  allowHosts: ["idp.example.net"],
  steps: [
    { goto: "loginUrl" },
    { click: "text=Sign in with SSO" },
    { click: "[data-email]", optional: true, timeoutMs: 3000 },  // account picker, sometimes
    { waitUrl: "/dashboard" },
  ],
},
```

**Username and password.** The user keeps the credentials in the workbench vault:

```ts
session: { dead: { status: [401] } },
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

**Steps.** They run in order in a dedicated private tab, under the overall
`timeoutMs` (each step defaults to 10 s; the run deadline is enforced per step).
The private tab is invisible to the `browser_*` tools and to the live view, so
an agent cannot list it, evaluate in it or attach to it while it holds a
credential. The profile's password manager is turned off, so chromium never
saves a filled password.

| Step | Meaning |
|---|---|
| `{ goto }` | Navigate. `"loginUrl"`, a single-slash path on `targetDomain`, or an `http(s)` URL on an allowed host. |
| `{ click, optional?, timeoutMs? }` | Click the element. With `optional: true`, not found within the timeout means skip. |
| `{ fill, value, timeoutMs? }` | Set `value` on the field via the native value setter in an isolated world, then fire `input` and `change`. No keystrokes are typed. `{{cred:key}}` is valid only here. |
| `{ press }` | Press a key, for example `"Enter"`. |
| `{ waitFor, timeoutMs? }` | Wait for a selector to appear. |
| `{ waitUrl, timeoutMs? }` | Wait until the URL starts with a path or absolute URL. |

**Selectors** are CSS, or `text=<label>`: a case-insensitive substring match on
the visible text of `button`, `a`, `[role=button]` and `input[type=submit]`.
`text=` works for `click` and `waitFor` but not for `fill`; a fill target must be
a real, editable input. `goto` and `waitUrl` URLs may not contain whitespace or
control characters.

> [!WARNING] The host allowlist has two meanings
> Navigation may visit `targetDomain`, `cookieDomains` and `allowHosts`, and a
> subdomain of any of them. A credential is stricter: `fill` delivers it only
> when the page's hostname is an **exact** match for `targetDomain` or an
> `allowHosts` entry. If the login form lives on `login.idp.example.net`, list
> that exact host in `allowHosts` (or as `targetDomain`); `idp.example.net` alone
> will navigate there but refuse to type the password.

**Cooldown.** After a failed reconnect the connection is marked as needing a
manual reconnect and no further attempt runs for 10 minutes, at most six per
hour, so a wrong password or an MFA wall never hammers a login form. A
reconnect whose retried request is still refused counts as a failed attempt.
Saving new bindings, or reconnecting by hand from the portal, clears the
cooldown. A session import made with an API key or OAuth token stores the
cookies but leaves the cooldown in force, so an agent cannot loop the recipe. A reconnect
stands down without recording anything while the user is in the middle of a
portal connect (the connect link or live view), or when the browser is already
at its tab limit.

**Binding credentials.** For recipes with `credentials`, the user opens the
integration's detail page in the portal, picks a vault entry for each slot
under *Auto-reconnect*, and saves. Only the entry name is stored. The binding
endpoint accepts a portal session only, never an API key or an OAuth bearer, so
an agent cannot choose which secret is typed into a login form. SSO recipes have
no slots, so there is nothing to set up. The same section shows the last
attempt: reconnected, failed with a step number and reason code, or session
expired.

**Dead-session handling moves to core.** Once `session.dead` is declared, delete
any hand-rolled "session expired" throw in the plugin: core detects the dead
response, sets the connection to not connected, and either reconnects and
retries or returns the original response unchanged.

A bad recipe is dropped at load with a warning naming the step. The integration
still loads and manual connect keeps working. See the
[browser sessions guide](../guides/browser-sessions.md) for how the underlying
Chromium profile behaves.

## `none`

No credential. The integration is treated as always connected, so
`execute_tools` never returns `NOT_CONNECTED` and the portal shows no Connect
action.

```ts
auth: { type: "none" }
```

Only the two internal plugins, `browser` and `jots`, use it — their handlers
reach into server modules rather than an external API, so there is nothing to
authenticate. `ctx.http()` has no branch for `none`: it falls through to the
oauth2 path and calls `getToken()`, which throws `"Not connected"` because no
token is stored. In practice a `none` plugin should not call `ctx.http()` at all.
