# Space Delegated Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an admin-granted Space owner switch a shared Space to run every tool call with the owner's connections ("Delegate my access"), with both people on every audit row.

**Architecture:** A new generic per-user permission store (`user_permissions` + `can()`) gates the feature. `spaces.access_mode` (`viewer` | `owner`) picks whose user id `executeSingle` runs as in `POST /api/spaces/:name/call`; the viewer rides the audit context as `actor_*`, written to two new nullable `audit_log` columns. Activity reads `user_id = me OR actor_user_id = me`.

**Tech Stack:** TypeScript, Fastify, SQLite + PostgreSQL via `db` adapter (`packages/server/src/db.ts`), vitest, React + TanStack Query portal.

**Design:** `docs/internal/superpowers/specs/2026-11-26-space-delegated-access-design.md`

**Ground rules for every task**
- Public repo: synthetic fixtures only (`dev@example.com`, `qa@example.com`, `acme`). No real names, no company or internal refs.
- No em-dashes in user-facing copy. No emoji.
- Server tests: `npm run test -w @a-workbench/server -- <file>` from the repo root. Portal: `npm run test -w @a-workbench/portal -- <file>`.
- Type-check tests too: `npx tsc --noEmit -p packages/server/tsconfig.test.json`.
- Every schema change goes in **both** `SQLITE_SCHEMA` / `initSqliteSchema` and the PostgreSQL schema / migration block in `packages/server/src/db.ts`.
- Commit after each task. Conventional commit messages. No AI trailers.

---

## Phase A: Permission layer

### Task 1: `user_permissions` table

**Files:**
- Modify: `packages/server/src/db.ts` (both schema strings, next to `space_kv`)
- Test: `packages/server/tests/permissions.test.ts` (new)

**Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { db } from "../src/db";

describe("user_permissions table", () => {
  it("exists with one rule per (user, capability, subject)", async () => {
    await db.exec("DELETE FROM user_permissions");
    await db.run(
      "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["u1", "spaces.delegate_access", "", "allow", "admin", 1]
    );
    await expect(
      db.run(
        "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["u1", "spaces.delegate_access", "", "deny", "admin", 2]
      )
    ).rejects.toThrow();
  });
});
```

**Step 2:** run, expect FAIL `no such table: user_permissions`.

**Step 3:** add to SQLite schema:

```sql
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  effect TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, capability, subject)
);
```

PostgreSQL: same with `granted_at BIGINT NOT NULL`.

**Step 4:** run, PASS. **Step 5:** commit `feat(permissions): user_permissions table`.

### Task 2: capability registry + `can()`

**Files:**
- Create: `packages/server/src/permissions/capabilities.ts`
- Create: `packages/server/src/permissions/store.ts`
- Test: `packages/server/tests/permissions.test.ts`

**Step 1: Failing tests** (append):

```ts
import { can, setPermission, clearPermission, listPermissions } from "../src/permissions/store";
import { CAPABILITIES } from "../src/permissions/capabilities";

