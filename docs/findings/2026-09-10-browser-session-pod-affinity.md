# A browser session lives in one process, and the live view now says so out loud

Everything about the per-user Chromium is process-local:

| State | Where | Scope |
|---|---|---|
| the chromium process | a child of the server process, DevTools on `127.0.0.1:<ephemeral>` | that container's network namespace — no other replica can reach it |
| `warmSessions` (userId → cdpToken, page WS URL) | module-level `Map`, `auth/browser-session.ts` | one process |
| `activeProfiles` (per-user spawn lock) | module-level `Set`, `auth/profile-chromium.ts` | one process |
| `channels` (live-view bridge) | module-level `Map`, `auth/cdp-bridge.ts` | one process |

None of it is in the database, so **every request that touches a browser
session must reach the process that owns it**. With `CLUSTER_ENABLED` that is a
*worker*, not a replica: N forked workers in one container hold N independent
maps, and no ingress-level stickiness can route inside them. Run the browser
feature single-process, or accept that a session is only reachable by luck.

This is not new and not specific to the live view. It has always applied to:

- `GET /api/auth/:integration` — spawns the chromium, on whichever process
  answers
- `POST /api/auth/cookie/:integration/capture` — `captureLiveCookies` throws
  `No browser session for user` anywhere else
- every `browser_*` MCP tool — each calls `ensureSession`, so on a process
  without the session it **spawns a second chromium on the same profile
  directory**

That last one is the sharp edge. `clearStaleSingletonLocks` reasons that "any
lock we find here is stale by definition: no live session we know of owns it",
which is true exactly once per process — the `activeProfiles` set it relies on
is local. Two processes sharing a profiles volume break the premise: the second
deletes the `SingletonLock` the first one's live chromium is holding. See
[the stale singleton lock finding](2026-06-09-chromium-singleton-lock-stale.md)
for the failure it was written for.

## What changed with the SSE + REST bridge

Nothing about the requirement — only how visible it is. The old CDP WebSocket
needed **one** routing decision; every frame afterwards followed that socket.
The bridge is four independently routed requests (`attach`, `events`, each
`commands` POST, `detach`), so a deployment that was getting away with loose
routing stops getting away with it:

| Misrouted request | Result |
|---|---|
| `attach` | `getWarmCdpEndpoint` finds nothing → 401, and the client stops (retrying cannot fix a credential) |
| `events` | 404 `NO_CHANNEL` → the client retries, then gives up |
| `commands` | 404 — which the client first swallowed, so frames kept painting while every click went nowhere |

That last row was the real defect: a live-looking view with dead input is worse
than an error. The client now treats a 404 on `commands` as "this channel is
gone", cancels its stream, and re-attaches; it also distinguishes a 401 *after*
the view was live ("Session ended") from one before it ("Unauthorized"), because
after a session is reaped those are the same status code with very different
meanings.

## Deploying it

Sticky routing keyed to the portal user for `/api/auth/*`,
`/api/browser-session/*` and `/mcp`. Portal requests are same-origin, so they
carry cookies and a cookie-affinity ingress works; `ClientIP` affinity also
works but buckets everyone behind one NAT together. `CLUSTER_ENABLED` must be
off wherever the browser feature is used.

Beyond stickiness the honest options, none of them implemented, are: record the
owning process's address with the session and redirect the client to it (a `307`
works precisely because this client is a browser following HTTP); pin users to
replicas by consistent hash; or run the browser feature on a single dedicated
replica. Until one of those exists, "one user's browser lives on one replica" is
a deployment constraint, not an implementation detail.
