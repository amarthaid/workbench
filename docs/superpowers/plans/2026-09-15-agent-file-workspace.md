# Agent File Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the server a per-user, TTL'd file area that any integration can write into and read out of, so bytes stop having to travel through the model's context as UTF-8 text.

**Architecture:** A new internal integration, `files`, owning `WORKSPACE_DIR/<userKey>/`. One exported resolver (`userFilePath`) is the only place that turns a user id and a relative name into an absolute path. Reads and writes are reachable three ways: MCP tools, bearer REST routes, and short-TTL presigned URLs backed by `pending_auth` rows. Retention is age-only and swept by a new out-of-process `reap` subcommand that also takes over the browser profiles, replacing the per-pod in-server interval.

**Tech Stack:** TypeScript, Fastify, vitest (`npm run test -w @a-workbench/server`), React + TanStack Query (portal), better-sqlite3 / pg.

**Spec:** `docs/superpowers/specs/2026-09-15-agent-file-workspace-design.md`

## Global Constraints

- This repo is **public**. Never commit personal PII, company or internal
  project names, internal hostnames, or secrets. Test fixtures use synthetic
  values only: `user-1`, `u1`, `test@example.com`, `acme`, `demo-repo`.
- **No AI co-authorship.** Never add a `Co-Authored-By:` or "Generated with …"
  trailer naming Claude/Anthropic, and never commit under an AI author identity.
  `.githooks/commit-msg` enforces both.
- Run the server suite with `npm run test -w @a-workbench/server`. A single
  file: `npx vitest run tests/<file>.test.ts` from `packages/server`.
- Type-check the test suite with `npm run typecheck:tests -w @a-workbench/server`
  before the final commit of any task touching `packages/server/tests`.
- **Do not add a file interface to `ToolContext`.** It was considered and
  rejected: plugins are dynamically imported into the same process with no
  sandbox, so it bought no isolation. Callers import `userFilePath` directly.
- **Do not modify `slack_upload_file`** or any other consumer plugin. Moving a
  file to another integration is sequential, done by the agent.
- `WORKSPACE_DIR` must never default into the database directory or the
  browser-profiles directory. Finding
  `2026-08-06-browser-profile-disk-growth.md` is what sharing a volume costs.
- Tasks 1-5 are server-only and independently mergeable. Task 6 (portal) must
  not merge before Task 4.

---

### Task 1: Config knobs and the path resolver

Everything else in this plan resolves a path through one function. It has to
exist first, and it has to be the only copy — two implementations of the
traversal check will drift, and the copy that drifts is the one that stops
being user-scoped.

The browser profiles solve the same problem with `profileDirName`
(`profile-chromium.ts:20-22`), which sanitizes `[^a-zA-Z0-9_-]` to `_`. That
mapping is **lossy**: two ids differing only in sanitized characters land in
one directory. For a profile that is a shared login; here it would be one user
reading another's files. Today's ids are UUIDs, which survive the regex
untouched, so this is latent rather than live — but the guarantee we are asked
for is isolation, not isolation-until-the-id-format-changes. Hash instead.

**Files:**
- Modify: `packages/server/src/config.ts:31-42` (new `WORKSPACE_*` knobs)
- Create: `packages/server/src/workspace/paths.ts`
- Test: `packages/server/tests/workspace-paths.test.ts`

**Interfaces:**
- Consumes: `safeRelPath` from `jots/paths.ts`.
- Produces:
  - `workspaceRoot(): string`
  - `userKey(userId: string): string`
  - `userWorkspaceDir(userId: string): string`
  - `userFilePath(userId: string, name: string): string | null` — absolute path,
    or `null` if the name is rejected. Pure path arithmetic; names a file being
    *created*.
  - `resolveExistingFile(userId: string, name: string): Promise<string | null>`
    — the same, plus an `fs.realpath` check. Every caller about to *read* bytes
    uses this one.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/tests/workspace-paths.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  userKey,
  userFilePath,
  userWorkspaceDir,
  resolveExistingFile,
} from "../src/workspace/paths";

