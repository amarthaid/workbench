---
title: Docker & Compose
description: What the image contains, how the Compose file is wired, mounting external plugins, and running behind a reverse proxy.
---

Released images are published to GHCR as `ghcr.io/<owner>/<repo>` (the repository
path lowercased), tagged with the git tag. `latest` moves only on stable
releases — see [releases and upgrades](releases.md).

> [!WARNING] Published images are `linux/amd64` only
> The release workflow's build step passes no `platforms:`, so GHCR gets a
> single-architecture image from the `amd64` GitHub runner. ARM hosts — Apple
> Silicon, Graviton — get emulation at best. Build locally on the target
> architecture instead.

## What the image builds

Two stages, both `node:20-bookworm-slim`. Debian on both sides is deliberate:
`better-sqlite3` is a native module and Playwright's chromium targets glibc, so an
Alpine/musl stage would break the native ABI when `node_modules` is copied across.

The builder stage installs `python3 make g++` (for a native-dep build if no
prebuild matches), copies only the four `package.json` files plus the lockfile for
a cacheable `npm ci`, then runs `npm run build`.

The runtime stage copies:

| From | To in image |
|---|---|
| `packages/server/dist` | `/app/server` |
| `node_modules` | `/app/node_modules` |
| `packages/portal/dist` | `/app/portal` |
| `packages/plugins` | `/app/plugins` |

It then deletes `node_modules/@workbench` and re-materializes
`@workbench/shared` as a real package — the workspace symlinks dangle because
`packages/` is not shipped. Chromium is baked in with
`npx playwright install --with-deps chromium` and made world-readable so any
runtime uid can execute it. `tsx@4.19.4` is installed globally.

| | Value |
|---|---|
| Exposed port | 3000 |
| Command | `tsx server/index.js` |
| `NODE_ENV` | `production` |
| `PLAYWRIGHT_BROWSERS_PATH` | `/ms-playwright` |

The entrypoint runs the *built JavaScript* through `tsx` because plugins are
`import()`ed as `.ts` files at runtime.

The image has no `USER` directive, so the process runs as root. That is why
chromium is always spawned with `--no-sandbox` and `--disable-dev-shm-usage` —
chromium refuses to start as root otherwise.

## Healthcheck

There isn't one. The Dockerfile declares no `HEALTHCHECK`, and the server exposes
no `/health`, `/healthz`, or `/readyz` route.

The only probe-able HTTP endpoint is `GET /metrics`, which is unauthenticated. Use
that or a plain TCP check on the listen port for orchestrator liveness probes. See
[observability](observability.md).

## Compose services

`docker-compose.yml` defines two services.

**`workbench`** — `build: .`, published on `3000:3000`.

- `env_file: [.env]` pulls SSO credentials *and* every per-plugin OAuth
  credential. Without them `/authorize` and `connect(<plugin>)` fail with
  `"<X> not configured"`.
- An `environment:` block sets six values so a developer `.env` cannot leak into
  the container and break the port mapping or the data volume: `PORT=3000`,
  `NODE_ENV=production`, `DATABASE_URL=/data/tokens.db`, `SERVER_PUBLIC_URL` and
  `PORTAL_URL` (both defaulting to `http://localhost:3000`), and
  `PLUGINS_DIR=/app/custom-plugins`.
- Volumes: `./data:/data` for the database and everything derived from its
  directory, plus `../custom-plugins:/app/custom-plugins:ro`.
- No healthcheck, no restart policy, no `depends_on`.

> [!WARNING] The committed Compose file cannot run a published release
> The service declares `build: .` and **no `image:` key**, so `docker compose pull`
> skips it entirely and `docker compose up -d` builds from your working tree. To
> run a GHCR tag you have to add an `image:` key — see
> [the upgrade procedure](releases.md).

**`sample-oauth`** — built from `Dockerfile.sample-oauth` on `3002:3002` with
`NODE_ENV=development`. A test OAuth provider for contributors, not something to
run in production.

There is **no `postgres` service**. If you want PostgreSQL, bring your own and
point `DATABASE_URL` at it — see [database](database.md).

> [!WARNING] The committed Compose file carries someone's local overrides
> One comment in `docker-compose.yml` is marked "LOCAL ONLY (do not commit)" and
> was committed anyway: the override `PLUGINS_DIR=/app/custom-plugins`. The bind
> mount it goes with, `../custom-plugins:/app/custom-plugins:ro`, is unmarked but
> just as local — its source is a *sibling of the repository*, so on any machine
> without that directory Docker creates it (owned by root) and you get an empty
> read-only mount rather than an error. The external-plugin pass then finds
> nothing there. Delete both lines, or create the directory, before using the file
> as-is.

