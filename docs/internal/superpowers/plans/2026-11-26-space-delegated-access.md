# Space Delegated Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an admin-granted Space owner switch a shared Space, from the portal, to run every tool call with the owner's connections ("Delegate my access"), pinned to the confirmed tool list, with both people on every audit row.

**Architecture:** A new generic per-user permission store (`user_permissions` + `can()`) gates the feature. `spaces.access_mode` (`viewer` | `owner`) and `spaces.delegated_tools_hash` decide, per call, whose user id `executeSingle` runs as in `POST /api/spaces/:name/call`. `executeSingle` gains an `actorUserId` option: the actor goes to the audit context (two new nullable `audit_log` columns) and to request log lines, and disables cookie auto-reconnect. Viewer consent hashes tools, mode and owner.

**Tech Stack:** TypeScript, Fastify, SQLite + PostgreSQL via `db` adapter (`packages/server/src/db.ts`), vitest, React + TanStack Query portal.

**Design:** `docs/internal/superpowers/specs/2026-11-26-space-delegated-access-design.md` (revised after review; read the Threat model section first).

**Ground rules for every task**
- Public repo: synthetic fixtures only (`dev@example.com`, `qa@example.com`, `acme`). No real names, no company or internal refs.
- No em-dashes in user-facing copy. No emoji.
- Fresh worktree: build `shared` and `brand` once (`npm run build -w @a-workbench/shared -w @a-workbench/brand`) or tests fail to resolve them.
- Server tests: `npm run test -w @a-workbench/server -- <file>`. Portal: `npm run test -w @a-workbench/portal -- <file>`.
- Type-check tests too: `npx tsc --noEmit -p packages/server/tsconfig.test.json`.
- Every schema change goes in **both** the SQLite and PostgreSQL schema / migration blocks in `packages/server/src/db.ts`.
- No empty or comment-only test bodies. A test that cannot fail is not a test.
- Commit after each task. Conventional commit messages. No AI trailers.

---

## Phase A: Permission layer

### Task 1: `user_permissions` table and migration list

**Files:**
- Modify: `packages/server/src/db.ts` (both schema strings, after `space_kv`)
- Modify: `packages/server/src/migrate/plan.ts` (`TABLES`: add `"user_permissions"`)
- Test: `packages/server/tests/permissions.test.ts` (new), `packages/server/tests/migrate-plan.test.ts` (update the expected table list)

**Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";

describe("user_permissions table", () => {
  beforeEach(async () => { await db.exec("DELETE FROM user_permissions"); });
  it("keeps one rule per (user, capability, subject)", async () => {
    const insert = (effect: string) =>
      db.run(
        "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["u1", "spaces.delegate_access", "", effect, "admin", 1]
      );
    await insert("allow");
    await expect(insert("deny")).rejects.toThrow();
  });
});
```

**Step 2:** run, expect FAIL (table missing; wording differs per backend, any error is fine).

**Step 3:** SQLite:

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

PostgreSQL: same with `granted_at BIGINT NOT NULL`. Add `"user_permissions"` to `TABLES` in `migrate/plan.ts` and the expected list in its test.

**Step 4:** PASS. **Step 5:** commit `feat(permissions): user_permissions table`.

### Task 2: capability registry + `can()`

**Files:**
- Create: `packages/server/src/permissions/capabilities.ts`
- Create: `packages/server/src/permissions/store.ts`
- Test: `packages/server/tests/permissions.test.ts`

**Step 1: Failing tests** (every body asserts something):

```ts
import { can, setPermission, clearPermission, listPermissions } from "../src/permissions/store";
import { CAPABILITIES } from "../src/permissions/capabilities";

