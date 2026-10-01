# Admin page — design

Date: 2026-10-01
Status: draft, awaiting review

## Goal

Give instance operators an admin area inside the existing portal: see what the
instance is doing, manage users, and switch integrations and custom apps on or
off. Admins are named in an env var. No separate UI, no new auth system.

## Agreed scope

| # | Sub-project | Ships |
|---|-------------|-------|
| 1 | Gate + shell | `ADMIN_EMAILS`, `requireAdmin`, `/admin` tab shell, nav item |
| 2 | B: visibility | Read-only Overview tab (5 cards) |
| 3 | A: users | Users tab: list, disable/enable, revoke API key. DDL |
| 4 | C: config | Config tab: integration on/off, custom-app policy. DDL |

Build in that order. Each sub-project gets its own plan and PR. The A and C DDL
ship together in one release candidate (auth + schema, per CLAUDE.md).

**Out of scope:** user deletion; editing OAuth client ids/secrets (secrets stay
in env); a manual profile-reap button; per-user promote/demote (admin status is
derived from env); refresh-failure tracking on connections (would need DDL);
gating `/mcp` or `/rest` (agents never need admin).

## 1. Gate + shell

- `config.ts`: `ADMIN_EMAILS`, comma-separated, trimmed, lowercased, parsed once.
  Default empty, meaning admin is off. `.env.example` gets a placeholder
  (`admin@example.com`).
- `requireAdmin(request)`: verifies the **session JWT only**. The API-key path
  in `authenticate()` must not satisfy it, or an admin's MCP key would act as
  admin. It loads the user and compares `users.email` (DB value, not the JWT
  claim) against the allowlist. 401 without a session, 403 for a non-admin. All
  `/api/admin/*` routes use it.
- `GET /api/auth/me` adds `isAdmin: boolean`.
- Email trust: Google and Keycloak callbacks both reject an unverified email
  (`google.ts`, `keycloak.ts`), so an unverified address cannot reach the
  allowlist.
- Portal: `AuthContext` exposes `isAdmin`. The nav shows "Admin" only when true.
  `/admin` is wrapped in `RequireAdmin` (redirect to `/`). This is UX only; the
  server is the gate. One page with tabs: Overview, Users, Config. Sub-project 1
  ships the shell with an empty Overview.
- Tests: `requireAdmin` for no session, API key, non-admin, admin, and env case
  and whitespace; route 403; portal hides nav for non-admins.
- No DDL. `users.is_admin` stays unused.

## 2. B: visibility (read-only, no DDL)

Five independent endpoints, so one slow card does not blank the page. All behind
`requireAdmin`; none expose secrets or tool arguments.

1. **Instance** — version, DB backend, `CLUSTER_ENABLED`, `AUDIT_LOG_DEST`, user
   count, admin count (count only, no emails).
2. **Activity, all users** — the `/api/activity` keyset query without the user
   filter, plus user email. Keeps `stored:false` for non-sqlite audit
   destinations. Filters: integration, status, user. Keyset predicate stays the
   longhand `created_at < ? OR (created_at = ? AND id < ?)` (see the 2026-09-04
   finding).
3. **Connections by integration** — connected-user counts and a "needs
   reconnect" count. `connections` has no failure flag, so that means
   `expires_at` in the past **and** `refresh_token` null.
4. **Custom apps** — cross-user list: owner email, name, base URL, created. No
   client secret, no tokens.
5. **Browser profiles** — per-user dir size, last-use age, live or not, summed
   under `BROWSER_PROFILES_DIR`. With `CLUSTER_ENABLED` a process sees only its
   own volume, so the card is labelled "this worker only".

Note for docs: the allowlist grants read access to every user's tool-call
metadata.

Tests: seeded-sqlite endpoint tests (counts, the null-refresh edge, cross-user
cursor across a shared-second boundary), 403 per route, portal cards render
loading/empty/error independently.

## 3. A: users

**DDL:** `ALTER TABLE users ADD COLUMN disabled_at INTEGER` (nullable timestamp,
not BOOLEAN, to avoid the Postgres 1/0 gotcha). Same idempotent pattern as the
existing `ALTER`s in `db.ts`; `ADD COLUMN IF NOT EXISTS` on Postgres.

**Endpoints** (behind `requireAdmin`):
- `GET /api/admin/users` — id, email, created, has-API-key, connection count,
  custom-app count, last activity, disabled.
