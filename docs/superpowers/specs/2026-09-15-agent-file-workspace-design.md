# Agent file workspace

_2026-09-15_

## Problem

Bytes have no way to move between integrations except through the model.

`slack_upload_file` is the whole story in one line
(`packages/plugins/slack/tools/index.ts:139`):

```ts
const bytes = Buffer.from(args.content, "utf-8");
```

`content` is a required string on the tool's input schema. So:

- Binary is impossible. A PDF, an xlsx, a zip cannot be uploaded at all.
- Anything that *is* uploadable must first pass through the agent's context
  window as text, whole. A 5 MB CSV is not a 5 MB upload, it is a 5 MB prompt.
- Nothing produced by one integration can be handed to another. "Download this
  statement and put it in Drive" has no expressible form.

The same gap blocks the browser: a page-triggered download lands in the
browser process's own temp directory, which no tool can read.

Every future pair of integrations that needs to exchange a file would otherwise
need bespoke glue, N×M.

## Where it lives in the code

There is already a per-user file store, and it is the wrong one. `jots/` is a
**publishing** surface: `commitJotDir` (`jots/store.ts:59`) writes a tree under
`jotsRoot()/<name>/` that `GET /j/<name>/` serves to the web, gated only by the
manifest's `access: "public" | "password"`. Putting a downloaded bank statement
there means putting it one manifest field away from the open internet.

What jots *does* get right, and what this design reuses:

- staging dir + atomic rename (`store.ts:83-90`)
- owner scoping on every read (`listJots`, `listJotFiles`, `deleteJot`)
- traversal guards as pure functions (`jots/paths.ts` — `safeRelPath`,
  `resolveInside`)
- the short-TTL single-use handshake token on `pending_auth`, zero DDL
  (finding `2026-09-13-stateless-jot-upload-token.md`)

Per-user isolation has a second precedent in the browser profiles
(`auth/profile-chromium.ts:14-26`, `:153-156`), which this follows — with one
deliberate deviation, below.

## Scope

In:

- a new internal integration, `files`, owning a per-user workspace directory
- MCP tools to list/read/write/delete within it
- REST endpoints to stream files in and out without the model in the path
- one exported path resolver, shared by every caller that needs the directory
- quota + TTL semantics
- an **out-of-process** reaper, shipped as a CLI subcommand, sweeping both
  the workspace and the browser profiles, replacing the in-server interval

Out:

- anything browser-specific — see the browser file-transfer spec
- durable//permanent storage. This is a transfer buffer with a TTL; it is not
  a document store and must not grow into one
- sharing a file between users. Ever.
- changes to consumer plugins. `slack_upload_file` and friends stay exactly
  as they are; see "Handoff" below

## Design

### It is `files`, not `browser_files`

The browser is one *producer*. Drive, Gmail attachments, Slack, Sheets exports
are others, and each is also a *consumer*. Keying the store to any one of them
re-creates the N×M problem inside the abstraction. `files` is a peer
integration that the others reference.

### Layout

```
WORKSPACE_DIR/<userKey>/<relpath>
```

`WORKSPACE_DIR` is its own config knob with **no default into the database or
profiles directory**. RWX on the shared PVC solves *visibility* between pods;
it does not solve *capacity*. Finding `2026-08-06-browser-profile-disk-growth.md`
is what happens when a growing per-user tree shares a volume with `tokens.db` —
88% consumed, nothing reclaiming it. Ops must be able to mount this one
separately and let it fill without taking the database down.

### `userKey` is a hash, not a sanitized id

The profile convention (`profile-chromium.ts:20-22`) is:

```ts
return userId.replace(/[^a-zA-Z0-9_-]/g, "_");
```

That mapping is lossy: two user ids differing only in sanitized characters
collide onto one directory. For a browser profile a collision is a shared
login. For this store a collision is **one user reading another user's files**,
which is the property we are specifically being asked to guarantee.

Today's ids are UUIDs, which survive that regex intact, so the risk is latent
rather than live — but "isolation holds as long as the id format never changes"
is not isolation. Use an injective mapping:

```ts
export function userKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}
```

Collisions now require a hash collision rather than an id-format change. If the
directories need to stay greppable by eye, `<sanitized>-<hash8>` is acceptable;
a bare sanitized name is not.

### Isolation rules

1. `userId` comes from the credential, never from a path segment, query
   parameter or body field — on every tool call and every REST route.
2. Tools and routes accept a **relative name only**. `safeRelPath` from
   `jots/paths.ts` rejects absolute, traversal, and NUL. No second
   implementation.