One more Compose gap: `SESSION_SECRET` is not in the `environment:` block, so it
has to come from `.env`. With `NODE_ENV=production` forced on and no value
supplied, the empty default fails the 32-character minimum and the container exits
at import.

## Mounting an external plugins directory

Loading happens in two independent passes, and only the second one is governed by
`PLUGINS_DIR`.

| Pass | Where it looks | Controlled by |
|---|---|---|
| Built-ins | The first of `../plugins`, `../../plugins`, `./plugins` that exists, relative to the process working directory | Nothing — `PLUGINS_DIR` is not consulted |
| External | `PLUGINS_DIR`, resolved to an absolute path before `import()` | `PLUGINS_DIR` |

So pointing `PLUGINS_DIR` somewhere else does not unload the built-ins, and it
cannot be used to relocate them either. In the image the working directory is
`/app`, so the built-in probe finds `/app/plugins`. `PLUGINS_DIR` defaults to
`./plugins`, which resolves to that same directory, which is why the default
configuration loads the built-ins once rather than twice — the external pass skips
built-in directory names. The loader also refuses to load a directory named
`browser` or `jots` (reserved for the internal plugins).

To add your own plugins, mount them somewhere else and point `PLUGINS_DIR` there:

:::tabs
```yaml [docker-compose]
services:
  workbench:
    image: ghcr.io/<owner>/<repo>:v0.24.0
    ports:
      - "3000:3000"
    env_file: [.env]
    environment:
      - PORT=3000
      - NODE_ENV=production
      - DATABASE_URL=/data/tokens.db
      - PLUGINS_DIR=/app/custom-plugins
      - SERVER_PUBLIC_URL=https://workbench.example.com
      - PORTAL_URL=https://workbench.example.com
    volumes:
      - ./data:/data
      - ./custom-plugins:/app/custom-plugins:ro
```
```bash [docker run]
docker run -d --name workbench \
  -p 3000:3000 \
  --env-file .env \
  -e DATABASE_URL=/data/tokens.db \
  -e PLUGINS_DIR=/app/custom-plugins \
  -e SERVER_PUBLIC_URL=https://workbench.example.com \
  -e PORTAL_URL=https://workbench.example.com \
  -v "$PWD/data:/data" \
  -v "$PWD/custom-plugins:/app/custom-plugins:ro" \
  ghcr.io/<owner>/<repo>:v0.24.0
```
:::

Keeping the mount inside the repository directory means the file works for anyone
who clones it. If you set `PLUGINS_DIR` to a directory that does not exist, the
loader returns quietly and only the built-ins are registered.

## Reclaiming disk

Two trees grow on their own and nothing inside the server reclaims them: the
per-user browser profiles, and the [agent file workspace](../integrations/files.md).

Sweeping them is a **scheduled job**, not a timer inside the server. That is not
a style preference — a timer runs in every replica, so N pods would sweep the
same shared volume concurrently.

```bash
npm run reap -w @a-workbench/server            # both trees
npm run reap -w @a-workbench/server -- --files # workspace only
npm run reap -w @a-workbench/server -- --dry-run --json
```

Run it from exactly one place — a Kubernetes `CronJob`, a systemd timer, cron on
the host — hourly is ample.

It needs **no secrets**. Not the encryption key, not the session secret, not a
database connection: it takes a path and a number, and the only thing it needs
mounted is the volume it is sweeping. A reaper pod's credentials should stay
empty, and there is a test in the suite that runs the CLI with a blank
environment specifically to keep that true.

| Flag | Environment fallback | Default |
|---|---|---|
| `--dir` | `WORKSPACE_DIR` | — |
| `--profiles-dir` | `BROWSER_PROFILES_DIR` | — |
| `--ttl-hours` | `WORKSPACE_TTL_HOURS` | 24 |
| `--ttl-days` | `BROWSER_PROFILE_TTL_DAYS` | 30 |
| `--max-bytes-per-user` | `WORKSPACE_MAX_BYTES_PER_USER` | unset (no eviction) |

Workspace files go on age alone — no liveness check, no exception for something
mid-transfer. That is what lets the sweep run anywhere with no coordination, and
it is safe because a download still being written has an mtime of *now*, so its
age is effectively zero. Browser profiles are different: a profile whose session
markers moved inside the last hour is assumed to have a live Chromium holding it
and is left alone.

## Behind a reverse proxy

