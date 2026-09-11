---
title: Install
description: Run the server from source — Node and npm requirements, the workspace layout, the two required secrets, and how to create your first user.
---

workbench is an npm workspace monorepo. There is one server process, one React
portal that the server also serves as static files in production, and a set of
plugin packages the server imports at boot.

## Requirements

No package declares an `engines` field, so the effective floor comes from what is
actually built and tested:

| | Version | Where that comes from |
|---|---|---|
| Node | 20 or 22 | CI matrix runs both; the release build and the Docker image use 20 |
| npm | 10.2.0 | `packageManager` in the root `package.json` |

Chromium is only needed for cookie-auth and browser-session integrations. In the
Docker image it is baked in. Locally, Playwright installs it as a dependency.

## Workspace layout

| Package | Name | What it is |
|---|---|---|
| `packages/shared` | `@workbench/shared` | Types and zod schemas shared by server and portal |
| `packages/server` | `@workbench/server` | Fastify app: MCP endpoint, HTTP API, auth, plugin loader |
| `packages/portal` | `@workbench/portal` | Vite + React connection-management UI |
| `packages/plugins` | — | The 16 built-in integrations, one directory each |
| `packages/sample-oauth` | `@workbench/sample-oauth` | A throwaway OAuth provider for testing the connect flow |

## Commands

All four root scripts are thin `turbo` wrappers.

| Command | Task graph | What actually runs |
|---|---|---|
| `npm run build` | `dependsOn: ["^build"]` — topological | `shared` → `tsc`; `server` → `tsc`; `portal` → `tsc && vite build`; `sample-oauth` → `tsc` |
| `npm run test` | `dependsOn: ["build"]` | `server` → `NODE_ENV=test vitest run`; `shared` → `vitest run` |
| `npm run dev` | `cache: false`, `persistent` | `server` → `tsx watch --env-file=../../.env src/index.ts`; `portal` → `vite`; `sample-oauth` → `tsx watch` |
| `npm run lint` | — | Nothing. No package defines a `lint` script, so the task resolves to zero work and exits 0 |

The `test` task declares `ENCRYPTION_KEY` and `NODE_ENV` in its turbo `env` list,
so those two values are part of the cache key — a run under a different
encryption key never reuses a cached result.

Two server-only scripts are worth knowing:

```bash
npm run typecheck:tests -w @workbench/server   # tsconfig.json covers only src/
npm run test:coverage   -w @workbench/server   # what CI runs
```

## Minimum viable configuration

Two variables are required. Everything else has a default.

| Variable | Requirement | Generate with |
|---|---|---|
| `ENCRYPTION_KEY` | exactly 64 characters — 32 bytes of hex | `openssl rand -hex 32` |
| `SESSION_SECRET` | at least 32 characters | `openssl rand -base64 32` |

```bash
cp .env.example .env
printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
printf 'SESSION_SECRET=%s\n' "$(openssl rand -base64 32)" >> .env
```

`ENCRYPTION_KEY` is the AES-256-GCM key for every stored OAuth token, cookie
bundle, and API key copy. `SESSION_SECRET` signs four HS256 JWT types — the portal
session, MCP OAuth access tokens, connect tokens, and curl-session tokens — and
also keys the jot unlock cookie, which is a plain HMAC-SHA256 digest rather than a
JWT. Rotating the secret invalidates all five at once.

Both default to the empty string outside tests, and both have a length
constraint, so leaving them unset is a validation failure rather than a silent
weak default.

> [!WARNING] A bad value crashes the process at boot
> The whole configuration is one zod schema, and `configSchema.parse(process.env)`
> runs at module import time. A short `SESSION_SECRET`, a 63-character
> `ENCRYPTION_KEY`, a non-URL `SERVER_PUBLIC_URL`, or `CLUSTER_ENABLED=yes`
> (the enum accepts only `true`/`false`/`1`/`0`) aborts startup before any
> route, plugin, or database call runs.

The full table is in [environment variables](../reference/environment.md).

## Dev ports

The Vite dev server binds port 3000 with `strictPort: true` and proxies `/api`
and `/callback` to `http://localhost:3001`. The intended dev layout is therefore
**portal on 3000, server on 3001**.

`PORTAL_URL` defaults to `http://localhost:5173`, which is Vite's stock port and
not the one this repo uses. `PORTAL_URL` is half of the origin allowlist for the
CDP live-view endpoints, so leaving the default in place makes browser-session
capture fail with a 403.

```bash
cat >> .env <<'EOF'
PORT=3001
PORTAL_URL=http://localhost:3000
SERVER_PUBLIC_URL=http://localhost:3001
EOF
```

Then:

```bash
npm install
npm run dev
```

## Create the first user

There is no local password login and no user-creation endpoint. Users are created
either by an SSO callback (see [portal SSO](portal-sso.md)) or by the seed script,
which is the way to get going without configuring an identity provider.

```bash
cd packages/server
npx tsx --env-file=../../.env scripts/seed-local-user.ts [userId]
```

The user id defaults to `local-dev-user`. The script prints a workbench API key —
send it as the `x-workbench-api-key` header to authenticate against both `/api/*`
and `/mcp`. Re-running for the same user id rotates the key.

> [!NOTE] `POST /api/admin/users` does not exist
> Older onboarding docs described an admin user-creation endpoint. There is no
> `/api/admin/*` route in the server. Use the seed script or SSO.

To rotate or reveal a key later, the portal-authenticated routes are
`POST /api/keys`, `GET /api/keys`, `GET /api/keys/reveal`, and `DELETE /api/keys`.

## Testing OAuth without a real provider

`packages/sample-oauth` is a minimal OAuth authorization server that listens on
port 3002 and is wired into `docker-compose.yml` as its own service. It exists so
contributors can exercise the plugin OAuth connect flow — authorize, callback,
token exchange — without registering an application with Google, Atlassian, or
anyone else. `npm run dev` starts it alongside the server.