3. After `path.resolve`, re-check the prefix (`resolveInside`'s pattern) before
   any syscall. Two guards, because the first is about the input and the second
   is about the result.
4. Directories are created `mode: 0o700` **and** explicitly `chmodSync`'d —
   `mkdir` mode alone is subject to umask. This is why
   `profile-chromium.ts:154-155` does both, and the reason is worth a comment
   at the new call site too.
5. A plugin never receives an absolute path and never supplies one.

### Tools

| Tool | Notes |
|---|---|
| `files_list` | name, bytes, mtime, expiry; user's tree only |
| `files_stat` | one entry |
| `files_read` | `encoding: "utf8" \| "base64"`, capped; explicit error over silent truncation |
| `files_write` | agent-produced bytes into the workspace |
| `files_delete` | |

`files_read` puts bytes through the model's context, which is what this design
exists to reduce — but it is deliberately kept, because it is what makes the
sequential handoff below work without touching any consumer plugin. Cap it and
fail loudly at the cap; a silently truncated CSV is worse than a refused one.

### REST

Mirroring `POST /rest/:integration` (finding
`2026-09-11-rest-tool-execution-endpoint.md`): same credentials, resolved by
`resolveMcpUser` (`api/rest-routes.ts:7`).

- `GET /api/files` — list
- `GET /api/files/:name` — stream out, `Content-Disposition: attachment`
- `POST /api/files` — multipart in
- `DELETE /api/files/:name`

Streaming, not buffering — a 100 MB file must not be read into memory to be
served.

**No signed links.** Every read is authorized by the same credential as the
rest of the API. An earlier draft had a short-TTL `pending_auth` link per file,
for a human who wants the CSV without an API client; it is dropped. It would
have been the only bearer-free capability URL in the system pointing at user
data — anyone holding the link holds the file — and the files in question are
things like account statements. That is the shape finding
`2026-09-02-connect-link-account-mismatch.md` moved away from one release
earlier, where a link stopped authorizing on its own precisely because whoever
ends up holding it could spend it.

### Downloading from the portal

The portal is a **bearer client**, not a cookie session: `authHeaders()` builds
`Authorization: Bearer <token>` from its own token store
(`packages/portal/src/api.ts:21`). A top-level navigation cannot carry that
header, so `<a href="/api/files/statement.csv">` does not work — the same
constraint as finding `2026-09-04-oauth-authorize-cross-origin-cookie.md`,
where only a real top-level POST could reach a cookie a fetch could not see.

So a portal download is client-side: `fetch` with `authHeaders()` →
`res.blob()` → `URL.createObjectURL` → a programmatic `<a download>` click.

The ceiling is browser memory: the whole file is buffered before it is saved.
At the 100 MB per-file cap that is tolerable, and for the CSV-sized files this
is actually for it is irrelevant. If that ever hurts, the answer is a
short-TTL signed URL for native streaming — added then, as a considered
trade against the reasoning above, rather than now because it is convenient.

### Path resolution

No `ToolContext` member, no plugin-facing file interface. One exported
function:

```ts
export function userFilePath(userId: string, name: string): string | null;
```

`name` is relative; the result is absolute; `null` means the name was rejected.
Callers import it — `plugins/internal/browser.ts` for downloads and uploads,
the REST routes, the `files_*` tools.

It is worth being clear about what this is **not** protecting against. Plugins
are dynamically imported into the same Node process (`plugins/loader.ts`) with
no sandbox; any plugin could `import fs` and read whatever the server user can.
Keeping the browser internal (out of `ToolContext`) is an organizational
boundary that stops a capability being *offered*, not a mechanism that stops it
being *taken*.

So the resolver earns its place for a different reason: the hash-keying and the
traversal check must exist in exactly one place. Two copies drift, and the copy
that drifts is the one that stops being user-scoped.

### Handoff

Getting a file from the workspace to another integration is **sequential, by
the agent**: `files_read` then the destination tool's existing input.
`slack_upload_file` is not modified.

This keeps the blast radius of the feature to `files` and `browser`, at two
costs worth stating plainly:

- the bytes pass through the model's context once, so the practical ceiling is
  a small file, not the 100 MB the store will hold
- `slack_upload_file` does `Buffer.from(args.content, "utf-8")`
  (`packages/plugins/slack/tools/index.ts:139`), so the sequential path carries
  **text only**. A CSV works. A PDF or xlsx does not, and will not until
  someone gives that tool a bytes-shaped input

Neither blocks the flow this was built for. Both are the reason a
reference-passing handoff will eventually be worth revisiting; until then the
REST endpoints are the escape hatch for anything large — a caller outside the
model can `GET /api/files/:name` and do what it likes with the bytes.

### Quotas

```
WORKSPACE_MAX_FILE_BYTES       = 104_857_600   # 100MB
WORKSPACE_MAX_BYTES_PER_USER   = 268_435_456   # 256MB
```

Two caps, different jobs: per-file stops one runaway download, per-user stops
slow accumulation.

A write that would breach the per-user cap **fails at write time**. It must not
succeed and get reaped later — a download that reported success and then
vanished is the worst failure mode this system can have.

### Retention

The workspace is temporary and the contract is **age only**:

> A file is deleted once it is older than `WORKSPACE_TTL_HOURS` (24), whether or
> not anything is using it.

No liveness check, no active-set, no exceptions. An agent that wants a file to
survive must move it somewhere durable — Drive, a Slack upload, a Sheet —
within the window. That is a stated limitation of the integration, documented
in the tool descriptions themselves so the model reads it at call time, not a
behaviour to be discovered.

Age is measured from mtime, which for a write-once transfer buffer is
effectively creation time. **Reads do not extend a file's life** — otherwise
"gone within 24h" stops being a guarantee and the store slowly becomes the
document store this design refuses to be.

This is what makes an out-of-process reaper correct rather than merely
tolerable. The in-process reaper skips live profiles via `activeProfiles`
(`profile-chromium.ts:12`), a module-level `Set` that a separate process cannot
be given. Under an age-only rule it does not need one, and the two races that
would otherwise need handling both disappear:

- **In-flight downloads.** A `.crdownload` file that chromium is still writing
  has an mtime of *now*, so its age is ~0 and it is never a candidate. No
  suffix skip needed. The only way to lose one is a single download running
  longer than 24 hours, which `WORKSPACE_MAX_FILE_BYTES` (100 MB) rules out.
- **Concurrent reads.** A file unlinked while being streamed is fine — POSIX
  keeps the open fd valid. Worth a comment so nobody later "fixes" it into a
  copy-then-delete.

Sweep order: delete past TTL, then evict oldest-first for any user still over
quota.

### One reaper, both trees

Files and browser profiles are the same job — sweeping a shared PVC — and ship
as one subcommand, run by one scheduled job:

```
packages/server/src/reap/cli.ts
packages/server/src/reap/workspace.ts
packages/server/src/reap/profiles.ts
"reap": "tsx src/reap/cli.ts"
```

following the `gap` and `migrate:sqlite-to-postgres` precedent. Flags:
`--files`, `--profiles` (both when neither is given), `--dir`, `--ttl-hours`,
`--dry-run`, `--json`, non-zero exit on failure so the job surfaces it.

`startProfileDiskReaper()` (`profile-disk.ts:180`) is **deleted**, not left
running alongside. Today it fires on every pod, so in HA N pods sweep the same
profiles tree concurrently; that is the bug this whole arrangement exists to
avoid, and leaving it in place would preserve it.

**Two refactors this forces, both worth doing anyway.**

*The CLI must not import `config.ts`.* That schema requires `ENCRYPTION_KEY`
(`.length(64)`, empty default outside tests) and `SESSION_SECRET`, so importing
it would make a directory-sweeping CronJob carry the encryption key. The sweeps
take explicit options; the CLI reads flags and a narrow env fallback. The
reaper pod's secret surface stays at zero.

*The profile sweep must not import `profile-chromium.ts`.* That module's first
line is `import { chromium } from "playwright"`, so `profile-disk.ts` today
transitively pulls Playwright into anything that touches it — an absurd
dependency for a job that deletes directories. Extract `profilesBaseDir` and
`profileDirName` into a leaf path-only module that both the chromium code and
the reaper import.

*Replacing `activeProfiles` for profiles.* Files need no liveness check, but
profiles still do: trimming the caches of a **running** chromium is not the
same as deleting a stale tree. The filesystem already answers the question.
`USE_MARKERS` (`Default/Cookies`, `Default/Preferences`,
`profile-disk.ts:37`) are rewritten whenever a profile is actually in use, so:

> Treat a profile as live if a use-marker has moved within the last hour.

`BROWSER_SESSION_TTL_SECONDS` is 300, so an hour is a 12× margin, and it is
derivable purely from the filesystem with no in-process state. Whole-profile
deletion keeps its existing 30-day `BROWSER_PROFILE_TTL_DAYS`, where marker
staleness makes a live-session collision effectively impossible.

### HA

Every pod sees every file (RWX, already provisioned), so no affinity applies:
the browser can write on the pod that owns the session and Slack can upload
from any other. This is the property that makes `files` a hub rather than a
browser-local scratch dir.

## Testing

- `safeRelPath` / resolve-guard: `../`, absolute, NUL, encoded traversal,
  symlink escaping the root
- `userKey` injectivity — the two ids that collide under `profileDirName` map
  to different workspace dirs
- two users, same relative name, no cross-read; `files_read` of a name written
  by another user is NOT_FOUND, not FORBIDDEN (no existence oracle)
- write over per-user quota fails at write time, file absent afterwards
- reaper: TTL deletion by age alone, quota eviction order, a read does not
  extend a file's life, `--dry-run` deletes nothing, `--json` shape
- reaper: `--files` and `--profiles` each sweep only their own tree
- profile sweep: a profile whose use-marker moved within the hour is not
  trimmed; one older than that is
- both sweeps against temp dirs with no env set — proves the CLI runs without
  `ENCRYPTION_KEY`, and that nothing in its import graph reaches Playwright
- REST: user A cannot `GET /api/files/<B's file>`; an unauthenticated request
  is refused; no route serves a file without a credential

## Notes

The retention contract is the part most likely to surprise someone: files
vanish on a wall-clock schedule with no grace for work in progress. That is
deliberate — it is what lets the reaper run anywhere, with no state, no
coordination and no secrets. It has to be visible in the tool descriptions, not
only here.
