---
title: Environment variables
description: Every variable the server reads, with its validation, default, and effect.
---

Configuration is one Zod schema parsed at module import time. A validation failure
crashes the process on boot, before routes are registered or plugins load — so a bad
value fails loudly and immediately rather than at first use.

Two variables are genuinely required. Everything else has a default.

| Variable | Requirement | Generate with |
|---|---|---|
| `ENCRYPTION_KEY` | exactly 64 hex characters | `openssl rand -hex 32` |
| `SESSION_SECRET` | at least 32 characters | `openssl rand -base64 32` |

Both default to `""` outside tests, and `""` fails validation — which is how the
requirement is enforced. When `NODE_ENV=test` they fall back to fixed development
values so the suite runs without setup.

> [!DANGER] `ENCRYPTION_KEY` is unrecoverable and unrotatable
> It is the AES-256-GCM key for every stored OAuth token, cookie bundle, and API key,
> read once at module load. There is no re-encryption path. If you change it or lose
> it, every stored credential becomes undecryptable and every user must reconnect
> every integration. It must also stay identical across a SQLite-to-PostgreSQL
> migration, which copies ciphertext verbatim. Back it up with the same care as the
> database.

## Core

| Variable | Type / validation | Default | Required | Purpose |
|---|---|---|---|---|
| `PORT` | string | `3000` | no | Listen port. The server binds `0.0.0.0` |
| `NODE_ENV` | `development` \| `production` \| `test` | `development` | no | Selects test defaults for the two secrets; also makes the jot cookie `Secure` in production |
| `SERVER_PUBLIC_URL` | URL | `http://localhost:3000` | no | The server's own public origin. Drives every OAuth redirect URI, the OAuth metadata documents, the access token's `iss`/`aud`, and half the WebSocket origin allowlist |
| `PORTAL_URL` | URL | `http://localhost:5173` | no | Where SSO and connect flows redirect the user; the other half of the WebSocket origin allowlist |
| `PORTAL_DIST_DIR` | string | `./portal` | no | First candidate path for the built portal SPA |
| `PLUGINS_DIR` | string | `./plugins` | no | External plugin directory. Always resolved to an absolute path before import |

> [!WARNING] The default `PORTAL_URL` does not match the dev portal
> The Vite dev server binds port 3000 with `strictPort`, so the default
> `http://localhost:5173` is wrong for local development. Unless you set
> `PORTAL_URL=http://localhost:3000`, the CDP WebSocket origin allowlist rejects the
> dev portal with a 403 and browser-session capture fails.

## Database

| Variable | Type / validation | Default | Required | Purpose |
|---|---|---|---|---|
| `DATABASE_URL` | string | `./data/tokens.db` | no | Backend selector and connection string. A `postgres://` or `postgresql://` prefix selects PostgreSQL; anything else is a SQLite file path |
| `PG_POOL_MAX` | positive integer | `2` | no | Maximum pooled connections **per worker** |
| `PG_CONNECT_TIMEOUT_MS` | non-negative integer | `5000` | no | Milliseconds to wait for a free pool slot. `0` = unlimited |

`DATABASE_URL` does more than pick a database: the browser-profile directory and the
jots directory both default to siblings of its dirname.

## Authentication and SSO

| Variable | Type / validation | Default | Required | Purpose |
|---|---|---|---|---|
| `ENCRYPTION_KEY` | string, exactly 64 chars (hex) | `""`; all-zeros when `NODE_ENV=test` | **yes** | AES-256-GCM key for tokens, cookie bundles, and the API-key copy |
| `SESSION_SECRET` | string, min 32 chars | `""`; fixed value when `NODE_ENV=test` | **yes** | Keys five credentials: the four HS256 JWTs (portal session, MCP OAuth access, connect, curl-session) and the jot unlock cookie, which is a plain HMAC-SHA256 digest rather than a JWT. Rotating it invalidates all five |
| `GOOGLE_CLIENT_ID` | string | — | no | Google Workspace SSO for portal login. Its presence alone enables the `google` provider |
| `GOOGLE_CLIENT_SECRET` | string | — | no | Required for the token exchange; without it the auth URL builds but the exchange throws |
| `KEYCLOAK_ISSUER_URL` | URL | — | no | OIDC discovery base for Keycloak SSO |
| `KEYCLOAK_CLIENT_ID` | string | — | no | Keycloak client, also the ID-token audience |
| `KEYCLOAK_CLIENT_SECRET` | string | — | no | Keycloak is a confidential client — no PKCE on this flow |