describe("workspace paths", () => {
  it("maps distinct user ids to distinct keys where profileDirName collides", () => {
    // Both sanitize to "a_b" under profileDirName's [^a-zA-Z0-9_-] -> "_".
    expect(userKey("a.b")).not.toBe(userKey("a@b"));
  });

  it("is stable for the same id", () => {
    expect(userKey("u1")).toBe(userKey("u1"));
  });

  it("resolves a plain name inside the user's dir", () => {
    const p = userFilePath("u1", "statement.csv");
    expect(p).not.toBeNull();
    expect(p!.startsWith(userWorkspaceDir("u1"))).toBe(true);
  });

  it.each([
    "../escape.csv",
    "a/../../escape.csv",
    "/etc/passwd",
    "",
    "sub/../../../etc/passwd",
  ])("refuses %s", (name) => {
    expect(userFilePath("u1", name)).toBeNull();
  });

  it("refuses a name containing NUL", () => {
    expect(userFilePath("u1", "a\u0000b")).toBeNull();
  });

  it("keeps two users apart for the same relative name", () => {
    expect(userFilePath("u1", "x.csv")).not.toBe(userFilePath("u2", "x.csv"));
  });

  it("refuses a symlink pointing outside the workspace", async () => {
    // path.resolve is string arithmetic and does not follow symlinks, so this
    // name passes userFilePath. Only the realpath check catches it.
    const dir = userWorkspaceDir("u1");
    await mkdir(dir, { recursive: true });
    const outside = join(tmpdir(), `escape-${randomUUID()}`);
    await writeFile(outside, "secret");
    await symlink(outside, join(dir, "link.csv"));

    expect(userFilePath("u1", "link.csv")).not.toBeNull();
    await expect(resolveExistingFile("u1", "link.csv")).resolves.toBeNull();
  });

  it("accepts a real file inside the workspace", async () => {
    const dir = userWorkspaceDir("u1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "real.csv"), "a,b");
    await expect(resolveExistingFile("u1", "real.csv")).resolves.not.toBeNull();
  });
});
```

The symlink case is the reason `resolveExistingFile` exists. Nothing in this
design writes a symlink, so it is defence in depth — but the workspace lives on
a volume other things can reach, and the failure mode is silent exfiltration of
the token database through `browser_upload_file`.

- [ ] **Step 2: Run the tests to verify they fail**

From `packages/server`: `npx vitest run tests/workspace-paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the config knobs**

In `packages/server/src/config.ts`, after the `JOTS_*` block:

```typescript
  // Its own mount. Never defaulted into the DB or profiles directory: RWX on a
  // shared PVC solves visibility between pods, not capacity, and a growing
  // per-user tree sharing a volume with tokens.db is finding
  // 2026-08-06-browser-profile-disk-growth.md all over again.
  WORKSPACE_DIR: z.string().default("./data/workspace"),
  WORKSPACE_TTL_HOURS: z.coerce.number().int().positive().default(24),
  WORKSPACE_MAX_FILE_BYTES: z.coerce.number().int().positive().default(104_857_600),
  WORKSPACE_MAX_BYTES_PER_USER: z.coerce.number().int().positive().default(268_435_456),
  WORKSPACE_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
```

- [ ] **Step 4: Implement the resolver**

Create `packages/server/src/workspace/paths.ts`:

```typescript
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { safeRelPath } from "../jots/paths";

export function workspaceRoot(): string {
  return path.resolve(config.WORKSPACE_DIR);
}

/**
 * Directory name for a user. A hash, not a sanitized id: profileDirName's
 * `[^a-zA-Z0-9_-] -> _` is lossy, so two ids differing only in sanitized
 * characters share a directory. For a browser profile that is a shared login;
 * here it would be one user reading another user's files.
 */
export function userKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

export function userWorkspaceDir(userId: string): string {
  return path.join(workspaceRoot(), userKey(userId));
}

/**
 * Absolute path for a user's file, or null if the name is not acceptable.
 * Two guards, deliberately: safeRelPath judges the input, the prefix check
 * judges the result. Callers pass a relative name and never an absolute path —
 * an absolute path from a tool argument would be an arbitrary-file primitive.
 */
export function userFilePath(userId: string, name: string): string | null {
  const rel = safeRelPath(name);
  if (!rel) return null;
  const base = userWorkspaceDir(userId);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/**
 * The same, for a file that already exists and is about to be read. Adds the
 * one check path arithmetic cannot make: a symlink inside the workspace
 * pointing at /data/tokens.db resolves cleanly above and still escapes, so the
 * real path is re-checked against the same prefix. Returns null for a missing
 * file too — a caller cannot tell the difference, and should not be able to.
 */
export async function resolveExistingFile(userId: string, name: string): Promise<string | null> {
  const target = userFilePath(userId, name);
  if (!target) return null;
  const base = await realpath(userWorkspaceDir(userId)).catch(() => null);
  const real = await realpath(target).catch(() => null);
  if (!base || !real) return null;
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  return real;
}
```

`realpath` the base too: on macOS `/tmp` is itself a symlink to `/private/tmp`,
so comparing a resolved target against an unresolved base fails for every file
in a tmpdir-backed test.

- [ ] **Step 5: Run the tests to verify they pass**

From `packages/server`: `npx vitest run tests/workspace-paths.test.ts`
Expected: PASS.

Note: `safeRelPath` also rejects any path whose basename is `jot.json`. That is
harmless here (one reserved filename) and not worth a second implementation.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/workspace/paths.ts packages/server/tests/workspace-paths.test.ts
git commit -m "feat(files): workspace config knobs and user-scoped path resolver"
```

---

### Task 2: The store

Filesystem operations with the quota rules attached. Kept separate from the
tools and the routes so all three share one implementation and one set of
error strings.

The per-user cap is enforced **at write time**, not by the reaper. A write that
succeeds and then silently vanishes is the worst failure this system can
produce — an agent reports the download landed, and the file is gone.

**Files:**
- Create: `packages/server/src/workspace/store.ts`
- Test: `packages/server/tests/workspace-store.test.ts`

**Interfaces:**
- Consumes: `userFilePath`, `resolveExistingFile`, `userWorkspaceDir` (Task 1).
  Every read path goes through `resolveExistingFile`; `userFilePath` is for
  naming a file being created.
- Produces:
  - `interface FileEntry { name: string; bytes: number; mtime: string; expiresAt: string }`
  - `listFiles(userId): Promise<FileEntry[]>`
  - `statFile(userId, name): Promise<FileEntry | null>`
  - `readFile(userId, name, maxBytes?): Promise<Buffer>` — throws `TOO_LARGE`
  - `writeFile(userId, name, data: Buffer): Promise<FileEntry>` — throws
    `TOO_LARGE`, `QUOTA_EXCEEDED`, `INVALID_NAME`
  - `openWriteStream(userId, name): Promise<{ path: string; commit(): Promise<FileEntry>; abort(): Promise<void> }>`
  - `deleteFile(userId, name): Promise<boolean>`
  - `usedBytes(userId): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/tests/workspace-store.test.ts`. Point `WORKSPACE_DIR`
at a tmpdir before importing the store. Cover:

- write then read round-trips bytes, including a non-UTF8 buffer
- `writeFile` over `WORKSPACE_MAX_FILE_BYTES` throws `TOO_LARGE` and leaves no file
- `writeFile` that would push the user past `WORKSPACE_MAX_BYTES_PER_USER`
  throws `QUOTA_EXCEEDED` and leaves no file
- `usedBytes` counts only the calling user's tree
- `listFiles` for user A never shows user B's file of the same name
- `readFile` of a name written by another user throws `NOT_FOUND` — not
  `FORBIDDEN`, which would be an existence oracle
- `deleteFile` returns false for an unknown name
- `openWriteStream(...).abort()` removes the partial file
- `expiresAt` is `mtime + WORKSPACE_TTL_HOURS`

- [ ] **Step 2: Run the tests to verify they fail**

From `packages/server`: `npx vitest run tests/workspace-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Key points for the implementer:

```typescript
// mkdir mode alone is subject to umask, so chmod explicitly. Same reason
// profile-chromium.ts:154-155 does both.
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
```

`openWriteStream` writes to `<name>.part-<rand>` in the same directory and
renames on `commit()` — same-directory rename, so atomic, and a crashed upload
leaves a `.part-` file rather than a truncated real one. Enforce
`WORKSPACE_MAX_FILE_BYTES` by counting bytes as they stream and calling
`abort()` on overflow; never trust a declared length.

`listFiles` skips `.part-` files. It is a flat listing: nested names are
allowed by `safeRelPath` but the workspace is a transfer buffer, so walk one
level and report relative names.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/workspace/store.ts packages/server/tests/workspace-store.test.ts
git commit -m "feat(files): workspace store with per-file and per-user caps"
```

---

### Task 3: The `files` integration and its tools

An internal registry plugin, like `browser` and `jots` — it reaches straight
into the store, which must stay out of `ToolContext`.

Tool descriptions carry the retention rule. The model reads them at call time;
it does not read this plan. A file that disappears in 24 hours with no warning
in the description is a bug in the description.

**Files:**
- Create: `packages/server/src/plugins/internal/files.ts`
- Modify: `packages/server/src/plugins/loader.ts:6-7` (register alongside
  `browserPlugin` / `jotsPlugin`)
- Test: `packages/server/tests/files-tools.test.ts`

**Interfaces:**
- Consumes: the store (Task 2).
- Produces: `filesPlugin`, `FILES_INTEGRATION_NAME`, and the tools
  `files_list`, `files_stat`, `files_read`, `files_write`, `files_delete`.

- [ ] **Step 1: Write the failing tests**

Cover: each tool round-trips through the registry; `files_read` with
`encoding: "base64"` returns bytes a UTF-8 read would corrupt; a traversal name
returns `{ error: "INVALID_NAME" }` rather than throwing; `files_list` is
scoped to `ctx.userId`.

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

Follow the shape of `plugins/internal/jots.ts`. Descriptions must state the
retention contract, e.g. for `files_list`:

> Files in the workspace are deleted 24 hours after they are written, whether
> or not anything is using them, and reading a file does not extend its life.
> Move anything that must survive to a durable destination — a Drive upload, a
> Slack upload — in the same run.

`files_read` takes `encoding: "utf8" | "base64"` and a `maxBytes`. On overflow
return `{ error: "TOO_LARGE", bytes }` — never a silent truncation. A truncated
CSV that looks complete is worse than a refusal.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/plugins/internal/files.ts packages/server/src/plugins/loader.ts packages/server/tests/files-tools.test.ts
git commit -m "feat(files): files integration with list/stat/read/write/delete"
```

---

### Task 4: Bearer REST routes and response headers

`registerPortal` (`portal.ts:30`) serves the portal SPA at `/` on the same
Fastify instance as `/api`, and the portal keeps its bearer in a client-side
token store (`portal/src/api.ts:21`). So **user-controlled bytes served inline
from this origin are stored XSS against the portal's own credential.**

That is why every response in this task and the next one is forced to
`application/octet-stream` + `attachment` + `nosniff` + `sandbox`, regardless
of what the file actually is. `setJotSecurityHeaders` (`jots/routes.ts:78-88`)
exists for the same reason; this is the stricter version, because a jot is
meant to render and a workspace file never is.

**Files:**
- Create: `packages/server/src/workspace/routes.ts`
- Modify: `packages/server/src/index.ts` (register)
- Test: `packages/server/tests/workspace-routes.test.ts`

**Interfaces:**
- Consumes: the store (Task 2), `resolveMcpUser` (`auth/oauth-server/resolve.ts`).
- Produces: `GET /api/files`, `GET /api/files/:name`, `POST /api/files`,
  `DELETE /api/files/:name`, and an exported `setFileSecurityHeaders(reply, filename)`.

- [ ] **Step 1: Write the failing tests**

Cover: unauthenticated request → 401; user A cannot read B's file (404, not
403); an uploaded `.html` comes back `application/octet-stream` with
`Content-Disposition: attachment` and `nosniff`; a traversal `:name` → 400;
upload over the per-file cap → 413 with no file left behind.

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

