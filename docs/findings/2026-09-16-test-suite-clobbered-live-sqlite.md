# The test suite emptied the live SQLite database

**Date:** 2026-09-16
**Area:** `packages/server/vitest.config.ts`, `packages/server/tests/setup.ts`, `docker-compose.yml`

## What happened

A full `vitest run` of the server package rewrote `data/tokens.db` at the repo
root: the `users` table afterwards held one row, `bob`, a fixture from
`users.test.ts`. That file is what `docker-compose.yml` bind-mounts as the
container's `/data/tokens.db`, so the running server lost its only real user —
the SSO account, its API key, and with them the routing to that user's
workspace directory and browser profile (both keyed by user id).

## Why

Three things lined up, none of them wrong on its own:

- `config.DATABASE_URL` defaults to `./data/tokens.db`, relative to the
  process cwd.
- The test suite runs against a real SQLite file at that default, and the DB
  suites begin with `DELETE FROM users`. `fileParallelism: false` exists to
  keep those deletes from racing each other; nothing kept them off a
  database that mattered.
- The repo's `data/` directory is both the developer's local database and
  the compose bind mount for the live one.

Every previous run had a cwd of `packages/server` and wrote to
`packages/server/data/tokens.db`, a file nobody reads. One run resolved
`./data` against the repo root instead and hit the live file. Nothing in the
suite could tell the difference.

## Fix

`vitest.config.ts` now sets `DATABASE_URL` and `WORKSPACE_DIR` for the whole
suite to a per-process directory under the OS temp dir. A test
(`tests/db-isolation.test.ts`) asserts the resolved database path is absolute
and not under the repository, so a future config change that drops the
override fails immediately rather than on the next unlucky cwd.

## Recovery

The user row was re-inserted with its original id and email. Google SSO looks
a login up by `google_sub`, then by `email`, and links the sub on match, so
the next sign-in reattaches to the row — and to the workspace and profile
directories named by that id. The API key was not recoverable (only a hash and
an encrypted copy were stored, both in the lost row); it has to be minted
again in the portal.

## Lesson

A test suite that opens a real database at a relative default path is one
`cwd` away from production data. Pin the test database to a path the suite
owns, and assert it.