Keycloak counts as configured only when all three of its variables are set. The
Google callback URL is `${SERVER_PUBLIC_URL}/api/auth/google/callback` and the
Keycloak one is `${SERVER_PUBLIC_URL}/api/auth/keycloak/callback` — both server-side,
not portal-side.

## OAuth server (MCP clients)

| Variable | Type / validation | Default | Required | Purpose |
|---|---|---|---|---|
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | positive integer | `3600` | no | Lifetime of an MCP OAuth access token, and the `expires_in` value returned by `/token`. Also the revocation lag — revoking an agent does not invalidate live access tokens |
| `CONNECT_TTL_SECONDS` | positive integer | `600` | no | Pending-connection TTL and connect-JWT lifetime, used by `connect`, the browser live-URL route, and `browser_live_url` |

## Browser sessions

| Variable | Type / validation | Default | Required | Purpose |
|---|---|---|---|---|
| `BROWSER_PROFILES_DIR` | string | `dirname(DATABASE_URL)/browser-profiles` | no | Root for per-user Chromium profiles |
| `BROWSER_SESSION_TTL_SECONDS` | positive integer | `300` | no | Idle cutoff before a warm browser session is killed. Checked every 30 seconds |
| `BROWSER_PROFILE_TTL_DAYS` | non-negative integer | `30` | no | Age at which an unused whole profile is **deleted**. `0` disables deletion |
| `BROWSER_PROFILE_REAP_INTERVAL_SECONDS` | positive integer | `3600` | no | Disk-reaper interval. It also runs once immediately at boot |
| `BROWSER_DISK_CACHE_MB` | non-negative integer | `32` | no | Becomes Chromium's `--disk-cache-size` |

> [!WARNING] `BROWSER_PROFILE_TTL_DAYS` deletes credentials
> Deleting a profile logs that user out of **every** cookie-auth integration at once.
> The 30-day default is deliberately conservative. The cache trim that runs far more
> often is free by comparison. Raise it or set `0` if your users connect cookie
> integrations rarely.

### Capture proxy — read straight from `process.env`

These three are **not** in the config schema, so they are invisible to the boot-time
validation and easy to miss when reading `config.ts`. They are read directly where
Chromium is spawned.

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `CAPTURE_PROXY` | string | — | no | Passed to Chromium as `--proxy-server=` |
| `CAPTURE_PROXY_USERNAME` | string | — | no | Proxy username |
| `CAPTURE_PROXY_PASSWORD` | string | — | no | Proxy password |

Proxy authentication is armed only when all three are set. The answering handler
responds to proxy auth challenges specifically, and declines anything else. Because
they bypass the schema, a typo in one of these names fails silently rather than at
boot.

## Jots

| Variable | Type / validation | Default | Required | Purpose |
|---|---|---|---|---|
| `JOTS_DIR` | string | `dirname(DATABASE_URL)/jots` | no | Root for deployed jot files |
| `JOTS_MAX_BYTES` | positive integer | `5242880` (5 MiB) | no | Per-file and total decompressed size cap |
| `JOTS_MAX_FILES` | positive integer | `1000` | no | Maximum files in one archive, enforced during extraction |
| `JOTS_UPLOAD_TTL_SECONDS` | positive integer | `300` | no | Lifetime of a single-use upload token |

## Cluster

| Variable | Type / validation | Default | Required | Purpose |
|---|---|---|---|---|
| `CLUSTER_ENABLED` | `"true"` \| `"false"` \| `"1"` \| `"0"` | `false` | no | Forks one worker per available core |

Note the enum: an arbitrary truthy-looking string such as `yes` is a **validation
error** that crashes the boot, not a falsy value.

> [!WARNING] Cluster mode requires PostgreSQL and multiplies connections
> With a SQLite `DATABASE_URL` the process exits with status 1 and a clear message —
> SQLite cannot be shared across processes. The total connection count becomes
> `PG_POOL_MAX × worker count`, which must stay well under the server's
> `max_connections`. In-flight connection records are held in process-local
> maps, so they are not shared across workers. (The SSO nonce is stored in the
> `pending_auth` row and is shared across workers through the database.)

## Audit and telemetry

| Variable | Type / validation | Default | Required | Purpose |
|---|---|---|---|---|
| `AUDIT_LOG_DEST` | `sqlite` \| `stdout` \| `kafka` | `sqlite` | no | Where audit events go |
| `AUDIT_LOG_KAFKA_BROKERS` | string | — | no | **Declared but never read** |
| `AUDIT_LOG_KAFKA_TOPIC` | string | `audit-log` | no | **Declared but never read** |

`sqlite` writes to whatever backend `DATABASE_URL` selects, PostgreSQL included,
despite the name.

