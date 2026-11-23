# OAuth refresh: retry once on 401, one refresh at a time, dead grant is NOT_CONNECTED

**Date:** 2026-11-23

## Problems

All three sit in the shared plugin context, so they hit `/mcp`, `/rest` and Space calls alike.

1. **Refresh only on stated expiry.** `ctx.getToken()` refreshed when
   `expiresAt - 30s <= now`. A token that died early (revoked and re-granted, a
   provider that sends no `expires_in`, clock skew, rotated elsewhere) was sent
   anyway, and the 401 went back to the caller.
2. **Concurrent refreshes.** Nothing serialised them. A Space page fires several
   calls on load and an `execute_tools` batch runs items concurrently, so near
   expiry each one refreshed with the same refresh token. Providers that rotate
   refresh tokens (Atlassian, GitLab, ...) accept the first and reject the rest;
   some treat reuse as theft and revoke the grant, silently disconnecting the
   user. Adding a retry-on-401 without fixing this would make it worse: N
   rejected calls, N refreshes.
3. **A dead grant looked like an upstream error.** The connected check only asks
   whether a token row exists. An expired token with no refresh token, or a
   refresh the provider refused, threw inside the handler and came back as a
   generic error (a Space got `UPSTREAM_ERROR` 502), so nobody was told to
   reconnect.

## Fix

`packages/server/src/auth/token-refresh.ts`, used by `ctx.getToken()` and `ctx.http()`:

- **Retry once on 401** in `ctx.http()`, for `oauth2` grants with a refresh
  token and a body that can be re-sent. A 401 means the upstream rejected the
  credentials before doing anything, so re-sending a write is safe. A second
  401 is returned as is; a 403 is not retried. The Atlassian
  `accessible-resources` lookup returns its 401 into the same path instead of
  throwing.
- **One refresh at a time per (user, integration), across processes.**
  In-process callers share one promise. Across pods and cluster workers, a lock
  row in `pending_auth` under `__token_refresh__`: `INSERT ... ON CONFLICT DO
  NOTHING` arbitrates, the loser polls the token row and takes the winner's token.
  The lock is a row, not a held transaction: a `SELECT ... FOR UPDATE` would pin
  a pooled connection (`PG_POOL_MAX` defaults to 2) and on SQLite stall the whole
  transaction queue for as long as the token endpoint takes. The lock expires
  after 30 s if its holder dies; the next caller deletes it and takes over.
- **Re-read before refreshing.** If the stored token already differs from the one
  that was rejected, it is used without a refresh.
- **`TokenRefreshError`** for a missing refresh token or a token endpoint 400/401
  (RFC 6749 5.2: `invalid_grant`, `invalid_client`). `executeSingle` reports it as
  `NOT_CONNECTED` with a reconnect message; a Space maps that to its own
  `NOT_CONNECTED` (409). A 5xx or timeout from the token endpoint stays a plain
  error: it may be transient, and telling the user to reconnect would be wrong.

## Not covered

Custom MCP apps refresh through their own client (`custom-apps/oauth.ts`),
`curl_session` proxies requests itself, and clevertap builds its own requests.
A handler that catches `ctx.http()` errors and returns its own `{ error }` hides
`TokenRefreshError` from the mapping.