describe("can()", () => {
  beforeEach(async () => { await db.exec("DELETE FROM user_permissions"); });

  it("falls back to the declared default", async () => {
    expect(CAPABILITIES["spaces.delegate_access"].default).toBe("deny");
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
  });
  it("allow row grants, deny row revokes", async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    expect(await can("u1", "spaces.delegate_access")).toBe(true);
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "deny", grantedBy: "admin" });
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
  });
  it("clearing returns to the default", async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    await clearPermission("u1", "spaces.delegate_access");
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
  });
  it("a subject-specific row beats the general row", async () => {
    // exercised through a test-only capability registered with a subject
  });
  it("rejects an undeclared capability on write", async () => {
    await expect(setPermission({ userId: "u1", capability: "nope" as any, effect: "allow", grantedBy: "a" })).rejects.toThrow(/unknown capability/);
  });
  it("is not cached: a change is visible on the next read", async () => { /* set, read, clear, read */ });
  it("listPermissions returns every declared capability with its effective value and source", async () => { /* default vs row */ });
});
```

Write the subject test with `_registerCapabilityForTest("test.subjected", { default: "allow", subject: true, ... })` so no fake capability ships.

**Step 3: Implementation**

`capabilities.ts`:

```ts
export type Effect = "allow" | "deny";
export interface CapabilityDef {
  default: Effect;
  label: string;
  description: string;
  /** true when rules may name a subject (e.g. an integration). */
  subject: boolean;
}
export const CAPABILITIES = {
  "spaces.delegate_access": {
    default: "deny",
    label: "Delegate access in Spaces",
    description: "Lets this user share Spaces that run with their connected apps.",
    subject: false,
  },
} as const satisfies Record<string, CapabilityDef>;
export type Capability = keyof typeof CAPABILITIES;
const extra = new Map<string, CapabilityDef>();
export function capabilityDef(key: string): CapabilityDef | undefined {
  return (CAPABILITIES as Record<string, CapabilityDef>)[key] ?? extra.get(key);
}
export function _registerCapabilityForTest(key: string, def: CapabilityDef): void { extra.set(key, def); }
```

`store.ts`:

```ts
import { db } from "../db";
import { capabilityDef, CAPABILITIES, type Capability, type Effect } from "./capabilities";

export async function can(userId: string, capability: Capability | string, subject = ""): Promise<boolean> {
  const def = capabilityDef(capability);
  if (!def) return false; // unknown key never grants
  const rows = await db.all<{ subject: string; effect: string }>(
    "SELECT subject, effect FROM user_permissions WHERE user_id = ? AND capability = ? AND subject IN (?, '')",
    [userId, capability, subject]
  );
  const exact = subject ? rows.find((r) => r.subject === subject) : undefined;
  const general = rows.find((r) => r.subject === "");
  const effect = (exact ?? general)?.effect ?? def.default;
  return effect === "allow";
}

