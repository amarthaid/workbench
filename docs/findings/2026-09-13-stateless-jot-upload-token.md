# The jot upload token: from a heap Map to an encrypted JWT

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

The OAuth side had already solved the same problem the other way: PKCE verifiers,
state, and SSO nonces live in `pending_auth`, so they survive restarts and need no
stickiness.

## Why encrypted, not signed

The obvious fix is a signed token — a JWT, the house idiom (`jose` + HS256 + `aud`/`iss`,
as in `auth/connect-token.ts`). It is the wrong primitive here.

A JWS publishes its payload. Anyone holding the token can base64-decode the claims.
This token's claims are the owner's user id and, for a password jot, the scrypt hash of
the jot password — and this token is pasted into a `curl` one-liner, handed to an agent,
and kept in shell history. Today's opaque random string leaks neither. A signed token
would leak both, and would turn a weak jot password into an offline cracking target.

So the token is a **JWE**: `dir` key management, `A256GCM` content encryption. GCM
authenticates as well as encrypts, so the ciphertext tag is the integrity check and no
separate signature is needed. The token stays as opaque as the random string it replaced.

The content key is HKDF-derived from `SESSION_SECRET` rather than used raw — `dir`/A256GCM
needs exactly 32 bytes, and a distinct `info` string keeps this key separate from the
HS256 signing that the same secret does elsewhere.

## The part that bit: find-my-way's 100-char `maxParamLength`

A JWE carrying these claims is ~320 characters. A path parameter over **100** characters
is rejected by Fastify's router before the route handler runs — the tests went red with
`414 URI Too Long`, not a jots error. The default exists to bound param work, and 100 is
far below anything real: nginx's default request-line buffer is 8 KiB.

The fix is one server option, but it is set at Fastify construction rather than per route
(`maxParamLength` belongs to the find-my-way instance; Fastify plugin encapsulation does
not create a new router). In Fastify 5 it goes under `routerOptions` — passing it at the
top level still works but warns with `FSTDEP022`.

`maxParamLength` is fed from `MAX_TOKEN_CHARS`, the same constant `mint` refuses to
exceed, so the router's bound and the mint bound are one number by construction.

## What this cost

Everything in the payload is fixed-size except `update_jot`'s `deletes`, which is now
bounded by what fits in a URL rather than by available memory. Past the bound `update_jot`
returns `TOO_MANY_DELETES` at mint time, before any upload — the settings half of the call
has already been applied, so the caller retries only the file half with a shorter list.
~2 KiB of token holds on the order of 50 paths; the tool is pitched at refreshing one data
file, so this is a bound in name more than in practice.

## Single use is now best-effort

A stateless token cannot be spent. What remains is a per-process `Map` keyed by the
token's `jti`, held only until the token would expire anyway — so replay is blocked on the
worker that saw the upload, and not on its siblings. This is defence in depth; **the TTL
is the actual boundary.** The upload URL should be treated as a live credential until it
expires, which was already true — the endpoint takes no other authentication.

## Still open: the token is in the logs

`req.url` is deliberately not redacted in the Fastify logger, and the comment there
claimed "tokens were once in URLs but no longer are". That was never true of
`/j/upload/<token>`. Encrypting the token does not help — the URL *is* the credential, so
a log reader can replay it within the TTL on a worker that has not seen it. The comment
is now accurate about what the URL carries; redacting the path segment is unfinished work.
