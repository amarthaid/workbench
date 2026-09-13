---
title: Jots file store
description: Deploy a self-contained static site from an agent and serve it at /j/<name>/, public or password-gated.
---

A jot is a static web artifact the workbench hosts for you: a report, a chart, a small
tool, a page an agent built. You deploy a directory as a gzip tarball and it is served
at `/j/<name>/`.

Jots are a built-in integration (`auth.type: "none"`), so they are always connected and
need no credential. They live in server source rather than the plugin directory, because
their handlers write to the filesystem — a capability the plugin context deliberately
does not expose.

## The five tools

| Tool | Does |
|---|---|
| `deploy_jot` | Validates the name and returns an upload URL plus a single-use token. Publishes the whole site |
| `update_jot` | Same, in patch mode: the archive is overlaid onto the live site instead of replacing it |
| `list_jot_files` | Lists the files inside a jot you own — path, bytes, updatedAt |
| `list_jots` | Lists **your** jots — name, access, url, updatedAt, newest first |
| `delete_jot` | Deletes a jot you own; `FORBIDDEN` for another owner, `NOT_FOUND` if absent |

## Deploying

Deployment is two steps: mint, then upload.

:::steps

### Call deploy_jot

```json
{ "executions": [ { "tool": "deploy_jot",
  "args": { "name": "release-report", "access": "public" } } ] }
```

```json
{
  "result": {
    "uploadUrl": "https://workbench.example.com/j/upload/9f2c…",
    "token": "9f2c…",
    "expiresAt": 1756400300000,
    "maxBytes": 5242880
  }
}
```

### Upload the tarball

Package the directory's *contents* — the archive root must be the site root — and POST
the gzip stream:

```bash
tar czf - -C ./site . \
  | curl --data-binary @- \
      -H 'Content-Type: application/gzip' \
      https://workbench.example.com/j/upload/9f2c…
```

### Open it

```
https://workbench.example.com/j/release-report/
```

`/j/release-report` without the trailing slash redirects to it. Directories fall back to
`index.html`.

:::