- `POST /api/admin/users/:id/disable` and `/enable`.
- `POST /api/admin/users/:id/revoke-key` — existing `clearApiKey`.
- Guards: cannot disable self; cannot disable an email on `ADMIN_EMAILS` (admins
  are env-managed, which also prevents lockout); unknown id is 404.
- Each action writes an `audit_log` row (`admin.user.disable`, ...), actor as
  `user_id`.

**Enforcement.** Credentials are verified in three functions, and every call
site goes through one of them: `verifyApiKey` (`auth/users.ts`), `verifySession`
(`auth/session.ts`; used by `api/routes.ts`, `oauth-server/resolve.ts`,
`cdp-bridge.ts`, `oauth-routes.ts`, `vault/routes.ts`), and `verifyAccessToken`
(`auth/oauth-server/tokens.ts`). Put the `isUserActive(userId)` check **inside
those three**, so a new call site cannot skip it. Also enforce it in the OAuth
refresh flow (`oauth-server/refresh.ts`) and in both SSO callbacks. Cost: one
primary-key lookup per request on the session path, which today never reads the
DB. On disable, delete the user's `oauth_refresh_tokens`.

A table-driven test runs every entry point (API key, session JWT, OAuth access
token, refresh, SSO callback, vault route, CDP bridge) against a disabled user
and expects rejection. That table is the guard against a missed path.

Left alone on disable: connections, vault, custom apps, files, so enabling
restores the account. A live chromium is not killed; its next request is
rejected and the TTL reaper cleans it up.

Other tests: disable/enable round trip, self and admin guards, refresh-token
revocation, sqlite and Postgres parity for the `ALTER`, portal Users tab with a
confirm dialog on disable.

## 4. C: config

**DDL:** new table
`instance_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at, updated_by)`.
Value is JSON text; no BOOLEAN columns. Keys:
- `disabled_integrations`: `string[]` of plugin names.
- `custom_apps_policy`: `{ mode: "all" | "none" | "allowlist", user_ids: string[] }`.

Nothing secret is stored here.

**Enforcement through the registry.** `registry.getTool`, `getIntegration`,
`listTools` and `listIntegrations` have about 25 call sites across
`meta-tools.ts`, `rest-routes.ts` and `routes.ts`. Inject an `isDisabled(name)`
predicate into `Registry` and filter in those four getters. A disabled
integration then vanishes from `search_tools`, `get_tool_schema`,
`execute_tools`, `/rest/*`, the connect flow and the portal app list. Add an
unfiltered `listAllIntegrations()` for the admin tab only.

**Cache.** The registry is synchronous, so the predicate reads an in-memory
snapshot. It reloads on every admin write in that process and polls the DB every
5s (configurable). Under `CLUSTER_ENABLED` or multiple pods, other processes lag
by at most the poll interval. Document this; do not claim instant propagation.

**Custom-app policy**, checked in three places: create (`routes.ts` custom-app
`POST`) returns 403 `custom_apps_disabled`; `ensureIndex` and `getToolForUser`
skip a user's apps when policy excludes them; the portal hides "add custom app".
Existing rows and tokens stay.

**Endpoints:** `GET /api/admin/config`;
`PUT /api/admin/config/integrations/:name` (404 on unknown plugin);
`PUT /api/admin/config/custom-apps` (validates mode and that user ids exist).
Each write goes to `audit_log`.

**Edge cases:** an in-flight OAuth flow for a just-disabled integration fails as
"unknown integration" (documented). Disabling does not revoke stored
connections.

Tests: all four registry getters hide a disabled integration; `search_tools`,
`execute_tools` and `/rest/:integration` each reject it; policy modes against
create and index; poll reload with a fake timer; 403 and audit-row tests.

## Cross-cutting

- **Release:** RC (auth + schema). Notes in `docs/releases/<stable-tag>.md` from
  the first RC, per CLAUDE.md.
- **Docs:** an Admin page under `docs/site/_content/` (`ADMIN_EMAILS`, what an
  admin can see, the poll-interval caveat) plus the nav entry in `nav.json`.
- **Findings:** one `docs/findings/` note and an index line in CLAUDE.md.
  Candidate content: the API-key path must not satisfy the admin gate, and
  enforcing "disabled" inside the verifiers rather than at call sites.
- **Hygiene:** fixtures use synthetic emails (`admin@example.com`,
  `dev@example.com`).

## Open questions

None blocking. Poll interval default (5s) and whether `disabled_integrations`
should also hide integrations from the portal Home for non-admins (current
design: yes, via the filtered registry) are the two details to confirm in
review.