```typescript
export function setFileSecurityHeaders(reply: FastifyReply, filename: string): void {
  // Never the real content type and never inline. The portal SPA shares this
  // origin and holds a bearer client-side, so an inline text/html response
  // from here is stored XSS against that credential.
  reply.header("content-type", "application/octet-stream");
  reply.header("content-disposition", `attachment; filename="${sanitizeHeaderFilename(filename)}"`);
  reply.header("x-content-type-options", "nosniff");
  reply.header("content-security-policy", "sandbox");
  reply.header("cross-origin-resource-policy", "same-origin");
}
```

`sanitizeHeaderFilename` strips quotes, control characters and newlines — a
filename reaches us from a remote `Content-Disposition` (Task 3 of the browser
plan) and must not be able to inject a header.

Stream the file with `reply.send(createReadStream(path))`. Do not
`readFileSync` — 100 MB into memory per request is a denial of service with
extra steps.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/workspace/routes.ts packages/server/src/index.ts packages/server/tests/workspace-routes.test.ts
git commit -m "feat(files): bearer REST routes with forced-attachment headers"
```

---

### Task 5: Presigned URLs

A bearer covers the agent and the portal. It does not cover handing a fetchable
URL to a service that must not hold a workbench credential, or moving bytes
without them passing through the agent.

`jots/pending.ts` is the working model and should be read before starting. Two
deviations from it:

- **A download token is multi-use within its TTL.** `consume` there deletes on
  read; a fetch gets retried and some clients `HEAD` before `GET`, so download
  needs a `peek` that selects without deleting. Upload keeps the delete —
  single use, arbitrated by `changes === 1`.
- **The filename lives in the row.** An upload URL that takes a name at `PUT`
  time is a write-anywhere primitive.

The token is 32 hex characters, not a JWT: find-my-way caps a route param at
100 characters and answers 414 over it, which the jot upload flow hit
(`2026-09-13-stateless-jot-upload-token.md`).

**Files:**
- Create: `packages/server/src/workspace/presign.ts`
- Modify: `packages/server/src/workspace/routes.ts` (redeem routes),
  `packages/server/src/plugins/internal/files.ts` (`files_presign`)
- Test: `packages/server/tests/workspace-presign.test.ts`

**Interfaces:**
- Consumes: `db`, the store, `config.WORKSPACE_PRESIGN_TTL_SECONDS`.
- Produces:
  - `mintDownload(userId, name): Promise<{ token, url, expiresAt }>`
  - `mintUpload(userId, name): Promise<{ token, url, expiresAt }>`
  - `peekDownload(token): Promise<{ userId, name } | null>`
  - `consumeUpload(token): Promise<{ userId, name } | null>`
  - `reapExpiredPresigns(): Promise<void>`
  - Routes `GET /api/files/dl/:token`, `PUT /api/files/ul/:token`
  - Tool `files_presign({ name, op, ttlSeconds? })`

- [ ] **Step 1: Write the failing tests**

Cover:

- a download token works twice inside its TTL and not after it
- an upload token works exactly once; the second `PUT` is refused
- two concurrent `PUT`s with one token: exactly one succeeds
  (`changes === 1` arbitrates)
- the upload redeem writes only the name in the row — a `name` in the query or
  body is ignored, not honoured
- a token minted for a file that is then deleted is refused
- an upload exceeding the per-file cap aborts mid-stream, leaves no file, and
  leaves no `.part-`
- an upload that passed the quota check at mint but not at redeem is refused at
  redeem
- the download redeem sets the same forced-attachment headers as Task 4
- both sentinels are scoped: a `__jot_upload__` token cannot be spent here, and
  a `__file_dl__` token cannot be spent as a jot upload

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

Mirror `jots/pending.ts` including the clock seam (`_setNowForTest`), the
sentinel scoping on **every** read and delete, and the `Math.ceil` on
`expires_at`. Sentinels: `__file_dl__`, `__file_ul__`.

```typescript
// The DELETE, not the SELECT, is what makes an upload token single-use:
// two concurrent PUTs both read the row, the database serialises the deletes,
// and exactly one reports a row removed. Atomic on both backends, no
// transaction. See 2026-09-13-stateless-jot-upload-token.md.
```

Quota is re-checked inside the redeem handler, not only at mint: minutes pass
in between and other writes land.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Typecheck the test suite**

`npm run typecheck:tests -w @a-workbench/server`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/workspace/presign.ts packages/server/src/workspace/routes.ts packages/server/src/plugins/internal/files.ts packages/server/tests/workspace-presign.test.ts
git commit -m "feat(files): short-TTL presigned download and upload URLs"
```

