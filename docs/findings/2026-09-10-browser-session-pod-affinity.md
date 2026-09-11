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
| `attach` | nothing to misroute any more — it starts nothing and any replica can mint |
| `events` | the key routes it to the owning replica; an unkeyed request is a 400, not a silent wrong-pod stream |
| `commands` | routed by the same key; a 404 or 409 makes the client re-attach rather than drop input silently |

Before the key existed, that last row was the real defect: a misrouted
`commands` 404'd and the client swallowed it, so a live-looking view had dead
input — worse than an error. The client now treats 404 and 409 as "this session
is gone", cancels its stream and re-attaches; it also distinguishes a 401
*after* the view was live ("Session ended") from one before it
("Unauthorized"), because after a session is reaped those are the same status
code with very different meanings.

## What we did about it

Consistent hashing on a key the client carries, with the expensive step moved
off the one request that cannot be routed.

`POST <base>/cdp/attach` used to require a warm session and dial chromium — the
worst possible arrangement, since it is the *only* request with no key to route
on. It now mints a key and starts nothing. The first `POST <base>/cdp/commands`
starts chromium on whichever replica the key routed it to, and every later
request follows the same hash. The minting replica is usually not the owning
replica, and that is fine: minting touches nothing.

The key is `HMAC(SESSION_SECRET, userId)`, carried as `X-Browser-Session`.
Deriving it from the userId rather than minting a random id per attach is
load-bearing, and it is the trap in this design: two keys for one user hash to
two replicas, both call `ensureSession(userId)`, and both spawn on that user's
one profile directory — so the second deletes the `SingletonLock` the first
one's live browser is holding, which is precisely the failure above,
self-inflicted. One user, one key, one replica.

It is a **routing hint, not a credential**. Every endpoint authenticates the
portal bearer first, and the session a request reaches is always that bearer's
own, resolved from the verified userId — never from the key. A leaked key alone
is a 401; another user's key with your bearer is a 400 that starts nothing for
either party. This also let `cdpToken` go: it was minted, transported to the
portal, and — once the 2026-09-02 fix made a portal session mandatory — checked
for nothing the bearer did not already prove.

Because the key is per user rather than per view, the same header routes
everything else that touches the browser: `GET /api/auth/:integration` and
`POST /api/connect/redeem` (both of which *warm* a browser inside the call),
`.../capture`, `.../cancel`, and `/api/browser-session/reset`. The portal sends
it on all of them.

### What an operator still has to get right

- **Hash to pod endpoints, not to a `Service`.** A ClusterIP behind the hashing
  hop re-round-robins and the hash is wasted.
- **Consistent hashing, not modulo.** `hash % N` remaps nearly every key when a
  pod comes or goes, so one rollout breaks every live session at once.
- **`CLUSTER_ENABLED` off.** Hashing reaches a pod, not a worker inside it.
- **`/mcp` carries no such header** — an MCP client will not send one. Hash that
  path on `Authorization`, which is equally per-user, or keep `browser_*` on a
  single replica.

Config lives in [the proxy setup](../deploy/docker.md#multiple-replicas).

When the owning replica does die, that session's chromium dies with it and the
client must start over — which is exactly the `NO_CHANNEL` → re-attach path the
live view already has.