export async function setPermission(i: { userId: string; capability: string; subject?: string; effect: Effect; grantedBy: string }): Promise<void> {
  const def = capabilityDef(i.capability);
  if (!def) throw new Error(`unknown capability: ${i.capability}`);
  if (i.subject && !def.subject) throw new Error(`${i.capability} takes no subject`);
  await db.run(
    `INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, capability, subject) DO UPDATE SET effect = excluded.effect, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
    [i.userId, i.capability, i.subject ?? "", i.effect, i.grantedBy, Math.floor(Date.now() / 1000)]
  );
}

export async function clearPermission(userId: string, capability: string, subject = ""): Promise<void> {
  await db.run("DELETE FROM user_permissions WHERE user_id = ? AND capability = ? AND subject = ?", [userId, capability, subject]);
}

export interface PermissionView { capability: string; label: string; description: string; default: Effect; effect: Effect; source: "default" | "rule"; grantedBy: string | null; grantedAt: number | null; }
export async function listPermissions(userId: string): Promise<PermissionView[]> { /* one row per CAPABILITIES key, subject '' */ }
```

**Step 4:** PASS. **Step 5:** commit `feat(permissions): capability registry and can()`.

### Task 3: admin API for permissions, audited

**Files:**
- Modify: `packages/shared/src/types.ts` (AuditEvent `action` union): add `"ADMIN_PERMISSION_SET"`, `"ADMIN_PERMISSION_CLEAR"`.
- Create: `packages/server/src/admin/permissions.ts`
- Modify: `packages/server/src/api/admin-routes.ts` (register routes in the admin scope, which already enforces the session-only admin gate)
- Test: `packages/server/tests/admin-permissions.test.ts` (new; copy setup from `tests/admin-users.test.ts`)

Routes:
- `GET /api/admin/users/:id/permissions` -> `{ permissions: PermissionView[], delegatedSpaces: number }` (`delegatedSpaces` = `SELECT COUNT(*) FROM spaces WHERE owner_id = ? AND access_mode = 'owner'`; add after Task 5 lands, return 0 until then).
- `PUT /api/admin/users/:id/permissions/:capability` body `{ effect: "allow" | "deny" }`.
- `DELETE /api/admin/users/:id/permissions/:capability` (back to default).

Tests: non-admin 403; unknown user 404; unknown capability 400 `unknown_capability`; set then GET shows `source: "rule"`, `grantedBy`; each write writes an audit row (`action: "ADMIN_PERMISSION_SET"`, `user_id` = admin, `tool` = `admin.permission.set → <target email> spaces.delegate_access=allow`), mirroring `admin/users.ts` `audit()`.

Commit `feat(admin): per-user permission routes`.

---

## Phase B: Audit columns

### Task 4: `actor_user_id` / `actor_email` on `audit_log`

**Files:**
- Modify: `packages/server/src/db.ts` (SQLite: add to the `ALTER TABLE` list `"ALTER TABLE audit_log ADD COLUMN actor_user_id TEXT"`, `"ALTER TABLE audit_log ADD COLUMN actor_email TEXT"` and `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id, created_at)` after the alters; PostgreSQL: `ADD COLUMN IF NOT EXISTS` lines and the same index)
- Modify: `packages/shared/src/types.ts` AuditEvent: `actor_user_id?: string; actor_email?: string | null;`
- Modify: `packages/server/src/audit/context.ts` AuditRequestContext: `actor_user_id?: string;`
- Modify: `packages/server/src/audit/logger.ts`: when `ctx.actor_user_id`, set `fullEvent.actor_user_id` and `fullEvent.actor_email = await auditUserEmail(ctx.actor_user_id)`. Add both to the `Omit<>` list in `AuditInput`.
- Modify: `packages/server/src/audit/destinations.ts` `DbDestination`: add both columns to the INSERT and params.
- Test: `packages/server/tests/spaces/audit.test.ts` (extend), `packages/server/tests/audit.test.ts` (DB destination writes the columns)

Failing test:

```ts
it("records the actor next to the user whose access ran", async () => {
  await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u2", "qa@example.com"]);
  await runWithAuditContext({ auth_method: "session", client_name: "space:s1", actor_user_id: "u2" }, () =>
    logger().log({ user_id: "u1", action: "EXECUTE", success: true })
  );
  expect(seen[0]).toMatchObject({ user_id: "u1", user_email: "dev@example.com", actor_user_id: "u2", actor_email: "qa@example.com" });
});
it("leaves actor fields out of an ordinary call", async () => { /* no actor_user_id in ctx -> no keys */ });
```

DB test: log through `DbDestination`, `SELECT actor_user_id, actor_email FROM audit_log` matches.

Commit `feat(audit): actor columns for delegated calls`.

### Task 5: `spaces.access_mode` column and store

**Files:**
- Modify: `packages/server/src/db.ts`: SQLite `"ALTER TABLE spaces ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'viewer'"`; PostgreSQL `ALTER TABLE spaces ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'viewer';`
- Modify: `packages/server/src/spaces/store.ts`:
  - `export type AccessMode = "viewer" | "owner";`
  - `Space.accessMode`, `SpaceRow.access_mode`, `COLUMNS` + `fromRow` (unknown value -> `"viewer"`).
  - `listAllSpaces` SELECT list gets `s.access_mode`.
  - `upsertSpace` input `accessMode?: AccessMode` (default `"viewer"`), included in insert and the `DO UPDATE SET`.
  - `updateSpaceMeta` patch `accessMode?: AccessMode`. **Rule inside the store:** if the resulting visibility is `"private"`, force `accessMode = "viewer"` in the same UPDATE. Return the resulting Space.
- Test: `packages/server/tests/spaces/store.test.ts`

Tests: default is viewer; patch to owner persists; setting visibility private in the same or a later patch resets to viewer; `upsertSpace` (redeploy) keeps the value passed.

Commit `feat(spaces): access_mode column`.

---

## Phase C: Setting the mode

### Task 6: one policy function for enabling delegation

**Files:**
- Create: `packages/server/src/spaces/delegation.ts`
- Test: `packages/server/tests/spaces/delegation.test.ts`

```ts
import { can } from "../permissions/store";
import { isUserDisabled } from "../auth/user-status";
import type { Space, Visibility } from "./store";

export type DelegationCheck = { ok: true } | { ok: false; code: "DELEGATION_NOT_ALLOWED"; message: string };

/** May `ownerId` set access_mode 'owner' on a Space with this visibility? */
export async function mayDelegate(ownerId: string, visibility: Visibility): Promise<DelegationCheck> {
  if (visibility === "private") return { ok: false, code: "DELEGATION_NOT_ALLOWED", message: "Delegated access needs a Space shared with specific people or everyone signed in." };
  if (!(await can(ownerId, "spaces.delegate_access"))) return { ok: false, code: "DELEGATION_NOT_ALLOWED", message: "An admin has not allowed you to delegate access." };
  return { ok: true };
}

export type DelegationState = { mode: "viewer" } | { mode: "owner"; runAs: string } | { mode: "off"; message: string };

/** Per call: whose access runs, or why delegated access is off. Never falls back to the viewer. */
export async function delegationFor(space: Space): Promise<DelegationState> {
  if (space.accessMode !== "owner") return { mode: "viewer" };
  const off = { mode: "off" as const, message: "This Space's shared access was turned off." };
  if (space.visibility === "private") return off;
  if (!(await can(space.ownerId, "spaces.delegate_access"))) return off;
  if (await isUserDisabled(space.ownerId)) return off;
  return { mode: "owner", runAs: space.ownerId };
}
```

Tests cover each branch.

Commit `feat(spaces): delegation policy`.

### Task 7: portal sharing API accepts `delegate_access`

**Files:**
- Modify: `packages/server/src/spaces/api.ts` `PATCH /:name/sharing`
- Modify: `packages/shared/src/types.ts` action union: `"SPACE_DELEGATION_ON"`, `"SPACE_DELEGATION_OFF"`, `"SPACE_SHARING_CHANGE"`.
- Test: `packages/server/tests/spaces/api.test.ts`

Behaviour:
- Body gains `delegate_access?: boolean`. Non-boolean -> 400 `INVALID_ARGS`.
- Desired mode = body value, else current. If desired is owner: `mayDelegate(viewer.userId, visibility)`; failure -> 403 with its code. Validate before any write (existing "validate the outcome before writing anything" block).
- Write mode with the visibility change via `updateSpaceMeta(..., { visibility, accessMode })`.
- Audit (with `auditLogger.log`, `user_id` = owner, `tool` = `space:<name>`): ON / OFF when mode changes (OFF with `error: "reason: audience set to only me"` when forced), `SPACE_SHARING_CHANGE` with `tool` `space:<name> org→users` style text when visibility changes while the resulting mode is owner.
- Response: `{ visibility, users, delegate_access: boolean, can_delegate: boolean }`.
- `GET /:name` adds `delegate_access` always and `can_delegate` for the owner (from `can()`), and `owner_name` (owner email) is already there as `ownerEmail`.

Tests: owner without grant -> 403 DELEGATION_NOT_ALLOWED and nothing changed; with grant and visibility users -> 200, persisted; private + delegate -> 403; switching to private while delegated -> mode viewer and an OFF audit row; non-owner -> 403 FORBIDDEN (existing).

Commit `feat(spaces): delegate_access in the sharing API`.

### Task 8: agent tools

**Files:**
- Modify: `packages/server/src/plugins/internal/spaces.ts` (`deploy_space`, `update_space`, `list_spaces`)
- Test: `packages/server/tests/spaces/plugin.test.ts`

- `deploy_space` / `update_space` input `delegate_access: z.boolean().optional()`. Same `mayDelegate` check, same `DELEGATION_NOT_ALLOWED` error object, same audit rows (share a helper with Task 7: `applyDelegationChange()` in `spaces/delegation.ts`, so both paths write the same audit).
- `deploy_space` over an existing Space without `delegate_access` keeps the current mode, unless the new visibility is private (store resets).
- `list_spaces` returns `delegate_access`.
- Descriptions: one sentence each, e.g. "`delegate_access: true` runs every viewer's calls with your connected apps (admin must allow it; needs visibility org or users; every call is audited under both of you)."

Tests mirror Task 7 through `spacesTool()`.

Commit `feat(spaces): delegate_access on agent tools`.

---

## Phase D: Call path

### Task 9: run delegated calls as the owner

**Files:**
- Modify: `packages/server/src/spaces/api.ts` (`POST /:name/call`, `GET /:name`)
- Modify: `packages/server/src/spaces/rate-limit.ts`
- Test: `packages/server/tests/spaces/api.test.ts`, `packages/server/tests/spaces/rate-limit.test.ts`

Changes in `/call`, after step 4 (exists) and before step 5 (destructive):

```ts
const delegation = await delegationFor(space);
if (delegation.mode === "off") {
  return fail(reply, 403, { code: "DELEGATION_OFF", message: delegation.message, integration: tool.integration, tool: toolName });
}
const runAs = delegation.mode === "owner" ? delegation.runAs : viewer.userId;
```

Rate limit: keep `takeToken(viewer.userId, space.name)`; when delegated also `takeOwnerToken(space.ownerId, space.name)` (new bucket, capacity `OWNER_RATE_CAPACITY = 300` per minute, same refill math, separate map key prefix). Either failing -> 429.

Run:

```ts
const audit = currentAuditContext();
if (audit) {
  audit.client_name = `space:${space.name}`;
  if (runAs !== viewer.userId) audit.actor_user_id = viewer.userId;
}
const outcome = await executeSingle(runAs, toolName, args as Record<string, unknown>, new Map());
```

NOT_CONNECTED when delegated: 409 with `delegated: true`, message `"<owner email> needs to reconnect <integration display name>."`.

`GET /:name`: `connected` uses `runAs` (owner when `delegationFor` is owner mode); add `delegate_access`, `delegation_off: boolean`.

Tests (fixture handler captures `ctx.userId`; extend `handlers.list` to return `as: ctx.userId`):
1. delegated: viewer u2 calls, result `as === "u1"`; audit row `user_id u1`, `actor_user_id u2`, `client_name space:s1`.
2. not delegated: `as === "u2"`, no actor (regression).
3. grant revoked: 403 DELEGATION_OFF, handler not called.
4. owner disabled: 403 DELEGATION_OFF.
5. owner not connected (`acmeo_list_things`, owner has no token, viewer HAS a token seeded): 409 NOT_CONNECTED with `delegated: true`. Proves no fallback to the viewer's token.
6. undeclared tool still 403 TOOL_NOT_DECLARED in delegated mode.
7. vault ref still 400.
8. destructive still 428 without `confirmed`.
9. KV: u2 and u3 writes stay separate in a delegated Space.
10. owner bucket: 301 calls across u2 and u3 within a minute -> 429 (use `_setNowForTest`).

Commit `feat(spaces): run delegated calls with the owner's access`.

---

## Phase E: Activity

### Task 10: activity rows for both people

**Files:**
- Modify: `packages/server/src/audit/query.ts` (`listAuditEvents`, `AuditEventRow`, `listAllAuditEvents`, `AdminAuditEventRow`)
- Modify: `packages/server/src/api/routes.ts` `/api/activity` (accept `delegated=1` filter)
- Modify: `packages/server/src/admin/activity.ts` (email filter matches either person)
- Test: `packages/server/tests/audit-query.test.ts`, `packages/server/tests/activity-routes.test.ts`

- `listAuditEvents`: `where` starts with `(user_id = ? OR actor_user_id = ?)`; `delegated?: boolean` adds `actor_user_id IS NOT NULL`. SELECT adds `user_id, actor_user_id, client_name` and returns `delegation: null | { direction: "by_me" | "for_me"; other_email: string | null; space: string | null }` (`for_me` when `user_id = me` and actor set: someone used my access; `by_me` when `actor_user_id = me`). `other_email` via LEFT JOIN users on the other id, fallback to the stored `user_email` / `actor_email`. `space` parsed from `client_name` prefix `space:`.
- `summarizeAudit` unchanged (counts calls on your access). Note this in a comment.
- Admin rows add `actor_user_id`, `actor_email`; email filter becomes `(LOWER(a.user_email) = ? OR LOWER(a.actor_email) = ? OR ...)` following the existing email predicate shape.

Tests: owner sees row with `for_me`, viewer sees same row with `by_me`, a third user sees nothing; `delegated=1` filters; admin list one row with both emails.

Commit `feat(activity): delegated calls visible to both people`.

---

## Phase F: Review gate

### Task 11: UI prototype for review (no product code)

Per the project's prototype-first rule:
- Throwaway Vite preview page under the scratchpad rendering the real portal components with mocked data for: Admin Permissions section (granted, default, revoke confirmation with count); Sharing modal (switch hidden, disabled on Only me, on with write-tool warning, widen warning); Spaces list badge; viewer consent copy, bar label, destructive dialog, DELEGATION_OFF and owner-not-connected errors; Activity delegated rows both directions.
- Playwright screenshots, light and dark, sent to the user. **Stop and wait for approval.**

---

## Phase G: Portal (after prototype approval)

### Task 12: portal API types

`packages/portal/src/spaces-api.ts` (`SpaceDetail.delegate_access`, `can_delegate`, `delegation_off`; `updateSpaceSharing` body + response; error codes `DELEGATION_NOT_ALLOWED`, `DELEGATION_OFF`), `packages/portal/src/api.ts` (activity row `delegation`, admin permissions calls). Tests in the matching `*.test.ts`.

### Task 13: Admin Permissions section

`packages/portal/src/pages/Admin.tsx` (user detail): list from `GET /api/admin/users/:id/permissions`, toggle Allow / Default, revoke confirmation shows `delegatedSpaces`. Test in `Admin.test.tsx`.

### Task 14: Sharing modal switch

`packages/portal/src/spaces/SharingModal.tsx`: switch "Delegate my access" (hidden when `!can_delegate`, disabled on Only me), write-tool list from the Space detail tools with `effect !== "read"`, second confirmation on enable and on widening while on. Tests in `SharingModal.test.tsx`.

### Task 15: viewer surfaces

`packages/portal/src/pages/SpaceShell.tsx` + `packages/portal/src/spaces/bridge.ts`: consent copy, bar label "Using <owner>'s delegated access", destructive dialog "Run <tool> as <owner>?", error copy for `DELEGATION_OFF` and delegated `NOT_CONNECTED` (no connect button). `packages/portal/src/pages/Spaces.tsx`: "Delegated" badge. Tests in `bridge.test.ts` and page tests.

### Task 16: Activity page

`packages/portal/src/pages/Activity.tsx`: "Delegated" tag with direction copy ("<email> used your access via <space>" / "You used <email>'s access via <space>"), filter chip -> `delegated=1`. Test in `Activity.test.tsx`.

Commit per task.

---

## Phase H: Finish

### Task 17: docs, finding, full verification

- Docs: `docs/site/_content/` Spaces page section "Delegated access" (what it does, admin grant, audit, failure modes). Admin page: Permissions.
- Finding: `docs/findings/2026-11-26-space-delegated-access.md` (why a generic permission store, why one co-owned audit row, why no fallback, the owner rate bucket being per process like the viewer bucket) + index line in `CLAUDE.md`.
- Release notes: add to the next version file under Features.
- Run: full server tests, portal tests, both tsc configs, `node docs/site/build.mjs`, PostgreSQL integration suite if `TEST_DATABASE_URL` is available.
- Scrub: `git diff main... | grep -inE '<company>|@(icloud|gmail)\.com|<real-name>'`.
- Push branch, open PR (only when the user asks).