> [!WARNING] The `kafka` destination is not implemented
> `AUDIT_LOG_KAFKA_BROKERS` and `AUDIT_LOG_KAFKA_TOPIC` pass validation and are then
> read by nothing. Selecting `AUDIT_LOG_DEST=kafka` logs "Kafka not implemented,
> falling back to stdout" and prints the event as a JSON line.

There is no variable for tracing. OpenTelemetry instrumentation is registered but
starts with no exporter configured, so spans are produced and nothing exports them by
default. Any export has to come from the standard `OTEL_*` variables the OTel SDK
reads on its own.

## Plugin credentials

Per-plugin OAuth clients are read directly from `process.env` by name, not declared in
the schema. The prefix is the plugin name converted from kebab-case to
UPPER_SNAKE_CASE.

| Pattern | Example | Purpose |
|---|---|---|
| `<PLUGIN>_CLIENT_ID` | `GOOGLE_GMAIL_CLIENT_ID` | OAuth client ID. Without it the integration reports `configured: false` and cannot be connected |
| `<PLUGIN>_CLIENT_SECRET` | `GOOGLE_GMAIL_CLIENT_SECRET` | OAuth client secret. Empty or unset means a public, PKCE-only client — which is valid, not an error |
| `<PLUGIN>_ALLOWED_INSTANCES` | `GITLAB_ALLOWED_INSTANCES` | Comma-separated extra self-hosted origins for a plugin that declares `instance` |

There are 16 built-in plugins. The 14 that use OAuth, by the prefix they take:
`ASANA`, `ATLASSIAN_BITBUCKET`, `ATLASSIAN_CONFLUENCE`, `ATLASSIAN_JIRA`,
`GITHUB`, `GITLAB`, `GOOGLE_CALENDAR`, `GOOGLE_DOCS`, `GOOGLE_DRIVE`,
`GOOGLE_GEMINI`, `GOOGLE_GMAIL`, `GOOGLE_SHEETS`, `GOOGLE_SLIDES`, `SLACK`.

The other two take no `_CLIENT_ID` because they do not use OAuth: `newrelic`
(`NEWRELIC`) is API-key auth, and `httpbin-cookie` (`HTTPBIN_COOKIE`) is
cookie auth.

`<PLUGIN>_ALLOWED_INSTANCES` entries are each normalised: https only, no userinfo in
the URL, and no private or loopback address literals. The manifest's cloud default is
always allowed — with the variable unset, it is the *only* allowed origin. This is
what stops a shared client secret being POSTed to an attacker-chosen host.

New Relic's key, region, and account ID are entered per user in the portal — the
running server never reads them from the environment. The one exception is the
shipped verification script, below.

## Migration and tooling

Read only by the shipped scripts and by tests — never by the running server.

| Variable | Read by | Purpose |
|---|---|---|
| `SOURCE_SQLITE_PATH` | migration | Overrides the source database path |
| `TARGET_DATABASE_URL` | migration | Target connection string. Must start `postgres://` or `postgresql://` |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | migration | libpq-style fallback when `TARGET_DATABASE_URL` is unset. Host, user, and database are required; port defaults to 5432 |
| `TEST_POSTGRES_URL` | test suite | Enables the PostgreSQL half of the database-adapter suite. Without it that half skips loudly |
| `NEW_RELIC_API_KEY` | `scripts/verify-newrelic.ts` | NerdGraph user key the script authenticates with |
| `NEW_RELIC_REGION` | `scripts/verify-newrelic.ts` | Uppercased; selects the region-scoped NerdGraph endpoint. Defaults to `US` |
| `NEW_RELIC_ACCOUNT_ID` | `scripts/verify-newrelic.ts` | Account to query, parsed as a number |

> [!NOTE] `.env.example` is incomplete
> It documents 11 of the 31 schema variables. Missing entirely: `NODE_ENV`,
> `PORTAL_DIST_DIR`, `OAUTH_ACCESS_TOKEN_TTL_SECONDS`, every `BROWSER_*`, every
> `JOTS_*`, both `PG_*`, both `AUDIT_LOG_KAFKA_*`, all three `KEYCLOAK_*`,
> `CLUSTER_ENABLED` (present only as a comment), every `CAPTURE_PROXY*`, and
> `<PLUGIN>_ALLOWED_INSTANCES`. On the plugin side only the seven Google plugins
> get real `_CLIENT_ID` / `_CLIENT_SECRET` placeholders: six more (`GITHUB`,
> `SLACK`, `ATLASSIAN_JIRA`, `ATLASSIAN_CONFLUENCE`, `ATLASSIAN_BITBUCKET`,
> `ASANA`) appear only as commented examples, and `GITLAB` is absent altogether.
> Treat this page as the list, not that file.