describe("can()", () => {
  beforeEach(async () => { await db.exec("DELETE FROM user_permissions"); });

  it("falls back to the declared default", async () => {
    expect(CAPABILITIES["spaces.delegate_access"].default).toBe("deny");
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
  });
  it("an allow row grants; a deny row refuses", async () => {
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
  it("is scoped to the user", async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    expect(await can("u2", "spaces.delegate_access")).toBe(false);
  });
  it("rejects an undeclared capability on write and never grants it on read", async () => {
    await expect(setPermission({ userId: "u1", capability: "nope", effect: "allow", grantedBy: "a" })).rejects.toThrow(/unknown capability/);
    await db.run(
      "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES ('u1','nope','','allow','a',1)"
    );
    expect(await can("u1", "nope")).toBe(false);
  });
  it("reads through: no cache between a write and the next check", async () => {
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
    await db.run(
      "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES ('u1','spaces.delegate_access','','allow','a',1)"
    );
    expect(await can("u1", "spaces.delegate_access")).toBe(true);
  });
  it("listPermissions shows each capability with default vs rule", async () => {
    expect((await listPermissions("u1"))[0]).toMatchObject({ capability: "spaces.delegate_access", effect: "deny", source: "default", grantedBy: null });
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    expect((await listPermissions("u1"))[0]).toMatchObject({ effect: "allow", source: "rule", grantedBy: "admin" });
  });
});
```

**Step 3: Implementation**

`capabilities.ts`:

```ts
export type Effect = "allow" | "deny";
export interface CapabilityDef { default: Effect; label: string; description: string; }
export const CAPABILITIES = {
  "spaces.delegate_access": {
    default: "deny",
    label: "Delegate access in Spaces",
    description: "Lets this user share Spaces that run with their connected apps.",
  },
} as const satisfies Record<string, CapabilityDef>;
export type Capability = keyof typeof CAPABILITIES;
export function capabilityDef(key: string): CapabilityDef | undefined {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, key) ? (CAPABILITIES as Record<string, CapabilityDef>)[key] : undefined;
}
```

`store.ts` (general rules only, `subject = ''`; subject precedence arrives with the first capability that needs it):

```ts
import { db } from "../db";
import { CAPABILITIES, capabilityDef, type Effect } from "./capabilities";

export async function can(userId: string, capability: string): Promise<boolean> {
  const def = capabilityDef(capability);
  if (!def) return false;
  const row = await db.get<{ effect: string }>(
    "SELECT effect FROM user_permissions WHERE user_id = ? AND capability = ? AND subject = ''",
    [userId, capability]
  );
  return (row?.effect ?? def.default) === "allow";
}