The server binds `0.0.0.0` on `PORT` and serves the portal itself — the built SPA
comes from `PORTAL_DIST_DIR` (`/app/portal` in the image), registered last so
`/api`, `/mcp`, and `/.well-known` 404s stay JSON and only genuine client routes
fall through to `index.html`. A single origin therefore serves the portal, the
HTTP API, the MCP endpoint, and the curl proxy.

```mermaid
flowchart LR
  A[Agent / MCP client] -->|POST /mcp| P[Reverse proxy TLS]
  B[Browser portal] -->|/api, CDP SSE| P
  C[OAuth provider] -->|redirect /api/auth/...| P
  P -->|HTTP :3000| S[workbench]
  S --> D[(Database)]
  S --> X[Chromium profiles]
```

Set both public URLs to the externally reachable origin:

| Variable | Set to | Why it matters |
|---|---|---|
| `SERVER_PUBLIC_URL` | The public origin of the server, e.g. `https://workbench.example.com` | Base for every OAuth redirect URI, the MCP protected-resource and authorization-server metadata, the `iss`/`aud` of OAuth access tokens, and whether the `awb_oauth_binding` cookie gets `Secure` (it does only when the value starts with `https://`) |
| `PORTAL_URL` | The origin the browser loads the portal from — the same value, when the server serves the SPA | SSO and connect redirect target, and half of the live-view `Origin` allowlist |

The allowlist for the CDP live-view endpoints is exactly the set
`{PORTAL_URL, SERVER_PUBLIC_URL}`. Anything else is rejected with a 403.

> [!WARNING] Only the incoming `Origin` is normalized — the allowlist is compared verbatim
> The browser's `Origin` header is reduced to `protocol//host` before the lookup,
> but `PORTAL_URL` and `SERVER_PUBLIC_URL` go into the set exactly as you wrote
> them. A trailing slash, a path suffix, or an explicit default port
> (`https://workbench.example.com:443`) can therefore never match any real origin,
> and every CDP attach 403s. Set both variables to a bare scheme-and-host origin
> with no trailing slash.

If cookie capture or the live browser view fails with a 403 behind your proxy,
check the two variables for that exact shape first, then check that they match the
origin the browser is actually using.

The live view needs no WebSocket support in your proxy — it is REST plus an
SSE stream (`.../cdp/events`). Your proxy must preserve the `Origin` header, and
must not buffer or compress that stream: the server sends
`Cache-Control: no-transform` and `X-Accel-Buffering: no`, which nginx honours;
other proxies may need response buffering disabled explicitly. Read
timeouts should exceed the 15s keepalive comment the stream emits.

### Multiple replicas

A browser session is process-local, so a user's browser traffic has to reach the
one replica that owns their Chromium. The server makes that routable: `POST
<base>/cdp/attach` mints a per-user key and starts nothing, and the portal then
sends it as **`X-Browser-Session`** on every call that touches a browser
session. Hash that header to a pod and the design works; ignore it and cookie
capture and the live view fail intermittently.

nginx-ingress, on the browser-session paths:

```yaml
nginx.ingress.kubernetes.io/upstream-hash-by: "$http_x_browser_session"
```

Istio/Envoy:

```yaml
trafficPolicy:
  loadBalancer:
    consistentHash:
      httpHeaderName: x-browser-session
```

Three things to get right, each of which silently breaks stickiness:

- **Hash to pod endpoints, not to a `Service`.** A ClusterIP behind the hashing
  hop re-round-robins and the hash is wasted. Use the controller's native
  endpoint routing (nginx-ingress and Istio both target pod IPs by default) or
  a headless service.
- **Consistent hashing, not modulo.** `hash % N` remaps nearly every key when a
  pod is added or removed, so one rollout breaks every live session at once.
  Ring hash or maglev moves only the keys it must.
- **`CLUSTER_ENABLED=false` wherever the browser feature is used.** It forks one
  worker per core, each with its own session map, and no ingress can route
  inside a worker pool.

Agent traffic to `/mcp` is **not covered by this** — an MCP client sends no such
header, and `Authorization` is not a usable substitute: `/mcp` accepts identity
as an api key (no `Authorization` header at all, so every such agent hashes
alike) or as an OAuth Bearer (which rotates at its TTL, moving the hash under a
live session). So if you run `browser_*` tools with more than one replica, pin
them — and that means pinning all `POST /mcp` traffic, since tool calls are not
separable by path. Full reasoning:
[browser session pod affinity](../field-notes/2026-09-10-browser-session-pod-affinity.md).

Run TLS at the proxy. The server speaks plain HTTP.