---

### Task 6: Portal files page

A list of the user's files with sizes, ages and time-to-expiry, plus download
and delete.

The portal is a **bearer client**, not a cookie session, so
`<a href="/api/files/x.csv">` does not work — a top-level navigation cannot
carry an `Authorization` header. Same constraint as
`2026-09-04-oauth-authorize-cross-origin-cookie.md`. Download is
`fetch` + `authHeaders()` → `res.blob()` → `URL.createObjectURL` →
programmatic `<a download>` click, with `URL.revokeObjectURL` afterwards.

Do **not** have the portal mint itself a presigned URL. It already holds a
credential, and a blob keeps the bytes out of the URL bar and the logs.

**Files:**
- Modify: `packages/portal/src/api.ts` (list/download/delete/upload)
- Create: `packages/portal/src/pages/Files.tsx` (follow the existing page
  conventions and the portal's design tokens)
- Modify: the portal router and nav
- Test: portal tests if the existing suite covers comparable pages; otherwise
  server-side coverage from Task 4 stands and this task is manual-verified

**Interfaces:**
- Consumes: the Task 4 routes.
- Produces: a `/files` route in the portal.

- [ ] **Step 1: Add the API client functions**

Bodyless POSTs use `authHeaders()` and **not** a JSON content-type — finding
`2026-06-10-empty-json-body-bodyless-post.md`: a `Content-Type:
application/json` header with no body is `FST_ERR_CTP_EMPTY_JSON_BODY`.

- [ ] **Step 2: Build the page**

Show time-to-expiry per row, prominently. The retention rule is the thing users
will be surprised by, and a countdown is a better explanation than a tooltip.

- [ ] **Step 3: Verify by hand**

`npm run dev`, upload a file, download it back, confirm the bytes match and the
browser saved it rather than rendering it.

- [ ] **Step 4: Commit**

```bash
git add packages/portal/src
git commit -m "feat(portal): files page with blob download"
```

---

### Task 7: The unified `reap` subcommand

Retention is **age only**: a file older than `WORKSPACE_TTL_HOURS` is deleted
whether or not anything is using it. That is what makes an out-of-process
reaper correct rather than merely tolerable — the in-process one skips live
profiles via `activeProfiles` (`profile-chromium.ts:12`), a module-level `Set`
that a separate process cannot be given.

Under an age-only rule the two races that would otherwise need handling both
disappear. A `.crdownload` chromium is still writing has an mtime of *now*, so
its age is ~0 and it is never a candidate; no suffix skip is needed. A file
unlinked while being streamed is fine, because POSIX keeps the open fd valid —
that one needs a comment so nobody later "fixes" it into a copy-then-delete.

This task also **deletes** `startProfileDiskReaper()`. Leaving it running
beside the subcommand would preserve exactly the bug this arrangement exists to
remove: it fires on every pod, so in HA N pods sweep the same profiles tree
concurrently.

**Files:**
- Create: `packages/server/src/workspace/reap.ts`, `packages/server/src/reap/cli.ts`
- Create: `packages/server/src/auth/profile-paths.ts` (extracted leaf module)
- Modify: `packages/server/src/auth/profile-chromium.ts` (re-export from the
  leaf module), `packages/server/src/auth/profile-disk.ts` (explicit options,
  marker-based liveness, delete `startProfileDiskReaper`),
  `packages/server/src/index.ts` (drop the start call),
  `packages/server/package.json` (`"reap"` script)
- Test: `packages/server/tests/reap-workspace.test.ts`,
  `packages/server/tests/reap-cli.test.ts`

**Interfaces:**
- Produces:
  - `reapWorkspace(opts: { dir: string; ttlHours: number; maxBytesPerUser?: number; now?: number; dryRun?: boolean }): Promise<ReapResult>`
  - `reapProfileDisk` gains explicit `opts` and loses its `activeProfiles` read
  - CLI: `npm run reap -- [--files] [--profiles] [--dir] [--ttl-hours] [--dry-run] [--json]`

- [ ] **Step 1: Write the failing tests**

Cover:

- a file older than the TTL is deleted; a newer one is not
- reading a file does not extend its life (age is mtime; a read does not touch it)
- quota eviction removes oldest first, and only for the user over quota
- `--dry-run` reports what it would delete and deletes nothing
- `--json` emits a parseable summary
- `--files` does not touch the profiles tree and `--profiles` does not touch
  the workspace
- a profile whose use-marker moved within the hour is not trimmed; one older
  than that is
- **the CLI runs with no environment set at all** — no `ENCRYPTION_KEY`, no
  `SESSION_SECRET`, no database

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Extract the leaf path module**

`profile-disk.ts` today imports from `profile-chromium.ts`, whose first line is
`import { chromium } from "playwright"`. That drags Playwright into anything
touching it — an absurd dependency for a job that deletes directories. Move
`profilesBaseDir` and `profileDirName` into `auth/profile-paths.ts` with no
imports beyond `node:path` and the config value they need, and have both
`profile-chromium.ts` and the reaper import from there.

- [ ] **Step 4: Replace `activeProfiles` with marker liveness**

Files need no liveness check. Profiles still do — trimming the caches of a
*running* chromium is not the same as deleting a stale tree. The filesystem
already answers it: `USE_MARKERS` (`profile-disk.ts:37`) are rewritten whenever
a profile is in use.

```typescript
// Out-of-process substitute for the activeProfiles Set: a live session
// rewrites Default/Cookies and Default/Preferences continuously, so a marker
// that has not moved in an hour means no session is live. BROWSER_SESSION_TTL
// is 300s, so this is a 12x margin, and it needs no in-process state.
const LIVE_WINDOW_MS = 3_600_000;
```

- [ ] **Step 5: Implement the sweeps and the CLI**

**The CLI must not import `config.ts`.** That schema requires `ENCRYPTION_KEY`
(`.length(64)`, empty default outside tests) and `SESSION_SECRET`, so importing
it would make a directory-sweeping CronJob carry the encryption key. Read
`--dir`/`--ttl-hours` from flags, falling back to a narrow `process.env` read
of `WORKSPACE_DIR` / `BROWSER_PROFILES_DIR`. The reaper pod's secret surface
stays at zero, and Step 1's env-free test is what keeps it that way.

Add to `packages/server/package.json` scripts:

```json
    "reap": "tsx src/reap/cli.ts",
```

- [ ] **Step 6: Delete the in-server profile reaper**

Remove `startProfileDiskReaper` from `profile-disk.ts` and its call site in
`index.ts`. Keep `trimProfileCaches` and `reapProfileDisk` — the subcommand
calls them.

- [ ] **Step 7: Run the tests to verify they pass**

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/workspace/reap.ts packages/server/src/reap packages/server/src/auth packages/server/src/index.ts packages/server/package.json packages/server/tests/reap-workspace.test.ts packages/server/tests/reap-cli.test.ts
git commit -m "feat(reap): one out-of-process subcommand for workspace and profiles"
```

---

### Task 8: Documentation

**Files:**
- Create: `docs/site/_content/integrations/files.md`
- Modify: `docs/site/nav.json`
- Modify: `docs/site/_content/deploy/` — the reaper is a deployment concern now
  (a CronJob, a separate mount), not an implementation detail
- Modify: `.env.example` (the `WORKSPACE_*` knobs, with placeholders only)
- Modify: `CLAUDE.md` findings index if a finding comes out of the build

- [ ] **Step 1: Write the integration page**

Lead with retention. It is the one thing that will surprise people.

- [ ] **Step 2: Write the deployment section**

Cover: `WORKSPACE_DIR` on its own RWX mount and why it is not the database
volume; the CronJob invoking `npm run reap`; that the reaper needs no secrets;
that exactly one scheduled job should run it.

- [ ] **Step 3: Verify the docs build**

`node docs/site/build.mjs` — a broken internal link fails CI on the PR.

- [ ] **Step 4: Commit**

```bash
git add docs .env.example CLAUDE.md
git commit -m "docs(files): workspace integration and reaper deployment"
```