export async function setPermission(i: { userId: string; capability: string; effect: Effect; grantedBy: string }): Promise<void> {
  if (!capabilityDef(i.capability)) throw new Error(`unknown capability: ${i.capability}`);
  await db.run(
    `INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES (?, ?, '', ?, ?, ?)
     ON CONFLICT (user_id, capability, subject) DO UPDATE SET effect = excluded.effect, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
    [i.userId, i.capability, i.effect, i.grantedBy, Math.floor(Date.now() / 1000)]
  );
}

export async function clearPermission(userId: string, capability: string): Promise<void> {
  await db.run("DELETE FROM user_permissions WHERE user_id = ? AND capability = ? AND subject = ''", [userId, capability]);
}

export interface PermissionView {
  capability: string; label: string; description: string;
  default: Effect; effect: Effect; source: "default" | "rule";
  grantedBy: string | null; grantedAt: number | null;
}
export async function listPermissions(userId: string): Promise<PermissionView[]> {
  const rows = await db.all<{ capability: string; effect: string; granted_by: string; granted_at: number | string }>(
    "SELECT capability, effect, granted_by, granted_at FROM user_permissions WHERE user_id = ? AND subject = ''",
    [userId]
  );
  return Object.entries(CAPABILITIES).map(([key, def]) => {
    const r = rows.find((x) => x.capability === key);
    return {
      capability: key, label: def.label, description: def.description, default: def.default,
      effect: (r?.effect as Effect) ?? def.default, source: r ? "rule" : "default",
      grantedBy: r?.granted_by ?? null, grantedAt: r ? Number(r.granted_at) : null,
    };
  });
}
```

**Step 4:** PASS. **Step 5:** commit `feat(permissions): capability registry and can()`.

### Task 3: admin API for permissions, audited

**Files:**
- Modify: `packages/shared/src/types.ts` (AuditEvent `action` union): add `"ADMIN_PERMISSION_SET"`, `"ADMIN_PERMISSION_CLEAR"`. Rebuild shared.
- Create: `packages/server/src/admin/permissions.ts`
- Modify: `packages/server/src/api/admin-routes.ts` (inside the existing admin scope, next to the `/users` routes at ~line 32)
- Test: `packages/server/tests/admin-permissions.test.ts` (new; copy setup from `tests/admin-users.test.ts`)

Routes:
- `GET /api/admin/users/:id/permissions` -> `{ permissions: PermissionView[], delegatedSpaces: number }`. `delegatedSpaces` = `SELECT COUNT(*) FROM spaces WHERE owner_id = ? AND access_mode = 'owner'` (column lands in Task 5; until then return 0 and add the query in Task 5).
- `PUT /api/admin/users/:id/permissions/:capability` body `{ effect: "allow" }` (only `allow` accepted for now; UI is Allow / Default).
- `DELETE /api/admin/users/:id/permissions/:capability` (back to Default).

Audit like `admin/users.ts` `audit()`: `user_id` = admin, `action` `ADMIN_PERMISSION_SET` / `ADMIN_PERMISSION_CLEAR`, `tool` = `admin.permission.set → <target email or id> spaces.delegate_access`.

Tests: non-admin 403; API-key auth refused (admin gate is session-only); unknown user 404 `user_not_found`; unknown capability 400 `unknown_capability`; PUT then GET shows `source: "rule"`, `grantedBy` = admin id; DELETE returns to default; each write leaves one audit row with the right action.

Commit `feat(admin): per-user permission routes`.

---

## Phase B: Columns

### Task 4: `actor_user_id` / `actor_email` on `audit_log`, actor in log lines

**Files:**
- Modify: `packages/server/src/db.ts`: SQLite ALTER list: `"ALTER TABLE audit_log ADD COLUMN actor_user_id TEXT"`, `"ALTER TABLE audit_log ADD COLUMN actor_email TEXT"`; after the ALTER loop `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id, created_at)`. PostgreSQL: `ADD COLUMN IF NOT EXISTS` for both and the same index after them.
- Modify: `packages/shared/src/types.ts` AuditEvent: `actor_user_id?: string; actor_email?: string | null;`
- Modify: `packages/server/src/audit/context.ts`: `AuditRequestContext.actor_user_id?: string`; `requestLogFields()` adds `actor_user_id` and `actor_email` when set.
- Modify: `packages/server/src/audit/logger.ts`: copy `ctx.actor_user_id` to the event, plus `actor_email = await auditUserEmail(...)`; add both to the `Omit<>` in `AuditInput`.
- Modify: `packages/server/src/audit/destinations.ts` `DbDestination`: both columns in the INSERT and params.
- Test: `packages/server/tests/spaces/audit.test.ts`, `packages/server/tests/audit.test.ts`, `packages/server/tests/audit-context.test.ts`

Tests:
- logger: with `actor_user_id: "u2"` in context the event has `actor_user_id: "u2"`, `actor_email: "qa@example.com"`, `user_id: "u1"`; without it, neither key is present.
- DB destination writes both columns (`SELECT actor_user_id, actor_email FROM audit_log`).
- `requestLogFields("u1")` inside a context with an actor contains `actor_user_id`.

Commit `feat(audit): actor columns for delegated calls`.

### Task 5: `spaces.access_mode` + `delegated_tools_hash`

**Files:**
- Modify: `packages/server/src/db.ts`: SQLite ALTER list `"ALTER TABLE spaces ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'viewer'"`, `"ALTER TABLE spaces ADD COLUMN delegated_tools_hash TEXT"`; PostgreSQL `ADD COLUMN IF NOT EXISTS` equivalents.
- Modify: `packages/server/src/spaces/store.ts`
- Modify: `packages/server/src/admin/permissions.ts` (`delegatedSpaces` count)
- Test: `packages/server/tests/spaces/store.test.ts`

Store changes:
- `export type AccessMode = "viewer" | "owner";` `Space.accessMode`, `Space.delegatedToolsHash: string | null`; row fields, `COLUMNS`, `fromRow` (unknown mode -> `"viewer"`); `listAllSpaces` SELECT gets both.
- `upsertSpace(input)` gains optional `accessMode?: AccessMode`. On INSERT: `input.accessMode ?? "viewer"`. On conflict the SET is:
  ```sql
  access_mode = CASE
    WHEN excluded.visibility = 'private' THEN 'viewer'
    WHEN ? IS NULL THEN spaces.access_mode
    ELSE ? END,
  delegated_tools_hash = CASE
    WHEN excluded.visibility = 'private' THEN NULL
    WHEN ? IS NULL THEN spaces.delegated_tools_hash
    ELSE NULL END
  ```
  binding `input.accessMode ?? null` to the placeholders (agent tools only ever pass `"viewer"` or nothing, so a passed value always clears the hash). Return `{ result: "ok" | "taken", modeReset: boolean }` where `modeReset` is true when the previous row was `owner` and the new one is `viewer` (read the previous mode in the same transaction: wrap in `db.transaction`, `SELECT access_mode ... FOR` nothing special needed, the owner predicate already guards).
  - Keep the existing `"ok" | "taken"` callers compiling: update `plugins/internal/spaces.ts` and tests to the new shape.
- `updateSpaceMeta(name, ownerId, patch)` patch gains `accessMode?: AccessMode` and `confirmDelegation?: boolean`. Resulting values:
  - `visibility === "private"` -> `accessMode = "viewer"`, hash `null`.
  - `accessMode === "owner"` and `confirmDelegation` -> hash = `toolsHash(next.tools)`.
  - `accessMode === "viewer"` -> hash `null`.
  - otherwise keep both.
  The UPDATE writes title, description, tools, visibility, access_mode, delegated_tools_hash, updated_at. Return `{ space, modeReset }`.
- `export function delegationSuspended(s: Space): boolean { return s.accessMode === "owner" && s.delegatedToolsHash !== toolsHash(s.tools); }`

Tests: default viewer + null hash; enable with confirm records the hash; changing `tools` afterwards makes `delegationSuspended` true; re-confirm clears it; private via `updateSpaceMeta` resets and reports `modeReset`; private via `upsertSpace` redeploy resets and reports `modeReset`; redeploy without `accessMode` keeps owner and hash.

Commit `feat(spaces): access_mode and delegated tools hash`.

### Task 6: consent bound to mode and owner

**Files:**
- Modify: `packages/server/src/spaces/store.ts` (`hasConsent`, `grantConsent`)
- Test: `packages/server/tests/spaces/store.test.ts`, `packages/server/tests/spaces/api.test.ts`

```ts
export function consentHash(space: Space): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify([toolsHash(space.tools), space.accessMode, space.ownerId]))
    .digest("hex");
}
```

`hasConsent` compares against `consentHash(space)`; `grantConsent` stores it (column is still `tools_hash`; add a comment that it now holds the consent hash). Existing consents become invalid once on deploy, so every viewer re-approves once: note it in the release notes.

Tests: consent then flip mode viewer->owner -> `hasConsent` false; owner->viewer -> false; tools change -> false (existing behaviour kept). API: `/call` after a mode flip returns 403 `CONSENT_REQUIRED`.

Commit `feat(spaces): consent covers access mode and owner`.

---

## Phase C: Setting the mode

### Task 7: delegation policy

**Files:**
- Create: `packages/server/src/spaces/delegation.ts`
- Modify: `packages/shared/src/types.ts`: `ToolDefinition.delegable?: boolean` with a comment ("false: refused when a Space runs with its owner's access, e.g. tools that rewrite their own stored credential").
- Modify: `packages/plugins/clevertap/tools/index.ts`: `delegable: false` on `clevertap_set_projects` (and any other tool there that calls `saveProjects`/`storeToken`). Grep the plugins for `storeToken(` and mark each such tool.
- Test: `packages/server/tests/spaces/delegation.test.ts`

```ts
import { can } from "../permissions/store";
import { db } from "../db";
import { delegationSuspended, type Space, type Visibility } from "./store";

export type EnableCheck = { ok: true } | { ok: false; code: "DELEGATION_NOT_ALLOWED"; message: string };

export async function mayEnableDelegation(ownerId: string, visibility: Visibility): Promise<EnableCheck> {
  if (visibility === "private") return { ok: false, code: "DELEGATION_NOT_ALLOWED", message: "Delegated access needs a Space shared with specific people or everyone signed in." };
  if (!(await can(ownerId, "spaces.delegate_access"))) return { ok: false, code: "DELEGATION_NOT_ALLOWED", message: "An admin has not allowed you to delegate access." };
  return { ok: true };
}

export type DelegationState =
  | { mode: "viewer" }
  | { mode: "owner"; runAs: string }
  | { mode: "off"; reason: "turned_off" | "tools_changed"; message: string };

/** Per call. Never falls back to the viewer. */
export async function delegationFor(space: Space): Promise<DelegationState> {
  if (space.accessMode !== "owner") return { mode: "viewer" };
  const off = { mode: "off" as const, reason: "turned_off" as const, message: "This Space's shared access was turned off." };
  if (space.visibility === "private") return off;
  const owner = await db.get<{ disabled_at: number | string | null }>("SELECT disabled_at FROM users WHERE id = ?", [space.ownerId]);
  if (!owner || (owner.disabled_at !== null && owner.disabled_at !== undefined)) return off;
  if (!(await can(space.ownerId, "spaces.delegate_access"))) return off;
  if (delegationSuspended(space)) return { mode: "off", reason: "tools_changed", message: "This Space's tools changed. The owner needs to confirm them again." };
  return { mode: "owner", runAs: space.ownerId };
}
```

Plus `recordDelegationChange(space, ownerId, change: "on" | "off", reason?)` writing `SPACE_DELEGATION_ON` / `SPACE_DELEGATION_OFF` (`user_id` owner, `tool` `space:<name>`, `error` `reason: ...` when forced). Add both actions to the shared union.

Tests: each branch of `delegationFor` (viewer, private, missing owner row, disabled owner, not granted, tools changed, ok); `mayEnableDelegation` both refusals and ok; `recordDelegationChange` writes the row.

Commit `feat(spaces): delegation policy`.

### Task 8: portal sharing API

**Files:**
- Modify: `packages/server/src/spaces/api.ts` (`PATCH /:name/sharing`, `GET /:name`)
- Test: `packages/server/tests/spaces/api.test.ts`

The spaces scope already accepts only a portal session (`preHandler` at ~line 129), so this route is the human path.

- Body gains `delegate_access?: boolean` (non-boolean -> 400 `INVALID_ARGS`) and `tools_hash?: string`: the `toolsHash` of the list the owner was shown (GET `/:name` returns `tools_hash` for the owner). Enabling or re-confirming passes it as `expectedToolsHash`; `updateSpaceMeta` returns `"tools_changed"` when it is missing or stale -> 409 `TOOLS_CHANGED` ("The tool list changed. Review it again."), nothing written.
- If `delegate_access === true`: `mayEnableDelegation(owner, resultingVisibility)`; refusal -> 403 with its code, before any write.
- Write when **visibility or mode or (delegate_access true, i.e. a re-confirm)** differs: `updateSpaceMeta(name, owner, { visibility, accessMode, confirmDelegation: delegate_access === true })`. (Fixes the old "only when visibility changed" condition at ~line 263.)
- Audit: ON when turned on or re-confirmed; OFF when turned off; OFF with reason when `modeReset` from a private change.
- Response `{ visibility, users, delegate_access, delegation_suspended }`.
- `GET /:name`: adds `delegate_access`, `delegation_suspended`, `delegation_off` (from `delegationFor`), owner-only `can_delegate` (from `can()`), and each tool's `delegable` (`tool.delegable !== false`). `connected` uses the owner's id when `delegationFor` is owner mode.

Tests: not granted -> 403 DELEGATION_NOT_ALLOWED, nothing changed, no audit row; granted + users -> 200, `access_mode owner`, hash recorded, ON row; private + true -> 403; delegated then private -> viewer + OFF row with reason; mode-only change (true then false, visibility unchanged) persists; re-confirm after a tool change clears `delegation_suspended`; non-owner 403.

Commit `feat(spaces): delegate_access in the sharing API`.

### Task 9: agent tools

**Files:**
- Modify: `packages/server/src/plugins/internal/spaces.ts` (`deploy_space`, `update_space`, `list_spaces`, `HOW_TO_BUILD` at ~lines 82-85)
- Test: `packages/server/tests/spaces/plugin.test.ts`

- `deploy_space` / `update_space` input `delegate_access: z.boolean().optional()`. `true` -> `{ error: "DELEGATION_PORTAL_ONLY", message: "Delegated access can only be turned on by you in the portal (Space > Sharing)." }`, nothing written. `false` -> mode viewer, OFF audit row if it was owner.
- `deploy_space` without the field keeps the mode (store handles it); if `modeReset`, write the OFF row with `reason: audience set to only me`.
- `update_space` changing `tools` on a delegated Space: allowed, result includes `delegation_suspended: true` and a `note`: "Delegated access is paused until you confirm the new tool list in the portal."
- `list_spaces`: `delegate_access`, `delegation_suspended`.
- `HOW_TO_BUILD`: replace the "always THEIR connections" wording with "the viewer's connections, or the owner's when the owner turned on delegated access in the portal"; add `DELEGATION_OFF`, `TOOL_NOT_DELEGABLE` to the error-code list.

Tests: `true` refused on both tools with nothing changed; `false` turns it off and audits; redeploy keeps it; redeploy to private resets and audits; tools change reports suspended; list shows both fields.

Commit `feat(spaces): agent tools can read and disable delegation`.

---

## Phase D: Call path

### Task 10: `executeSingle` actor option

**Files:**
- Modify: `packages/server/src/mcp/meta-tools.ts` (`executeSingle` ~line 295, cookie check ~line 333)
- Modify: `packages/server/src/auth/reconnect/runner.ts` (`ensureCookieSession` signature)
- Modify: `packages/server/src/plugins/context.ts` (`createContext` ~line 63, reconnect call ~line 154)
- Test: `packages/server/tests/meta-tools.test.ts`, `packages/server/tests/plugin-context.test.ts` (or the existing context test file; grep for `reconnectSession` mocks)

- `executeSingle(userId, toolName, rawArgs, preSubstituted?, opts?: { actorUserId?: string })`.
- With `actorUserId`: set `currentAuditContext().actor_user_id = opts.actorUserId` (when a context exists); pass `{ autoReconnect: false }` to `ensureCookieSession` and to `createContext`.
- `ensureCookieSession(userId, integration, opts?: { autoReconnect?: boolean })`: when false, report connected only if a live session exists, never run the reconnect recipe.
- `createContext(userId, integration, opts?)`: when `autoReconnect === false`, `ctx.http` returns the dead response instead of calling `reconnectSession`.

Tests: with an actor, a cookie integration whose session is dead returns `NOT_CONNECTED` and `reconnectSession` is not called; without an actor, existing behaviour (reconnect attempted) unchanged; the audit event carries `actor_user_id`.

Commit `feat(mcp): executeSingle actor option`.

### Task 11: run delegated calls as the owner

**Files:**
- Modify: `packages/server/src/spaces/api.ts` (`POST /:name/call`)
- Modify: `packages/server/src/spaces/rate-limit.ts`
- Modify: `packages/server/tests/spaces/fixtures.ts` (new OAuth fixture tool)
- Test: `packages/server/tests/spaces/api.test.ts`, `packages/server/tests/spaces/rate-limit.test.ts`

Fixture: add to `acmeOauthPlugin` a tool `acmeo_whoami` (`effect: "read"`) whose handler returns `{ token: await ctx.getToken() }`. Seed tokens with `storeToken("u1", "acme-oauth", { accessToken: "tok-owner", ... })` and `storeToken("u2", "acme-oauth", { accessToken: "tok-viewer", ... })`. Add a `acme_set_secret` tool with `delegable: false`.

In `/call`, after step 4 (exists), before step 5 (destructive):

```ts
const delegation = await delegationFor(space);
const actor = delegation.mode === "viewer" ? undefined : viewer.userId;
const refuse = async (status: number, body: Record<string, unknown>) => {
  if (actor) {
    const ctx = currentAuditContext();
    if (ctx) { ctx.client_name = `space:${space.name}`; ctx.actor_user_id = actor; }
    await auditLogger.log({ user_id: space.ownerId, integration: tool.integration, tool: toolName, action: "EXECUTE", success: false, error: String(body.code) });
  }
  return fail(reply, status, body);
};
if (delegation.mode === "off") return refuse(403, { code: "DELEGATION_OFF", reason: delegation.reason, message: delegation.message, integration: tool.integration, tool: toolName });
if (delegation.mode === "owner" && tool.delegable === false) return refuse(403, { code: "TOOL_NOT_DELEGABLE", message: `${toolName} cannot run with someone else's access.`, integration: tool.integration, tool: toolName });
const runAs = delegation.mode === "owner" ? delegation.runAs : viewer.userId;
```

Rate limit: viewer bucket as today; when delegated also `takeOwnerToken(space.ownerId, space.name)` (`OWNER_RATE_CAPACITY = 300`/min, separate key prefix `owner\u0000`). A delegated 429 goes through `refuse`.

Run: `executeSingle(runAs, toolName, args, new Map(), actor ? { actorUserId: actor } : undefined)` with `client_name` set as today. Delegated `NOT_CONNECTED`: 409 `{ code: "NOT_CONNECTED", delegated: true, message: "<owner email> needs to reconnect <integration display name>." }`.

Tests:
1. delegated: u2 calls `acmeo_whoami` -> `token === "tok-owner"`; audit row `user_id u1`, `actor_user_id u2`, `client_name space:s1`.
2. not delegated: u2 -> `tok-viewer`; no actor (regression).
3. owner token deleted, viewer still has one: 409 NOT_CONNECTED `delegated: true` (no fallback).
4. grant revoked -> 403 DELEGATION_OFF `reason turned_off`, handler not called, audit row success false with both ids.
5. owner disabled -> DELEGATION_OFF. Owner row deleted -> DELEGATION_OFF.
6. tools changed after enable -> DELEGATION_OFF `reason tools_changed`.
7. `acme_set_secret` -> 403 TOOL_NOT_DELEGABLE, audited.
8. undeclared tool -> TOOL_NOT_DELEGABLE not reached, TOOL_NOT_DECLARED as before.
9. vault ref -> 400; destructive without `confirmed` -> 428.
10. KV: u2 and u3 writes stay separate.
11. owner bucket: 301 calls across u2 and u3 inside a minute -> 429 (`_setNowForTest`), audited.

Commit `feat(spaces): run delegated calls with the owner's access`.

---

## Phase E: Activity

### Task 12: activity rows for both people

**Files:**
- Modify: `packages/server/src/audit/query.ts` (`listAuditEvents`, `AuditEventRow`, `listAllAuditEvents`, `AdminAuditEventRow`)
- Modify: `packages/server/src/admin/activity.ts` (email filter matches either person)
- Test: `packages/server/tests/audit-query.test.ts`, `packages/server/tests/activity-routes.test.ts`

- `listAuditEvents`: first predicate `(user_id = ? OR actor_user_id = ?)`. Comment: the OR cannot use one index for the ORDER BY; fine at Activity volumes; switch to UNION ALL of two keyset queries if it shows up in profiles.
- SELECT adds `user_id, user_email, actor_user_id, actor_email, client_name`; each row gets `delegation: null | { direction: "by_me" | "for_me"; other_email: string | null; space: string | null }` (`for_me`: `user_id = me` and actor set; `by_me`: `actor_user_id = me`; `space` from a `space:` prefix on `client_name`). Do not expose the other person's user id, only the email.
- `summarizeAudit` unchanged (calls on your own access); comment why.
- Admin rows add `actor_user_id`, `actor_email`; the email filter matches `user_email` or `actor_email`.

Tests: owner sees the row `for_me` with viewer email; viewer sees the same row `by_me` with owner email; a third user sees nothing; admin list shows one row with both emails; admin email filter by the viewer's email finds it.

Commit `feat(activity): delegated calls visible to both people`.

---

## Phase F: Review gate

### Task 13: UI prototype for review (no product code)

Per the project's prototype-first rule:
- Throwaway Vite preview page in the session scratchpad rendering the real portal components with mocked data: Admin Users permissions panel (Default, Allowed, revoke confirmation with count); Sharing modal (switch hidden, disabled on Only me, enabling with the full tool list warning, suspended state); Spaces list badge (Delegated, Delegated paused); viewer consent copy, bar label, destructive dialog, errors (turned off, tools changed, not delegable, owner not connected); Activity rows in both directions.
- Playwright screenshots, light and dark, sent to the user. **Stop and wait for approval.**

---

## Phase G: Portal (after prototype approval)

### Task 14: portal API types

`packages/portal/src/spaces-api.ts` (`SpaceDetail.delegate_access`, `delegation_suspended`, `delegation_off`, `can_delegate`, tool `delegable`; `updateSpaceSharing` body/response; codes `DELEGATION_NOT_ALLOWED`, `DELEGATION_OFF`, `TOOL_NOT_DELEGABLE`), `packages/portal/src/api.ts` (activity `delegation`; admin `getUserPermissions`, `setUserPermission`, `clearUserPermission`). Tests in the existing `*.test.ts`.

### Task 15: Admin Users permissions panel

`packages/portal/src/components/admin/UsersTab.tsx` (+ its test): per-user expandable Permissions panel from `GET /api/admin/users/:id/permissions`; Allow / Default; clearing confirms with `delegatedSpaces`.

### Task 16: Sharing modal switch

`packages/portal/src/spaces/SharingModal.tsx`, test **new** `packages/portal/src/spaces/SharingModal.test.tsx`: switch hidden when `!can_delegate`, disabled on Only me; enabling lists every declared tool with "Viewers can call these with your access, with any input" and a second confirmation; suspended state with Review and confirm.

### Task 17: viewer surfaces

`packages/portal/src/pages/SpaceShell.tsx` + `packages/portal/src/spaces/bridge.ts`: consent copy, bar label, destructive dialog naming the owner, error copy for `DELEGATION_OFF` (both reasons), `TOOL_NOT_DELEGABLE`, delegated `NOT_CONNECTED` (no connect button). `packages/portal/src/pages/Spaces.tsx`: badge. Tests in `bridge.test.ts` and page tests.

### Task 18: Activity page

`packages/portal/src/pages/Activity.tsx`: "Delegated" tag and direction copy. Test in `Activity.test.tsx`.

Commit per task.

---

## Phase H: Finish

### Task 19: docs, finding, verification

- Docs: `docs/site/_content/` Spaces page section "Delegated access" (what it lends, admin grant, portal-only enable, tool-list pin, audit, failure modes); admin page: Permissions.
- Finding: `docs/findings/2026-11-26-space-delegated-access.md` (generic permission store; co-owned audit row; no fallback; consent bound to mode; portal-only enable and tool-list pin against a prompt-injected owner agent; `delegable: false`; cookie auto-reconnect skipped; per-process owner bucket) + index line in `CLAUDE.md`.
- Release notes: Features entry; note that existing Space consents are asked once more after upgrade.
- Separate follow-up (not this PR): `migrate/plan.ts` also lacks the spaces tables; report it to the user.
- Run: full server and portal tests, both tsc configs, `node docs/site/build.mjs`, PostgreSQL integration suite if `TEST_DATABASE_URL` is set.
- Scrub: `git diff main... | grep -inE '<company>|@(icloud|gmail)\.com|<real-name>'`.
- Push branch, open PR only when the user asks.