The upload replaces any previous deploy of that name wholesale — this is a publish, not
a merge. To change one file without re-uploading the site, use
[`update_jot`](#updating-one-file) instead.

## Updating one file

`deploy_jot` republishes everything. When only one file changes — a `data.json`
regenerated weekly, a chart's dataset, a config blob — `update_jot` overlays your
archive onto the live tree and leaves the rest alone.

:::steps

### See what is there

```json
{ "executions": [ { "tool": "list_jot_files",
  "args": { "name": "release-report" } } ] }
```

```json
{
  "result": {
    "files": [
      { "path": "data.json", "bytes": 4120, "updatedAt": "2026-08-24T00:05:00.000Z" },
      { "path": "index.html", "bytes": 18233, "updatedAt": "2026-08-24T00:05:00.000Z" }
    ]
  }
}
```

Owner-scoped, like `list_jots`. The internal manifest is never listed.

### Mint a patch token

```json
{ "executions": [ { "tool": "update_jot",
  "args": { "name": "release-report" } } ] }
```

Returns the same `{ uploadUrl, token, expiresAt, maxBytes }` shape as `deploy_jot`.

### Upload only what changed

```bash
tar czf - -C ./site data.json \
  | curl --data-binary @- \
      -H 'Content-Type: application/gzip' \
      https://workbench.example.com/j/upload/3a71…
```

:::

Pass `delete` to remove paths — a directory removes its contents:

```json
{ "executions": [ { "tool": "update_jot",
  "args": { "name": "release-report", "delete": ["last-quarter", "stale.json"] } } ] }
```

Deletes are applied to the staged copy *before* the archive is overlaid, so a path that
is both deleted and uploaded keeps the uploaded version.

Two differences from a deploy are worth holding onto:

- **No `index.html` needed in the archive.** The live one is retained, so a patch that
  ships only `data.json` is fine. A deploy in the same shape would be rejected with
  `NO_INDEX`.
- **Access is inherited by the upload.** `access` and the password hash are read from the
  live jot rather than from the token, so the archive you upload can never change who can
  read a jot. To change that, pass the settings to `update_jot` itself — see below.
  Redeploy for that.

Ownership is re-checked when the upload lands, not just at mint: a jot that has been
deleted meanwhile returns 404, and one that changed hands returns 403.

The **merged** tree is re-measured against both limits. `JOTS_MAX_BYTES` and
`JOTS_MAX_FILES` are enforced during extraction, which only sees the archive — so
without this check a run of small patches could walk a jot past either cap. A patch that
would push it over returns 413 (`TOO_LARGE` or `TOO_MANY_FILES`) and leaves the live jot
untouched.

## Changing access, password, or CORS

Those three settings do not need an upload at all. Pass them to `update_jot` and they are
written to the live jot as soon as the call returns:

```json
{ "executions": [ { "tool": "update_jot",
  "args": { "name": "release-report", "access": "password", "password": "hunter2" } } ] }
```

```json
{ "result": { "uploadUrl": "…", "token": "…", "expiresAt": 1756000000000,
  "applied": { "access": "password", "cors": false } } }
```

The `applied` block is the confirmation that the change is already live. The `uploadUrl`
comes back as always, for file changes in the same call; ignore it and it simply expires.

- **Lock a jot:** `{ "access": "password", "password": "…" }`, or just `{ "password": "…" }`.
- **Unlock it:** `{ "access": "public" }`. The stored hash is dropped.
- **Rotate the password:** pass a new `password`. Restating `access: "password"` without
  one keeps the current password.
- **Toggle CORS:** `{ "cors": true }` or `{ "cors": false }`.

Anything you leave out keeps its current value, and the files are untouched either way.

> [!NOTE] Changing a password signs everyone out
> A visitor's unlock cookie is an HMAC over the current password hash, so rotating the
> password — or unlocking the jot and gating it again — invalidates every cookie already
> issued for it. Whoever still needs in has to enter the new password.

## The guards, in order

`deploy_jot` checks three things before minting anything, and returns on the first
failure.

| Order | Error | Cause |
|---|---|---|
| 1 | `INVALID_NAME` | The name is not `^[a-z0-9][a-z0-9-]*$`, or is longer than 64 characters |
| 2 | `PASSWORD_REQUIRED` | `access: "password"` was requested without a `password` |
| 3 | `JOT_NAME_TAKEN` | The name exists and belongs to a different user |

> [!WARNING] Jot names are global and creator-locked
> There is no per-user namespace. `report` is one name across the whole server, owned by
> whoever deployed it first. The original owner can redeploy it freely. Everyone else
> gets `JOT_NAME_TAKEN` and cannot overwrite or delete it. On a shared workbench, prefix
> your names.

## The upload token

The token returned by `deploy_jot` is **single use** and expires after
`JOTS_UPLOAD_TTL_SECONDS` (default 300). It carries the owner, the name, the access
mode, and — for a password jot — the already-hashed password. The password itself is
hashed at mint and never travels with the upload.

Because the token carries everything, the upload endpoint takes no other authentication.
It is the credential. A consumed or unknown token returns 404, and `expiresAt` is epoch
milliseconds.

The token is stateless: an encrypted JWT (a JWE, `dir` + `A256GCM`) whose claims carry
the owner, name, mode, gating, and delete list. The server keeps no record of it, so it
survives a restart and works on any worker or replica — nothing needs sticky routing.
It is encrypted rather than merely signed because those claims include the owner's user
id and a password jot's scrypt hash, and a signed JWT would publish both to anyone
holding the URL.

Single use is enforced by a per-process guard on the token's `jti`, kept only until the
token would expire anyway. That guard is best-effort: under `CLUSTER_ENABLED` or across
replicas a replayed token landing on another worker is still accepted. The short TTL,
not the guard, is the boundary that matters — treat the upload URL as a live credential
until it expires.

## Upload failures

| Status | Body | Cause |
|---|---|---|
| 404 | — | Unknown or already-consumed token |
| 413 | `{"error":"TOO_LARGE"}` | Decompressed size over `JOTS_MAX_BYTES` |
| 413 | `{"error":"TOO_MANY_FILES"}` | More than `JOTS_MAX_FILES` entries |
| 400 | `{"error":"BAD_ARCHIVE"}` | Not a readable gzip tarball |
| 400 | `{"error":"NO_INDEX"}` | No `index.html` at the archive root |
| 409 | `{"error":"JOT_NAME_TAKEN"}` | The name was claimed between mint and upload |
| 500 | `{"error":"DEPLOY_FAILED"}` | The publish step failed |

`update_jot` returns `{"error":"TOO_MANY_DELETES"}` at mint time, before any upload, when
the `delete` list is long enough to push the token past the URL-length bound. Split the
cleanup across two calls.

`NO_INDEX` is the one that catches people. The archive root must contain `index.html`
directly — that is what `/j/<name>/` serves. Archiving the directory itself instead of
its contents produces `site/index.html` at the root and a rejected upload. Note the
`-C ./site .` in the command above: it is doing the work.

## Password-protected jots

```json
{ "executions": [ { "tool": "deploy_jot",
  "args": { "name": "internal-notes", "access": "password", "password": "…" } } ] }
```

A locked jot behaves differently by client:

- A **browser navigation** gets HTTP 200 and an unlock page. Submitting the password
  sets an httpOnly, `SameSite=Lax` cookie scoped to that jot, good for 30 days, and
  redirects into the site. Production deployments mark it `Secure`.
- Anything else — a `curl`, a `fetch` — gets **401 Unauthorized**.

A wrong password re-renders the unlock page with an error and 401.

This is access control for casual sharing, not a secrets store. Anyone with the URL and
the password reads the content.

## How jots are served

Every jot response carries a restrictive header set. The important one:

```
Content-Security-Policy: sandbox allow-scripts allow-forms
```

That puts each jot on an **opaque origin**. Scripts run, forms submit, but the page
cannot read the workbench's cookies or make credentialed same-origin requests to `/api`
or `/mcp`. Responses also carry `nosniff`, `X-Frame-Options: SAMEORIGIN`, and
`Cross-Origin-Resource-Policy: same-origin`.

> [!WARNING] By default, a jot cannot fetch its own data files
> The opaque origin means same-origin `fetch` from inside a jot does not work. Pages
> must be **self-contained**: inline the data, or embed it as a data URI. Loading
> `data.json` alongside `index.html` at runtime will fail. This is the single most
> common surprise when deploying a page that worked locally — see `cors` below for the
> opt-out.

### Letting a jot read its own files

Pass `cors: true` on `deploy_jot` or `update_jot` to serve a **public** jot's files with
`Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, and to
answer preflight `OPTIONS` requests. That is what makes `fetch('./data.json')` work from
inside the page.

```json
{ "executions": [ { "tool": "deploy_jot",
  "args": { "name": "weekly-metrics", "access": "public", "cors": true } } ] }
```

This pairs naturally with `update_jot`: the page ships once, and the weekly data file is
patched in on its own. `update_jot` can also flip the flag on a jot that is already
live — `cors: true` to turn it on, `cors: false` to turn it back off — with no upload.

What it does *not* do is weaken the sandbox. `sandbox allow-scripts allow-forms`,
`nosniff`, and `X-Frame-Options` are unchanged, so the page still cannot reach app
cookies, storage, `/api`, or `/mcp`.

> [!WARNING] `cors: true` makes a jot's files world-readable by other sites
> Any origin can read them. A public jot is already readable over a plain GET, so this
> only matters if you were treating an unguessable jot name as a secret — which it never
> was.

On a **password** jot the flag is stored but ignored: an opaque-origin fetch carries no
cookie, so the request would be answered with 401 regardless. Preflight requests to a jot
without `cors` return 404, so a jot's CORS posture cannot be discovered by probing.

Two more serving details:

- The internal manifest file is never served. A request for it returns **404**, not 403,
  so its existence is not confirmed.
- Path traversal out of the jot directory returns **403 Forbidden**.

## Limits and configuration

The defaults are stated in the tool's own description, but all four are configurable.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `JOTS_DIR` | `<dirname of DATABASE_URL>/jots` | no | Where jot directories live |
| `JOTS_MAX_BYTES` | `5242880` (5 MiB) | no | Decompressed size cap |
| `JOTS_MAX_FILES` | `1000` | no | File-count cap, enforced during extraction |
| `JOTS_UPLOAD_TTL_SECONDS` | `300` | no | Lifetime of a mint token |

The size and file caps are enforced *while extracting*, not after, so a zip-bomb-shaped
archive is stopped partway rather than after filling the disk. A patch is measured twice:
once during extraction, and again on the merged tree, because extraction only ever sees
the incoming archive.

`JOTS_DIR` defaulting next to the database means jots and `tokens.db` share a volume by
default. On a small volume, point it somewhere with room.

## Listing and deleting

```json
{ "executions": [ { "tool": "list_jots", "args": {} } ] }
```

```json
{
  "result": {
    "jots": [
      { "name": "release-report", "access": "public",
        "url": "https://workbench.example.com/j/release-report/",
        "updatedAt": "2026-08-30T09:12:44.000Z" }
    ]
  }
}
```

Only your own jots are returned — there is no way to enumerate another user's, even
though the names share one namespace. In-flight staging directories are skipped.

```json
{ "executions": [ { "tool": "delete_jot", "args": { "name": "release-report" } } ] }
```

Returns `{"ok": true}`, or `{"error":"FORBIDDEN"}` / `{"error":"NOT_FOUND"}`. Deletion
is immediate and removes the directory. The name becomes available again.
