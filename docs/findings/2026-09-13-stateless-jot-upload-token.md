# `pending_auth` is not the SSO table: durable jot upload tokens

## What was wrong

`deploy_jot` and `update_jot` hand back an upload URL — `/j/upload/<token>` — and the
token was a 32-byte random string kept in a module-level `Map` in
`packages/server/src/jots/pending.ts`. Nothing else knew about it.

Two consequences, one documented and one not:

- **A restart between mint and upload invalidated the token.** The guide said so.
- **`CLUSTER_ENABLED` broke it outright, and nothing said so.** The primary forks one
  worker per core. The mint happens on whichever worker served the tool call; the
  upload POST lands on whatever worker the OS hands the connection to. With no
  affinity on `/j/upload/:token` — unlike browser sessions, which got
  `X-Browser-Session` consistent hashing — the upload succeeded roughly 1/N of the
  time and otherwise returned a bare 404 with nothing to explain it.

## The table was already the answer

The instinct is that `pending_auth` is the SSO/OAuth table and that putting a jot
deploy in it would be a large, invasive change. It isn't, on either count.

The base schema is four generic columns — `state` (PK), `user_id`, `integration`,
`expires_at` — plus four **nullable** per-flow extras bolted on over time by the
idempotent `ALTER` list in `db.ts`: `session_data`, `code_verifier`, `config`, `nonce`.
Nothing is `NOT NULL`, and `integration` is the discriminator. Three flows already
shared it before this change:

| Flow | `integration` | Columns used |
|---|---|---|
| Plugin OAuth (`auth/oauth.ts`) | the plugin's name | `code_verifier`, `config`, `nonce` |
| Workbench SSO (google / keycloak) | same path | `nonce` |
| MCP `/authorize` ticket (`api/oauth-routes.ts`) | `'__oauth_authorize__'` | `session_data` |

That third one is not an OAuth handshake at all. It is a sentinel row with an empty
`user_id` and one JSON blob, and `oauth-server/resume.ts` scopes its read with
`WHERE state = ? AND integration = '__oauth_authorize__'`. So the precedent for "a
short-TTL single-use ticket that isn't auth" was already in the table.

A jot upload is the fourth, under `'__jot_upload__'`: `state` is the token,
`user_id` is the owner, `expires_at` is the TTL, and `session_data` holds the deploy.
**Zero DDL** — no new table, no migration, no change to `migrate/plan.ts`, which
already copies `pending_auth` (and already advises `--skip`ping it, since these rows
are dead within minutes either way).

Every read and delete is scoped to the sentinel, so the flow can neither see nor reap
another flow's row. Two tests hold that line: consuming an `__oauth_authorize__` row by
its state returns null and leaves it in place, and the reaper leaves an expired plugin
row alone.

## Single use is now a real guarantee

Storing the payload as a row buys the property that no stateless token can have.
`consume` selects the row and then deletes it — and **the delete, not the select, is the
arbiter**:

```ts
const { changes } = await db.run(
  "DELETE FROM pending_auth WHERE state = ? AND integration = ?", [token, SENTINEL]);
if (changes !== 1) return null;
```

Two concurrent uploads of one token both read the row, but the database serialises the
deletes and exactly one reports `changes === 1`. The loser is told the token is spent,
which is true. No transaction is needed: the `DELETE` is a single atomic statement, so
the read-then-write hazard on a pooled PostgreSQL connection (see the 2026-08-06
dialect notes) never arises. `DbAdapter.run` returning `{ changes }` is what makes this
expressible on both backends.

This is worth stating because the obvious alternative — a signed or encrypted
self-contained token (JWS/JWE) — is strictly worse here. It also survives restarts and
needs no stickiness, but it *cannot* be spent: single use degrades to a per-process
`jti` guard that a second worker knows nothing about. It also has to carry the owner id
and a password jot's scrypt hash inside a string that gets pasted into `curl` and kept
in shell history (so it must be encrypted, not merely signed), and a ~320-character
token in a path parameter trips find-my-way's 100-character `maxParamLength` — a 414
before the route handler ever runs — which then has to be raised at Fastify
construction, and bounds `update_jot`'s delete list by URL length. A row in a table has
none of those problems: the token stays a 64-character opaque handle that carries
nothing.

## Storage notes

`expires_at` is whole seconds, while the API hands back `expiresAt` in milliseconds.
Mint rounds **up** when storing, so the row never dies marginally before the timestamp
the caller was given.

The payload is a JSON blob rather than typed columns on purpose: `cors` is a boolean,
and the 2026-08-06 dialect notes record that PostgreSQL rejects `1`/`0` for a real
BOOLEAN column while better-sqlite3 rejects booleans. Keeping it inside `session_data`
sidesteps the whole question.

## Still open: the token is in the logs

`req.url` is deliberately not redacted in the Fastify logger, and the comment there
claimed "tokens were once in URLs but no longer are". That was never true of
`/j/upload/<token>`. The token is now an opaque handle that carries nothing, but the URL
*is* the credential, so a log reader can still replay it within the TTL — until someone
consumes it, which is now genuinely once. The comment is corrected; redacting the path
segment is unfinished work.
