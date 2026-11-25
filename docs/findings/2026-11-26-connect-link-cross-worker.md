# Connect links read as "already used" on first open

**Date:** 2026-11-26

## Symptom

An agent hit an expired integration, called `connect(...)`, and handed the
user a fresh link. Opening it and pressing Connect showed **"Link already
used"** almost every time, even though nobody had opened it before.

## Cause

Pending connections (`auth/connections.ts`) lived in a module-level `Map`.
Under `CLUSTER_ENABLED` every pod forks one worker per CPU, and a deployment
may run several replicas. The agent's `connect()` minted the record in one process;
the portal's `POST /api/connect/redeem` was load-balanced to another. That
process had never seen the `connectionId`, `getPending` returned nothing, and
the route answered `410 LINK_CONSUMED`, which the portal renders as "Link
already used". With N workers that is roughly (N-1)/N of all links.

The same split broke `wait_for_connection` (it polled a Map the OAuth callback
or cookie capture never wrote to, so it ran to TIMEOUT) and the
`browser_live_url` link. A restart also voided every outstanding link.

This is the same class of bug as the jot upload token
([2026-09-13](2026-09-13-stateless-jot-upload-token.md)).

## Fix

Pending connections are rows in `pending_auth` under the `__connect__`
sentinel. No DDL.

- `state` = connectionId, `user_id` = owner, `session_data` = JSON record
  (integration, type, status, createdAt, expiresAt, redeemedAt).
- `expires_at` = link expiry **plus a 1 h grace**, so the generic
  `pending_auth` sweep in `auth/oauth.ts` does not delete a record a
  `wait_for_connection` still needs to read as EXPIRED.
- Single use is a compare-and-swap on `session_data`
  (`UPDATE ... WHERE session_data = <what we read>`, `changes === 1`), atomic
  on SQLite and PostgreSQL without a transaction. Two concurrent redeems: one
  wins.
- A PENDING record past its expiry reads as EXPIRED on every read, so the
  reaper is an optimisation, not the source of truth. A link that expired
  cannot be flipped to CONNECTED afterwards.
- The store API became async; callers await it.
