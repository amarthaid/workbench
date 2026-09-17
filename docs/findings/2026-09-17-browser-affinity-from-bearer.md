# Browser affinity comes from the bearer, not from the agent

**Date:** 2026-09-17

## What we found

Since the pod-affinity fix ([2026-09-10](2026-09-10-browser-session-pod-affinity.md)) every `browser_*` tool took a `session_id` that was `HMAC(SESSION_SECRET, userId)`, and the `/mcp` handler dug it out of `executions[].args` to set `X-Browser-Session` on the hop to the internal service. But that handler had already resolved the bearer to a `userId` before it looked — the agent was carrying a value the server could compute from what it already had.

Two consequences:

- `session_id` was spent on routing, so there was no way to name a second tab. One user, one page.
- `POST /rest/:integration` runs the same tools through the same engine but never forwarded at all, so under `CLUSTER_ENABLED` a `POST /rest/browser` could spawn a second Chromium on the shared profile and fight the first for `SingletonLock`.

## What changed

- One helper (`auth/affinity-forward.ts`) sets `X-Browser-Session: mintSessionKey(userId)` when a `/mcp` `tools/call` or a `POST /rest/browser` touches a `browser_*` tool. The agent's arguments are never consulted.
- `session_id` now names a tab (a Chromium `targetId`) inside the caller's own session. `browser_start` opens one; `browser_tabs` lists them; `browser_close` closes one. Lookup is scoped to the caller's `WarmSession`, so no HMAC is needed on the id.
- The key stays an HMAC rather than the raw user id: the portal live view already hashes on it, and a user id does not belong in mesh headers or proxy logs.

## What did not change

The portal live view still sends the header from the client: its requests meet the proxy before any server code runs, so the server cannot add it. `attach` mints the key exactly as before. Both paths hash on the same value.
