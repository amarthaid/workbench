# Browser session_id review: three tools missed the key, none checked it

**Date:** 2026-09-16
**Area:** `packages/server/src/plugins/internal/browser.ts`, `packages/portal/src/components/CdpScreencast.tsx`

## What was reviewed

The whole browser feature after the 2026-09-15 change that moved the routing
key into tool arguments (`browser_start` mints `session_id`, `/mcp` lifts it
into `X-Browser-Session` and proxies to `INTERNAL_MCP_URL`): agent path over
MCP, human path over the portal's live view, and how the two stay on one
Chromium.

## What holds up

- **The portal already carries the routing header everywhere.** `attach`
  mints it, and `events`, `commands`, `detach`, the connect-link redeem, and
  the portal-initiated live URL all send `X-Browser-Session`. Nothing to add
  on the React side.
- **Human and agent share the same tab.** The bridge's `ensureUpstream` dials
  `session.cdpPageWsUrl` of the same `WarmSession` the tools use, so the live
  view is the agent's page, not a sibling target. Closing the tab detaches the
  channel and leaves Chromium running; the agent's next call continues there.
- **The link is a claim, not a capability.** Redeem checks the portal session
  matches the user in the token before warming anything (2026-09-02 finding).

## What did not

1. **Three tools had no `session_id`**: `browser_expect_download`,
   `browser_await_download`, `browser_upload_file`. Under `INTERNAL_MCP_URL`
   these were never proxied, so they ran on a random replica: `ensureSession`
   there spawns a second Chromium on the shared profile and fights over the
   `SingletonLock`; `awaitDownload` looks up a handle in a `Map` that lives in
   another process and reports it unknown. Single-replica deployments never
   see it, which is why it survived.
2. **No handler verified the key it was given.** It was required by the
   schema and then ignored — routing only. Behind a load balancer a wrong key
   has already been hashed to the wrong replica when it arrives, and running
   the tool there is exactly the double-spawn above. The bridge's `keyed()`
   guard already refuses a bad key with `BAD_SESSION_KEY`; the tools now do
   the same, before `ensureSession`.

## What `session_id` is

`HMAC(SESSION_SECRET, userId)`. Same value every call, per user, forever
(until the secret rotates). It is a routing key so an L7 proxy can hash on it,
and a cheap "you meant this user" check. It is **not** a session handle: one
user has one Chromium, one profile lock, one page. Calling `browser_start`
twice gives the same key; two agents on one user share a tab. Multiple
concurrent sessions per user would need per-session CDP targets (tabs) inside
that one Chromium, with the routing key still per user — a real feature, not
a tweak, and out of scope here. The docs now say so instead of implying
otherwise.

## Also added

`browser_evaluate` — `Runtime.evaluate` with `returnByValue` and
`awaitPromise`, the `page.evaluate` shape. Selector-driven clicks and DOM
scraping were impossible with coordinates alone. A thrown exception comes
back as `EVALUATION_FAILED`, a result over 100k characters as
`RESULT_TOO_LARGE` rather than truncated (a sliced JSON string is not JSON).

`files_read` and `files_write` descriptions now name `files_presign` as the
path for anything large. The old text said "use the REST endpoint", which is
not something the model can call.
