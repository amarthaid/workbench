# Admin Users + Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Users tab (list, disable and enable, revoke API key) and the Config tab (integration on/off, custom-app policy) to the Admin page, with a disabled account refused by every credential path and a disabled integration invisible to every lookup.

**Architecture:** Two small DDL changes (`users.disabled_at`, table `instance_settings`). "Disabled" is enforced inside the credential verifiers and the places that issue credentials, so a new call site cannot skip it. Instance settings live in an in-memory snapshot refreshed on write and by a short poll; the plugin `Registry` filters through an injected predicate, so one change hides an integration from search, schema, execute, REST, connect and the portal list. Admin endpoints reuse the sub-project 1 `adminScope`, which now also records who the acting admin is. Every admin write is audited.

**Tech Stack:** TypeScript, Fastify 5, SQLite/PostgreSQL via the `db` adapter, vitest, React + TanStack Query v5, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-01-admin-page-design.md` (sections 3 "A: users" and 4 "C: config"). Builds on `docs/superpowers/plans/2026-10-01-admin-gate-and-shell.md` and `2026-10-01-admin-overview.md`, both on `main`.

**Branch:** `feat/admin-users-config`, cut from `main` at `5c690bb`. One PR: the two features share one RC.

## Global Constraints

- Two DDL changes only: `ALTER TABLE users ADD COLUMN disabled_at INTEGER` (nullable timestamp, never BOOLEAN) and `CREATE TABLE IF NOT EXISTS instance_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER, updated_by TEXT)`. Both dialects, idempotent, same pattern as the existing `ALTER`s in `db.ts`.
- A user with **no row** is not "disabled". `isUserDisabled` is true only for a row whose `disabled_at` is set.
- Every `/api/admin/*` route is registered through `adminScope`. Admin writes are `POST`/`PUT` through the same gate.
- Bodyless `POST`s from the portal must send auth headers **without** `Content-Type` (`authHeaders()`), or Fastify answers 400 `FST_ERR_CTP_EMPTY_JSON_BODY` (2026-06-10 finding).
- PostgreSQL parity: `?` only as a placeholder; no row-value comparisons; booleans bound as real booleans; no `INSERT OR REPLACE`. Upserts use `ON CONFLICT(key) DO UPDATE SET ... = excluded....`.
- Settings changes may lag other workers or pods by up to `INSTANCE_SETTINGS_POLL_SECONDS` (default 5). Document it; never claim instant propagation.
- No secrets in any response or in `instance_settings`. OAuth client secrets stay in env.
- Every admin write goes to `audit_log` with the acting admin as `user_id`.
- Portal tests run through `npm run test` in `packages/portal`. In a test's `beforeEach`, never write `() => mock.mockReset()`: the arrow returns the mock and vitest runs it as a teardown call. Use a block body.
- Fixtures use synthetic values only: `admin@example.com`, `dev@example.com`, `acme`, fake secrets like `tok-abc`.
- No `Co-Authored-By` or "Generated with" trailer on any commit.

## Review Focus

- Every way a disabled user could still act: API key, portal session, OAuth access token, curl-session token, the OAuth `authorization_code` and `refresh_token` grants, both SSO callbacks. Re-enabling must restore the account.
- An admin disabling themselves, or another email on `ADMIN_EMAILS`, must change nothing (no `disabled_at`, no deleted tokens, no audit row).
- A corrupt or wrongly shaped `instance_settings` row must neither crash the server nor silently disable integrations.
- Custom-app policy: creation is refused before any network discovery; an excluded user's existing apps stop appearing as agent tools; an allowlist admits only the listed users.
- A disabled integration is gone from search results, schema lookup, execution, REST and the connect list, and comes back when re-enabled.

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/src/db.ts` (modify) | `disabled_at`, `instance_settings` |
| `packages/server/src/auth/user-status.ts` (create) | `isUserDisabled`, `setUserDisabled` |
| `packages/server/src/auth/{users,session,curl-session}.ts`, `auth/oauth-server/tokens.ts` (modify) | verifiers refuse disabled users |
| `packages/server/src/api/oauth-routes.ts`, `auth/{google,keycloak}.ts` (modify) | credential issuance refuses disabled users |
| `packages/server/src/api/admin-scope.ts` (modify) | `adminActor(request)` |
| `packages/server/src/admin/users.ts` (create) | list, disable, enable, revoke key |
| `packages/server/src/settings/instance-settings.ts` (create) | snapshot, load, save, poll |
| `packages/server/src/plugins/registry.ts` (modify) | disabled predicate, filtered getters |
| `packages/server/src/admin/config.ts` (create) | config view and writes |
| `packages/server/src/custom-apps/index.ts`, `api/routes.ts` (modify) | custom-app policy enforcement, `canCreateCustomApps` |
| `packages/server/src/{config,index}.ts` (modify) | poll knob, boot wiring |
| `packages/shared/src/types.ts` (modify) | admin audit actions |
| `packages/portal/src/...` (modify/create) | Users tab, Config tab, Apps gating |
| docs, finding, `CLAUDE.md` | docs |

---

### Task 1: Schema and the user-status helper

**Files:**
- Modify: `packages/server/src/db.ts`
- Create: `packages/server/src/auth/user-status.ts`
- Test: `packages/server/tests/user-status.test.ts`

**Interfaces:**
- Produces: `isUserDisabled(userId: string): Promise<boolean>`; `setUserDisabled(userId: string, disabled: boolean, nowSeconds?: number): Promise<boolean>` (true when the state changed); table `instance_settings`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/user-status.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db, initDb } from "../src/db";
import { isUserDisabled, setUserDisabled } from "../src/auth/user-status";

beforeEach(async () => {
  await db.exec("DELETE FROM users");
  await db.exec("DELETE FROM instance_settings");
});

describe("isUserDisabled / setUserDisabled", () => {
  it("is false for an active user, true once disabled, false again once enabled", async () => {
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "dev@example.com"]);
    expect(await isUserDisabled("u1")).toBe(false);
    expect(await setUserDisabled("u1", true)).toBe(true);
    expect(await isUserDisabled("u1")).toBe(true);
    expect(await setUserDisabled("u1", false)).toBe(true);
    expect(await isUserDisabled("u1")).toBe(false);
  });

  it("reports whether the state changed, so repeating an action is a no-op", async () => {
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "dev@example.com"]);
    expect(await setUserDisabled("u1", false)).toBe(false); // already enabled
    expect(await setUserDisabled("u1", true, 1000)).toBe(true);
    expect(await setUserDisabled("u1", true, 2000)).toBe(false); // already disabled
    const row = await db.get<{ disabled_at: number }>("SELECT disabled_at FROM users WHERE id = ?", ["u1"]);
    expect(Number(row?.disabled_at)).toBe(1000); // the first timestamp is kept
  });

  it("does not treat a user with no row as disabled", async () => {
    expect(await isUserDisabled("never-seen")).toBe(false);
    expect(await setUserDisabled("never-seen", true)).toBe(false);
  });
});

describe("schema", () => {
  it("is idempotent: running initDb again changes nothing and does not throw", async () => {
    await initDb();
    await initDb();
    await db.run("INSERT INTO users (id, email, disabled_at) VALUES (?, ?, ?)", ["u2", "off@example.com", 5]);
    expect(await isUserDisabled("u2")).toBe(true);
  });

  it("has an instance_settings table that accepts and returns a row", async () => {
    await db.run(
      "INSERT INTO instance_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
      ["disabled_integrations", "[]", 1, "u1"]
    );
    const row = await db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", [
      "disabled_integrations",
    ]);
    expect(row?.value).toBe("[]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/user-status.test.ts`
Expected: FAIL (`../src/auth/user-status` not found).

- [ ] **Step 3: Implement the DDL**

In `packages/server/src/db.ts`:

(a) At the end of `SQLITE_SCHEMA`, replace the text `  );\n` + `` `; `` + a blank line + `const POSTGRES_SCHEMA = ` + backtick (that is, the closing of the `custom_apps` table, the closing backtick of the SQLite schema string, then the start of the PostgreSQL one) with the same text plus a new table. Concretely, change

```
  );
`;

const POSTGRES_SCHEMA = `
```

to

```
  );

  CREATE TABLE IF NOT EXISTS instance_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER,
    updated_by TEXT
  );
`;

const POSTGRES_SCHEMA = `
```

(b) At the end of `POSTGRES_SCHEMA`, change

```
  );
`;

async function initSqliteSchema(db: DbAdapter): Promise<void> {
```

to

```
  );

  CREATE TABLE IF NOT EXISTS instance_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER,
    updated_by TEXT
  );
`;

async function initSqliteSchema(db: DbAdapter): Promise<void> {
```

(c) In `initSqliteSchema`, add `"ALTER TABLE users ADD COLUMN disabled_at INTEGER",` to the list of `ALTER` statements (after the `pending_auth ... nonce` entry). In `initPostgresSchema`, add `ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at INTEGER;` after the `pending_auth ... nonce` line.

- [ ] **Step 4: Implement the helper**

Create `packages/server/src/auth/user-status.ts`:

```ts
import { db } from "../db";

/**
 * Whether the user's account is disabled. A user with no row at all is NOT
 * treated as disabled: that keeps tokens signed for ids this table has never
 * seen behaving as they did before accounts could be disabled.
 */
export async function isUserDisabled(userId: string): Promise<boolean> {
  const row = await db.get<{ disabled_at: number | string | null }>(
    "SELECT disabled_at FROM users WHERE id = ?",
    [userId]
  );
  return row?.disabled_at !== null && row?.disabled_at !== undefined;
}

/**
 * Disable or enable a user. Returns true only when the state changed, so a
 * repeated call is a no-op and the original disable time is kept.
 */
export async function setUserDisabled(
  userId: string,
  disabled: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const { changes } = disabled
    ? await db.run("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL", [nowSeconds, userId])
    : await db.run("UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL", [userId]);
  return changes > 0;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/user-status.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/auth/user-status.ts packages/server/tests/user-status.test.ts
git commit -m "feat(admin): users.disabled_at and instance_settings schema"
```

---

### Task 2: Credential verifiers refuse a disabled user

**Files:**
- Modify: `packages/server/src/auth/users.ts`, `packages/server/src/auth/session.ts`, `packages/server/src/auth/oauth-server/tokens.ts`, `packages/server/src/auth/curl-session.ts`
- Test: `packages/server/tests/user-disabled.test.ts`

**Interfaces:**
- Consumes: `isUserDisabled`, `setUserDisabled` (Task 1).
- Produces: `verifyApiKey` returns `null`, and `verifySession`, `verifyAccessToken`, `verifyCurlToken` throw `Error("User disabled")`, for a disabled user. Enabling the user restores all four.

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/user-disabled.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { createUser, verifyApiKey } from "../src/auth/users";
import { signSession, verifySession } from "../src/auth/session";
import { signAccessToken, verifyAccessToken } from "../src/auth/oauth-server/tokens";
import { signCurlToken, verifyCurlToken } from "../src/auth/curl-session";
import { resolveMcpUser } from "../src/auth/oauth-server/resolve";
import { setUserDisabled } from "../src/auth/user-status";

beforeEach(async () => {
  await db.exec("DELETE FROM users");
});

async function seed(id: string): Promise<string> {
  const { apiKey } = await createUser(id);
  return apiKey;
}

describe("a disabled user is refused by every credential verifier", () => {
  it("API key: null while disabled, valid again once enabled", async () => {
    const key = await seed("u-key");
    expect(await verifyApiKey(key)).toBe("u-key");
    await setUserDisabled("u-key", true);
    expect(await verifyApiKey(key)).toBeNull();
    await setUserDisabled("u-key", false);
    expect(await verifyApiKey(key)).toBe("u-key");
  });

  it("portal session JWT", async () => {
    await seed("u-sess");
    const token = await signSession({ userId: "u-sess", email: "dev@example.com" });
    expect((await verifySession(token)).userId).toBe("u-sess");
    await setUserDisabled("u-sess", true);
    await expect(verifySession(token)).rejects.toThrow("User disabled");
    await setUserDisabled("u-sess", false);
    expect((await verifySession(token)).userId).toBe("u-sess");
  });

  it("OAuth access token", async () => {
    await seed("u-oauth");
    const token = await signAccessToken({ userId: "u-oauth", scope: "mcp", clientId: "c1" });
    expect((await verifyAccessToken(token)).userId).toBe("u-oauth");
    await setUserDisabled("u-oauth", true);
    await expect(verifyAccessToken(token)).rejects.toThrow("User disabled");
  });

  it("curl session token", async () => {
    await seed("u-curl");
    const token = await signCurlToken("u-curl", ["acme"]);
    expect((await verifyCurlToken(token)).userId).toBe("u-curl");
    await setUserDisabled("u-curl", true);
    await expect(verifyCurlToken(token)).rejects.toThrow("User disabled");
  });

  it("/mcp resolution: API key, OAuth bearer and session bearer are all refused", async () => {
    const key = await seed("u-mcp");
    const oauth = await signAccessToken({ userId: "u-mcp", scope: "mcp", clientId: "c1" });
    const session = await signSession({ userId: "u-mcp", email: "dev@example.com" });
    expect(await resolveMcpUser({ "x-workbench-api-key": key })).toBe("u-mcp");
    expect(await resolveMcpUser({ authorization: `Bearer ${oauth}` })).toBe("u-mcp");
    expect(await resolveMcpUser({ authorization: `Bearer ${session}` })).toBe("u-mcp");
    await setUserDisabled("u-mcp", true);
    expect(await resolveMcpUser({ "x-workbench-api-key": key })).toBeNull();
    expect(await resolveMcpUser({ authorization: `Bearer ${oauth}` })).toBeNull();
    expect(await resolveMcpUser({ authorization: `Bearer ${session}` })).toBeNull();
  });

  it("a user with no row is not treated as disabled", async () => {
    const token = await signSession({ userId: "never-seen", email: "dev@example.com" });
    expect((await verifySession(token)).userId).toBe("never-seen");
  });

  it("disabling one user does not affect another", async () => {
    const keyA = await seed("u-a");
    const keyB = await seed("u-b");
    await setUserDisabled("u-a", true);
    expect(await verifyApiKey(keyA)).toBeNull();
    expect(await verifyApiKey(keyB)).toBe("u-b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/user-disabled.test.ts`
Expected: FAIL (the disabled user's credentials still verify).

- [ ] **Step 3: Implement**

`packages/server/src/auth/users.ts`: add `import { isUserDisabled } from "./user-status";` after the `encryption` import. Rename the existing function: change the line `export async function verifyApiKey(apiKey: string): Promise<string | null> {` to `async function findApiKeyOwner(apiKey: string): Promise<string | null> {` (keep its body and the comment above it). Then, directly above `export async function getUserById(`, insert:

```ts
export async function verifyApiKey(apiKey: string): Promise<string | null> {
  const id = await findApiKeyOwner(apiKey);
  // A disabled account's key stops working at once. The key stays on the row,
  // so enabling the user restores it.
  if (id && (await isUserDisabled(id))) return null;
  return id;
}

```

`packages/server/src/auth/session.ts`: add `import { isUserDisabled } from "./user-status";` and change the end of `verifySession` from

```ts
  return { userId: payload.sub, email: payload.email };
```

to

```ts
  // Checked here, not at each call site: every portal-session consumer
  // (authenticate, /mcp, the CDP bridge, vault, OAuth) goes through this function.
  if (await isUserDisabled(payload.sub)) throw new Error("User disabled");
  return { userId: payload.sub, email: payload.email };
```

`packages/server/src/auth/oauth-server/tokens.ts`: add `import { isUserDisabled } from "../user-status";` and change the end of `verifyAccessToken` from

```ts
  return { userId: payload.sub, scope: payload.scope, clientId: payload.client_id };
```

to

```ts
  if (await isUserDisabled(payload.sub)) throw new Error("User disabled");
  return { userId: payload.sub, scope: payload.scope, clientId: payload.client_id };
```

`packages/server/src/auth/curl-session.ts`: add `import { isUserDisabled } from "./user-status";` and change the end of `verifyCurlToken` from

```ts
  return { userId: payload.sub, integrations: payload.ints as string[] };
```

to

```ts
  if (await isUserDisabled(payload.sub)) throw new Error("User disabled");
  return { userId: payload.sub, integrations: payload.ints as string[] };
```

- [ ] **Step 4: Run test to verify it passes, then the whole server suite**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/user-disabled.test.ts && NODE_ENV=test npx vitest run`
Expected: PASS. If an existing suite breaks because it mocks `../src/db` or `../src/config` without a database path and now loads the real verifier, give that suite the same `DATABASE_URL: process.env.DATABASE_URL` in its config mock (the pattern the other suites use) rather than changing the verifier.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth packages/server/tests/user-disabled.test.ts
git commit -m "feat(admin): credential verifiers refuse a disabled user"
```

---

### Task 3: Credential issuance refuses a disabled user

**Files:**
- Modify: `packages/server/src/api/oauth-routes.ts`, `packages/server/src/auth/google.ts`, `packages/server/src/auth/keycloak.ts`
- Test: `packages/server/tests/oauth-token.test.ts`, `packages/server/tests/google.test.ts`, `packages/server/tests/keycloak-sso.test.ts` (extend)

**Interfaces:**
- Consumes: `isUserDisabled` (Task 1).
- Produces: `POST /token` answers `400 {error: "invalid_grant"}` for both grants when the user is disabled; Google and Keycloak `handleCallback` throw `Error("Account disabled")`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/tests/oauth-token.test.ts`:

```ts
describe("POST /token for a disabled user", () => {
  beforeEach(async () => {
    await db.exec("DELETE FROM users");
  });

  async function codeFor(userId: string) {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1/cb"] });
    const code = await issueCode({
      clientId: c.client_id, userId, redirectUri: "http://127.0.0.1/cb",
      codeChallenge: crypto.createHash("sha256").update("v").digest("base64url"),
      scope: "mcp", resource: "http://x/mcp",
    });
    return { c, code };
  }

  function form(o: Record<string, string>) {
    return {
      payload: new URLSearchParams(o).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    };
  }

  it("refuses the authorization_code grant", async () => {
    await db.run("INSERT INTO users (id, email, disabled_at) VALUES (?, ?, ?)", ["u-off", "off@example.com", 1700000000]);
    const { c, code } = await codeFor("u-off");
    const a = await app();
    const res = await a.inject({
      method: "POST", url: "/token",
      ...form({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "http://127.0.0.1/cb", code_verifier: "v" }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_grant" });
  });

  it("refuses the refresh_token grant once the user is disabled, and does not mint a new token", async () => {
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u-on", "on@example.com"]);
    const { c, code } = await codeFor("u-on");
    const a = await app();
    const first = JSON.parse((await a.inject({
      method: "POST", url: "/token",
      ...form({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "http://127.0.0.1/cb", code_verifier: "v" }),
    })).body);
    expect(first.refresh_token).toBeTruthy();

    await db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [1700000000, "u-on"]);
    const res = await a.inject({
      method: "POST", url: "/token",
      ...form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_grant" });
  });
});
```

In `packages/server/tests/google.test.ts`, insert before the line `  it("creates new user on first login", async () => {` (inside `describe("handleCallback")`):

```ts
  it("refuses a disabled user, even when linking by email", async () => {
    await db.run("INSERT INTO users (id, email, google_sub, disabled_at) VALUES (?, ?, ?, ?)", [
      "user-off",
      "off@example.com",
      null,
      1700000000,
    ]);
    const { state, nonce } = await getStateAndNonce();

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: "google-off", email: "off@example.com", email_verified: true, nonce },
    } as any);
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id_token: "id-123", access_token: "acc-456", expires_in: 3600 }))
    );

    await expect(handleCallback("code", state)).rejects.toThrow("Account disabled");
  });

```

In `packages/server/tests/keycloak-sso.test.ts`, insert before `  it("creates new user on first login", async () => {` (inside `describe("handleCallback")`):

```ts
  it("refuses a disabled user, even when linking by email", async () => {
    await db.run("INSERT INTO users (id, email, keycloak_sub, disabled_at) VALUES (?, ?, ?, ?)", [
      "user-off",
      "off@example.com",
      null,
      1700000000,
    ]);
    const { state, nonce } = await getStateAndNonce();

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: "kc-off", email: "off@example.com", email_verified: true, nonce },
    } as any);
    mockFetchRouting({ id_token: "id-123", access_token: "acc-456", expires_in: 3600 });

    await expect(handleCallback("code", state)).rejects.toThrow("Account disabled");
  });

```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/oauth-token.test.ts tests/google.test.ts tests/keycloak-sso.test.ts`
Expected: FAIL (the disabled user is issued tokens and a login).

- [ ] **Step 3: Implement**

`packages/server/src/api/oauth-routes.ts`: add `import { isUserDisabled } from "../auth/user-status";`. In the `authorization_code` branch, directly after `if (!consumed) return reply.status(400).send({ error: "invalid_grant" });` add:

```ts
      if (await isUserDisabled(consumed.userId)) return reply.status(400).send({ error: "invalid_grant" });
```

In the `refresh_token` branch, directly after `if (!rot) return reply.status(400).send({ error: "invalid_grant" });` add:

```ts
      if (await isUserDisabled(rot.userId)) return reply.status(400).send({ error: "invalid_grant" });
```

`packages/server/src/auth/google.ts` and `packages/server/src/auth/keycloak.ts`: add `import { isUserDisabled } from "./user-status";` and, in `handleCallback`, immediately before the final `return { userId: user.id, email: user.email };`, add:

```ts
  // After account linking, so a disabled account cannot be re-entered by email.
  if (await isUserDisabled(user.id)) throw new Error("Account disabled");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/oauth-token.test.ts tests/google.test.ts tests/keycloak-sso.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/tests
git commit -m "feat(admin): token endpoint and SSO callbacks refuse a disabled user"
```

---

### Task 4: Admin users endpoints

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/server/src/api/admin-scope.ts`, `packages/server/src/api/admin-routes.ts`
- Create: `packages/server/src/admin/users.ts`, `packages/server/tests/admin-users.test.ts`

**Interfaces:**
- Consumes: `isAdminEmail`, `setUserDisabled`, `clearApiKey` (existing), `auditLogger`.
- Produces:
  ```ts
  // api/admin-scope.ts
  export interface AdminActor { userId: string; email: string }
  export function adminActor(request: object): AdminActor;
  // admin/users.ts
  export interface AdminUserRow { id: string; email: string | null; created_at: number; disabled_at: number | null; has_api_key: boolean; connection_count: number; custom_app_count: number; last_activity: number | null }
  export type UserActionResult = { ok: true } | { ok: false; status: 400 | 404; error: "user_not_found" | "cannot_disable_self" | "cannot_disable_admin" };
  export function listUsers(limit?: number): Promise<{ users: AdminUserRow[]; total: number }>;
  export function disableUser(actor: AdminActor, id: string): Promise<UserActionResult>;
  export function enableUser(actor: AdminActor, id: string): Promise<UserActionResult>;
  export function revokeUserKey(actor: AdminActor, id: string): Promise<UserActionResult>;
  ```
  Routes: `GET /api/admin/users`; `POST /api/admin/users/:id/disable`, `/enable`, `/revoke-key`, each answering `{ok: true}` or `{error}` with the result's status.

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/admin-users.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    ADMIN_EMAILS: ["admin@example.com"],
    AUDIT_LOG_DEST: "sqlite",
    CLUSTER_ENABLED: false,
  },
}));

vi.mock("../src/auth/session", () => ({
  verifySession: vi.fn((token: string) => {
    if (token === "admin-jwt") return { userId: "user-admin", email: "admin@example.com" };
    if (token === "dev-jwt") return { userId: "user-dev", email: "dev@example.com" };
    throw new Error("Invalid token");
  }),
}));

// Keep the real clearApiKey; stub only what the gate resolves identity with.
vi.mock("../src/auth/users", async (orig) => ({
  ...(await orig<typeof import("../src/auth/users")>()),
  verifyApiKey: vi.fn(async () => null),
  getUserById: vi.fn(async (id: string) => {
    if (id === "user-admin") return { id, email: "admin@example.com" };
    if (id === "user-dev") return { id, email: "dev@example.com" };
    return null;
  }),
}));

import { registerAdminRoutes } from "../src/api/admin-routes";
import { db } from "../src/db";

const ADMIN = { authorization: "Bearer admin-jwt" };
const DEV = { authorization: "Bearer dev-jwt" };
const NOW = Math.floor(Date.now() / 1000);

async function call(method: "GET" | "POST", url: string, headers: Record<string, string> = ADMIN) {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app.inject({ method, url, headers });
}

async function seedUser(o: {
  id: string;
  email: string | null;
  apiKeyHash?: string | null;
  createdAt?: number;
  disabledAt?: number | null;
}) {
  await db.run(
    "INSERT INTO users (id, email, api_key_hash, created_at, disabled_at) VALUES (?, ?, ?, ?, ?)",
    [o.id, o.email, o.apiKeyHash ?? null, o.createdAt ?? NOW, o.disabledAt ?? null]
  );
}

async function userRow(id: string) {
  return db.get<{ disabled_at: number | null; api_key_hash: string | null }>(
    "SELECT disabled_at, api_key_hash FROM users WHERE id = ?",
    [id]
  );
}

async function auditActions() {
  const rows = await db.all<{ user_id: string; action: string; tool: string }>(
    "SELECT user_id, action, tool FROM audit_log ORDER BY id"
  );
  return rows;
}

beforeEach(async () => {
  for (const t of ["audit_log", "connections", "custom_apps", "oauth_refresh_tokens", "users"]) {
    await db.exec(`DELETE FROM ${t}`);
  }
  await seedUser({ id: "user-admin", email: "admin@example.com" });
});

const ACTIONS = [
  ["POST", "/api/admin/users/x/disable"],
  ["POST", "/api/admin/users/x/enable"],
  ["POST", "/api/admin/users/x/revoke-key"],
  ["GET", "/api/admin/users"],
] as const;

describe.each(ACTIONS)("%s %s gate", (method, url) => {
  it("401 without a session", async () => {
    expect((await call(method, url, {})).statusCode).toBe(401);
  });
  it("403 for a signed-in non-admin", async () => {
    expect((await call(method, url, DEV)).statusCode).toBe(403);
  });
});

describe("GET /api/admin/users", () => {
  it("lists users newest first with counts, last activity and disabled state, and no secrets", async () => {
    await seedUser({ id: "user-a", email: "a@example.com", apiKeyHash: "hash-secret-1", createdAt: NOW - 200 });
    await seedUser({ id: "user-b", email: "b@example.com", createdAt: NOW - 100, disabledAt: NOW - 50 });
    await db.run("INSERT INTO connections (user_id, integration, access_token) VALUES (?, ?, ?)", ["user-a", "jira", Buffer.from("tok-abc")]);
    await db.run("INSERT INTO connections (user_id, integration, access_token) VALUES (?, ?, ?)", ["user-a", "slack", Buffer.from("tok-abc")]);
    await db.run(
      "INSERT INTO custom_apps (id, user_id, name, base_url, metadata, created_at) VALUES (?, ?, ?, ?, '{}', ?)",
      ["app-1", "user-a", "wiki", "https://mcp.example.com/w", NOW]
    );
    await db.run(
      "INSERT INTO audit_log (user_id, integration, tool, action, success, created_at) VALUES (?, ?, ?, 'EXECUTE', ?, ?)",
      ["user-a", "acme", "acme_search", true, NOW - 5]
    );

    const res = await call("GET", "/api/admin/users");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const byId = Object.fromEntries(body.users.map((u: { id: string }) => [u.id, u]));
    expect(body.users.map((u: { id: string }) => u.id)).toEqual(["user-admin", "user-b", "user-a"]);
    expect(body.total).toBe(3);
    expect(byId["user-a"]).toEqual({
      id: "user-a",
      email: "a@example.com",
      created_at: NOW - 200,
      disabled_at: null,
      has_api_key: true,
      connection_count: 2,
      custom_app_count: 1,
      last_activity: NOW - 5,
    });
    expect(byId["user-b"]).toMatchObject({ has_api_key: false, disabled_at: NOW - 50, last_activity: null });
    expect(res.body).not.toContain("hash-secret-1");
    expect(res.body).not.toContain("tok-abc");
  });
});

describe("POST /api/admin/users/:id/disable", () => {
  it("disables the user, deletes only that user's refresh tokens, and audits it", async () => {
    await seedUser({ id: "user-t", email: "t@example.com" });
    await seedUser({ id: "user-o", email: "o@example.com" });
    for (const [hash, uid] of [["h1", "user-t"], ["h2", "user-t"], ["h3", "user-o"]]) {
      await db.run(
        "INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)",
        [hash, "c1", uid, "mcp", NOW + 3600]
      );
    }
    const res = await call("POST", "/api/admin/users/user-t/disable");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect((await userRow("user-t"))?.disabled_at).not.toBeNull();
    expect((await userRow("user-o"))?.disabled_at).toBeNull();
    const left = await db.all<{ user_id: string }>("SELECT user_id FROM oauth_refresh_tokens");
    expect(left.map((r) => r.user_id)).toEqual(["user-o"]);
    const audit = await auditActions();
    expect(audit).toEqual([
      { user_id: "user-admin", action: "ADMIN_USER_DISABLE", tool: "admin.user.disable → t@example.com" },
    ]);
  });

  it("is idempotent: disabling again keeps the original time", async () => {
    await seedUser({ id: "user-t", email: "t@example.com", disabledAt: 1234 });
    expect((await call("POST", "/api/admin/users/user-t/disable")).statusCode).toBe(200);
    expect(Number((await userRow("user-t"))?.disabled_at)).toBe(1234);
  });

  it("refuses to disable yourself and changes nothing", async () => {
    await db.run(
      "INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)",
      ["h1", "c1", "user-admin", "mcp", NOW + 3600]
    );
    const res = await call("POST", "/api/admin/users/user-admin/disable");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "cannot_disable_self" });
    expect((await userRow("user-admin"))?.disabled_at).toBeNull();
    expect(await db.all("SELECT 1 FROM oauth_refresh_tokens")).toHaveLength(1);
    expect(await auditActions()).toEqual([]);
  });

  it("refuses to disable another email on ADMIN_EMAILS, matching case-insensitively", async () => {
    await seedUser({ id: "user-other-admin", email: "Admin@Example.com" });
    const res = await call("POST", "/api/admin/users/user-other-admin/disable");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "cannot_disable_admin" });
    expect((await userRow("user-other-admin"))?.disabled_at).toBeNull();
    expect(await auditActions()).toEqual([]);
  });

  it("404 for an unknown user", async () => {
    const res = await call("POST", "/api/admin/users/nope/disable");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "user_not_found" });
  });
});

describe("POST /api/admin/users/:id/enable", () => {
  it("enables the user and audits it", async () => {
    await seedUser({ id: "user-t", email: "t@example.com", disabledAt: NOW - 10 });
    const res = await call("POST", "/api/admin/users/user-t/enable");
    expect(res.statusCode).toBe(200);
    expect((await userRow("user-t"))?.disabled_at).toBeNull();
    expect(await auditActions()).toEqual([
      { user_id: "user-admin", action: "ADMIN_USER_ENABLE", tool: "admin.user.enable → t@example.com" },
    ]);
  });

  it("404 for an unknown user", async () => {
    expect((await call("POST", "/api/admin/users/nope/enable")).statusCode).toBe(404);
  });
});

describe("POST /api/admin/users/:id/revoke-key", () => {
  it("clears that user's API key only, and audits it", async () => {
    await seedUser({ id: "user-t", email: "t@example.com", apiKeyHash: "hash-1" });
    await seedUser({ id: "user-o", email: "o@example.com", apiKeyHash: "hash-2" });
    const res = await call("POST", "/api/admin/users/user-t/revoke-key");
    expect(res.statusCode).toBe(200);
    expect((await userRow("user-t"))?.api_key_hash).toBeNull();
    expect((await userRow("user-o"))?.api_key_hash).toBe("hash-2");
    expect(await auditActions()).toEqual([
      { user_id: "user-admin", action: "ADMIN_KEY_REVOKE", tool: "admin.user.revoke-key → t@example.com" },
    ]);
  });

  it("404 for an unknown user", async () => {
    expect((await call("POST", "/api/admin/users/nope/revoke-key")).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-users.test.ts`
Expected: FAIL (routes 404).

- [ ] **Step 3: Implement**

`packages/shared/src/types.ts`: change the `action` line of `AuditEvent` to

```ts
  action:
    | "EXECUTE"
    | "CONNECT"
    | "DISCONNECT"
    | "REFRESH"
    | "ADMIN_USER_DISABLE"
    | "ADMIN_USER_ENABLE"
    | "ADMIN_KEY_REVOKE"
    | "ADMIN_INTEGRATION_SET"
    | "ADMIN_CUSTOM_APPS_POLICY";
```

`packages/server/src/api/admin-scope.ts`: add above `adminScope`:

```ts
export interface AdminActor {
  userId: string;
  email: string;
}

// Who the gate let in, keyed by the request. A handler needs the actor to
// refuse "disable yourself" and to attribute its audit row.
const actors = new WeakMap<object, AdminActor>();

export function adminActor(request: object): AdminActor {
  const actor = actors.get(request);
  if (!actor) throw new Error("adminActor called outside the admin scope");
  return actor;
}
```

and inside the `preHandler`, after the `if (!admin.ok) { ... }` block, add:

```ts
        actors.set(request, { userId: admin.userId, email: admin.email });
```

Create `packages/server/src/admin/users.ts`:

```ts
import { db } from "../db";
import { auditLogger } from "../audit/logger";
import { isAdminEmail } from "../auth/admin";
import { clearApiKey } from "../auth/users";
import { setUserDisabled } from "../auth/user-status";
import type { AdminActor } from "../api/admin-scope";

export interface AdminUserRow {
  id: string;
  email: string | null;
  created_at: number;
  disabled_at: number | null;
  has_api_key: boolean;
  connection_count: number;
  custom_app_count: number;
  last_activity: number | null;
}

export type UserActionResult =
  | { ok: true }
  | { ok: false; status: 400 | 404; error: "user_not_found" | "cannot_disable_self" | "cannot_disable_admin" };

// Explicit columns, never SELECT *: api_key_hash, api_key_sha and api_key_enc
// live on this table and must not reach a response.
export async function listUsers(limit = 500): Promise<{ users: AdminUserRow[]; total: number }> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT u.id, u.email, u.created_at, u.disabled_at,
            CASE WHEN u.api_key_hash IS NOT NULL THEN 1 ELSE 0 END AS has_api_key,
            (SELECT COUNT(*) FROM connections c WHERE c.user_id = u.id) AS connection_count,
            (SELECT COUNT(*) FROM custom_apps a WHERE a.user_id = u.id) AS custom_app_count,
            (SELECT MAX(l.created_at) FROM audit_log l WHERE l.user_id = u.id) AS last_activity
       FROM users u
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ?`,
    [limit]
  );
  const count = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM users");
  const orNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    users: rows.map((r) => ({
      id: String(r.id),
      email: (r.email as string | null) ?? null,
      created_at: Number(r.created_at),
      disabled_at: orNull(r.disabled_at),
      has_api_key: Number(r.has_api_key) === 1,
      connection_count: Number(r.connection_count),
      custom_app_count: Number(r.custom_app_count),
      last_activity: orNull(r.last_activity),
    })),
    total: Number(count?.n ?? 0),
  };
}

type Target = { id: string; email: string | null };

async function findUser(id: string): Promise<Target | undefined> {
  return db.get<Target>("SELECT id, email FROM users WHERE id = ?", [id]);
}

async function audit(
  actor: AdminActor,
  action: "ADMIN_USER_DISABLE" | "ADMIN_USER_ENABLE" | "ADMIN_KEY_REVOKE",
  verb: string,
  target: Target
): Promise<void> {
  await auditLogger.log({
    user_id: actor.userId,
    action,
    tool: `admin.user.${verb} → ${target.email ?? target.id}`,
    success: true,
  });
}

const NOT_FOUND: UserActionResult = { ok: false, status: 404, error: "user_not_found" };

export async function disableUser(actor: AdminActor, id: string): Promise<UserActionResult> {
  const target = await findUser(id);
  if (!target) return NOT_FOUND;
  // You cannot lock yourself out, and admins are managed by ADMIN_EMAILS, not here.
  if (target.id === actor.userId) return { ok: false, status: 400, error: "cannot_disable_self" };
  if (isAdminEmail(target.email)) return { ok: false, status: 400, error: "cannot_disable_admin" };

  await setUserDisabled(target.id, true);
  // A refresh token the user already holds must not mint fresh access tokens.
  await db.run("DELETE FROM oauth_refresh_tokens WHERE user_id = ?", [target.id]);
  await audit(actor, "ADMIN_USER_DISABLE", "disable", target);
  return { ok: true };
}

export async function enableUser(actor: AdminActor, id: string): Promise<UserActionResult> {
  const target = await findUser(id);
  if (!target) return NOT_FOUND;
  await setUserDisabled(target.id, false);
  await audit(actor, "ADMIN_USER_ENABLE", "enable", target);
  return { ok: true };
}

export async function revokeUserKey(actor: AdminActor, id: string): Promise<UserActionResult> {
  const target = await findUser(id);
  if (!target) return NOT_FOUND;
  await clearApiKey(target.id);
  await audit(actor, "ADMIN_KEY_REVOKE", "revoke-key", target);
  return { ok: true };
}
```

`packages/server/src/api/admin-routes.ts`: add imports `import { adminScope, adminActor } from "./admin-scope";` (replacing the existing `adminScope` import) and `import { listUsers, disableUser, enableUser, revokeUserKey } from "../admin/users";`, and inside the scope callback add:

```ts
    scope.get("/users", async () => listUsers());
    for (const [path, act] of [
      ["disable", disableUser],
      ["enable", enableUser],
      ["revoke-key", revokeUserKey],
    ] as const) {
      scope.post<{ Params: { id: string } }>(`/users/:id/${path}`, async (request, reply) => {
        const result = await act(adminActor(request), request.params.id);
        if (!result.ok) return reply.status(result.status).send({ error: result.error });
        return { ok: true };
      });
    }
```

- [ ] **Step 4: Run tests, then build**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-users.test.ts tests/admin-routes.test.ts tests/admin-overview.test.ts`
Expected: PASS.

Run: `npm run build`
Expected: success (the shared `AuditEvent` change must compile through the server).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/server/src packages/server/tests/admin-users.test.ts
git commit -m "feat(admin): users list, disable, enable and revoke-key endpoints"
```

---

### Task 5: Instance settings store

**Files:**
- Modify: `packages/server/src/config.ts`
- Create: `packages/server/src/settings/instance-settings.ts`, `packages/server/tests/instance-settings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CustomAppsMode = "all" | "none" | "allowlist";
  export interface CustomAppsPolicy { mode: CustomAppsMode; user_ids: string[] }
  export interface InstanceSettings { disabled_integrations: string[]; custom_apps_policy: CustomAppsPolicy }
  export function getSettings(): InstanceSettings;
  export function isIntegrationDisabled(name: string): boolean;
  export function customAppsAllowedFor(userId: string): boolean;
  export function loadSettings(): Promise<void>;
  export function saveSetting(key: "disabled_integrations" | "custom_apps_policy", value: unknown, updatedBy: string): Promise<void>;
  export function startSettingsPoll(): void;
  export function stopSettingsPoll(): void;
  export function resetSettingsForTest(): void;
  ```
  Config: `INSTANCE_SETTINGS_POLL_SECONDS` (positive integer, default 5).

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/instance-settings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "../src/db";
import { config } from "../src/config";
import {
  customAppsAllowedFor,
  getSettings,
  isIntegrationDisabled,
  loadSettings,
  resetSettingsForTest,
  saveSetting,
  startSettingsPoll,
  stopSettingsPoll,
} from "../src/settings/instance-settings";

beforeEach(async () => {
  await db.exec("DELETE FROM instance_settings");
  resetSettingsForTest();
});

afterEach(() => {
  stopSettingsPoll();
  vi.useRealTimers();
});

describe("instance settings", () => {
  it("defaults to nothing disabled and custom apps open to everyone", async () => {
    await loadSettings();
    expect(getSettings()).toEqual({
      disabled_integrations: [],
      custom_apps_policy: { mode: "all", user_ids: [] },
    });
    expect(isIntegrationDisabled("acme")).toBe(false);
    expect(customAppsAllowedFor("u1")).toBe(true);
  });

  it("saves a setting and makes it visible immediately in this process", async () => {
    await saveSetting("disabled_integrations", ["acme"], "u-admin");
    expect(isIntegrationDisabled("acme")).toBe(true);
    expect(isIntegrationDisabled("demo-repo")).toBe(false);
  });

  it("upserts: saving the same key twice keeps one row and the latest actor", async () => {
    await saveSetting("disabled_integrations", ["acme"], "u-one");
    await saveSetting("disabled_integrations", ["acme", "demo-repo"], "u-two");
    const rows = await db.all<{ key: string; value: string; updated_by: string }>(
      "SELECT key, value, updated_by FROM instance_settings"
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value)).toEqual(["acme", "demo-repo"]);
    expect(rows[0].updated_by).toBe("u-two");
  });

  it("applies each custom-app policy mode", async () => {
    await saveSetting("custom_apps_policy", { mode: "none", user_ids: [] }, "u-admin");
    expect(customAppsAllowedFor("u1")).toBe(false);
    await saveSetting("custom_apps_policy", { mode: "allowlist", user_ids: ["u1"] }, "u-admin");
    expect(customAppsAllowedFor("u1")).toBe(true);
    expect(customAppsAllowedFor("u2")).toBe(false);
    await saveSetting("custom_apps_policy", { mode: "all", user_ids: [] }, "u-admin");
    expect(customAppsAllowedFor("u2")).toBe(true);
  });

  it("a corrupt stored value falls back to the default instead of throwing or disabling anything", async () => {
    for (const [key, value] of [
      ["disabled_integrations", "not json"],
      ["custom_apps_policy", "{also not json"],
    ]) {
      await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [key, value]);
    }
    await loadSettings();
    expect(getSettings().disabled_integrations).toEqual([]);
    expect(getSettings().custom_apps_policy).toEqual({ mode: "all", user_ids: [] });
  });

  it("a wrongly shaped stored value falls back to the default", async () => {
    await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", ["disabled_integrations", '{"a":1}']);
    await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [
      "custom_apps_policy",
      JSON.stringify({ mode: "everyone", user_ids: "u1" }),
    ]);
    await loadSettings();
    expect(getSettings().disabled_integrations).toEqual([]);
    expect(getSettings().custom_apps_policy).toEqual({ mode: "all", user_ids: [] });
  });

  it("drops non-string entries from a stored list", async () => {
    await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [
      "disabled_integrations",
      JSON.stringify(["acme", 7, null, "demo-repo"]),
    ]);
    await loadSettings();
    expect(getSettings().disabled_integrations).toEqual(["acme", "demo-repo"]);
  });
});

describe("settings poll", () => {
  it("picks up a change written by another process after the poll interval", async () => {
    vi.useFakeTimers();
    startSettingsPoll();
    // Another worker writes straight to the table.
    await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [
      "disabled_integrations",
      JSON.stringify(["acme"]),
    ]);
    expect(isIntegrationDisabled("acme")).toBe(false); // not yet
    await vi.advanceTimersByTimeAsync(config.INSTANCE_SETTINGS_POLL_SECONDS * 1000 + 50);
    expect(isIntegrationDisabled("acme")).toBe(true);
  });

  it("keeps the last good snapshot when a reload fails", async () => {
    vi.useFakeTimers();
    await saveSetting("disabled_integrations", ["acme"], "u-admin");
    startSettingsPoll();
    const spy = vi.spyOn(db, "all").mockRejectedValueOnce(new Error("db down"));
    await vi.advanceTimersByTimeAsync(config.INSTANCE_SETTINGS_POLL_SECONDS * 1000 + 50);
    expect(isIntegrationDisabled("acme")).toBe(true);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/instance-settings.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/server/src/config.ts`: add to the schema, after the `ADMIN_EMAILS` entry:

```ts
  // How often each process re-reads instance_settings, so a change an admin made
  // through another worker or pod reaches this one. A change made through this
  // process applies immediately.
  INSTANCE_SETTINGS_POLL_SECONDS: z.coerce.number().int().positive().default(5),
```

Create `packages/server/src/settings/instance-settings.ts`:

```ts
import { config } from "../config";
import { db } from "../db";

export type CustomAppsMode = "all" | "none" | "allowlist";

export interface CustomAppsPolicy {
  mode: CustomAppsMode;
  user_ids: string[];
}

export interface InstanceSettings {
  disabled_integrations: string[];
  custom_apps_policy: CustomAppsPolicy;
}

const DEFAULTS: InstanceSettings = {
  disabled_integrations: [],
  custom_apps_policy: { mode: "all", user_ids: [] },
};

// The registry and the request path read these synchronously, so they read a
// snapshot rather than the database. It is replaced whole, never mutated.
let snapshot: InstanceSettings = DEFAULTS;

export function getSettings(): InstanceSettings {
  return snapshot;
}

export function isIntegrationDisabled(name: string): boolean {
  return snapshot.disabled_integrations.includes(name);
}

export function customAppsAllowedFor(userId: string): boolean {
  const p = snapshot.custom_apps_policy;
  if (p.mode === "all") return true;
  if (p.mode === "none") return false;
  return p.user_ids.includes(userId);
}

// A stored value is operator-editable data, so parse it tolerantly: a corrupt
// row falls back to the default for that key and never takes the instance down
// or quietly disables anything.
function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseDisabled(raw: string | undefined): string[] {
  const v = parseJson(raw);
  return Array.isArray(v) ? stringList(v) : [];
}

function parsePolicy(raw: string | undefined): CustomAppsPolicy {
  const v = parseJson(raw) as { mode?: unknown; user_ids?: unknown } | undefined;
  if (!v || typeof v !== "object") return DEFAULTS.custom_apps_policy;
  const mode = v.mode;
  if (mode !== "all" && mode !== "none" && mode !== "allowlist") return DEFAULTS.custom_apps_policy;
  if (!Array.isArray(v.user_ids)) return DEFAULTS.custom_apps_policy;
  return { mode, user_ids: stringList(v.user_ids) };
}

export async function loadSettings(): Promise<void> {
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM instance_settings");
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  snapshot = {
    disabled_integrations: parseDisabled(byKey.get("disabled_integrations")),
    custom_apps_policy: parsePolicy(byKey.get("custom_apps_policy")),
  };
}

export async function saveSetting(
  key: "disabled_integrations" | "custom_apps_policy",
  value: unknown,
  updatedBy: string
): Promise<void> {
  await db.run(
    `INSERT INTO instance_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    [key, JSON.stringify(value), Math.floor(Date.now() / 1000), updatedBy]
  );
  await loadSettings();
}

let timer: NodeJS.Timeout | null = null;

export function startSettingsPoll(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Keep the last good snapshot if the database hiccups.
    loadSettings().catch(() => {});
  }, config.INSTANCE_SETTINGS_POLL_SECONDS * 1000);
  timer.unref();
}

export function stopSettingsPoll(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: forget everything loaded so far. */
export function resetSettingsForTest(): void {
  snapshot = DEFAULTS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/instance-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/settings packages/server/tests/instance-settings.test.ts
git commit -m "feat(admin): instance settings store with snapshot and poll"
```

---

### Task 6: Registry hides disabled integrations; boot wiring

**Files:**
- Modify: `packages/server/src/plugins/registry.ts`, `packages/server/src/index.ts`
- Test: `packages/server/tests/registry-disabled.test.ts`

**Interfaces:**
- Consumes: `isIntegrationDisabled`, `loadSettings`, `startSettingsPoll` (Task 5).
- Produces: `registry.setDisabledPredicate(fn: (integration: string) => boolean): void`; `registry.listAllIntegrations(): Integration[]` (unfiltered); `getTool`, `getIntegration`, `listTools`, `listIntegrations`, `listToolsByIntegration` and `searchTools` all hide a disabled integration.

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/registry-disabled.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { registry } from "../src/plugins/registry";

const integration = {
  name: "acme-off",
  version: "1.0.0",
  displayName: "Acme Off",
  auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
};

const tool = {
  name: "acme_off_search",
  description: "Search acme records",
  integration: "acme-off",
  inputSchema: z.object({}),
  handler: async () => ({}),
};

registry.register({ integration: integration as any, tools: [tool as any] });

afterEach(() => {
  registry.setDisabledPredicate(() => false);
});

const disabled = (names: string[]) => (name: string) => names.includes(name);

describe("registry with a disabled integration", () => {
  it("is fully visible while nothing is disabled", () => {
    expect(registry.getIntegration("acme-off")).toBeDefined();
    expect(registry.getTool("acme_off_search")).toBeDefined();
    expect(registry.listIntegrations().map((i) => i.name)).toContain("acme-off");
    expect(registry.listTools().map((t) => t.name)).toContain("acme_off_search");
    expect(registry.listToolsByIntegration("acme-off")).toHaveLength(1);
  });

  it("hides it from every lookup, including search", () => {
    registry.setDisabledPredicate(disabled(["acme-off"]));
    expect(registry.getIntegration("acme-off")).toBeUndefined();
    expect(registry.getTool("acme_off_search")).toBeUndefined();
    expect(registry.listIntegrations().map((i) => i.name)).not.toContain("acme-off");
    expect(registry.listTools().map((t) => t.name)).not.toContain("acme_off_search");
    expect(registry.listToolsByIntegration("acme-off")).toEqual([]);
    expect(registry.searchTools("search acme records").map((t) => t.name)).not.toContain("acme_off_search");
  });

  it("still lists it for the admin view", () => {
    registry.setDisabledPredicate(disabled(["acme-off"]));
    expect(registry.listAllIntegrations().map((i) => i.name)).toContain("acme-off");
  });

  it("brings it back when it is re-enabled", () => {
    registry.setDisabledPredicate(disabled(["acme-off"]));
    registry.setDisabledPredicate(disabled([]));
    expect(registry.getTool("acme_off_search")).toBeDefined();
    expect(registry.searchTools("search acme records").map((t) => t.name)).toContain("acme_off_search");
  });

  it("disabling one integration leaves the others alone", () => {
    registry.setDisabledPredicate(disabled(["some-other"]));
    expect(registry.getTool("acme_off_search")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/registry-disabled.test.ts`
Expected: FAIL (`setDisabledPredicate` is not a function).

- [ ] **Step 3: Implement the registry filter**

In `packages/server/src/plugins/registry.ts`, replace the body of `class Registry` (everything after `register`) so it reads:

```ts
class Registry {
  private plugins = new Map<string, Plugin>();
  private tools = new Map<string, PluginTool>();
  // Injected rather than imported: the registry stays free of the database.
  private isDisabled: (integration: string) => boolean = () => false;

  register(plugin: Plugin): void {
    this.plugins.set(plugin.integration.name, plugin);
    for (const tool of plugin.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Hide disabled integrations from every lookup below. There are about 25 call
   * sites across the MCP tools, the REST routes and the portal API; filtering
   * here means none of them can forget to.
   */
  setDisabledPredicate(fn: (integration: string) => boolean): void {
    this.isDisabled = fn;
  }

  getPluginDir(name: string): string | undefined {
    return this.plugins.get(name)?.dir;
  }

  listToolsByIntegration(name: string): PluginTool[] {
    return this.isDisabled(name) ? [] : (this.plugins.get(name)?.tools ?? []);
  }

  getTool(name: string): PluginTool | undefined {
    const tool = this.tools.get(name);
    return tool && !this.isDisabled(tool.integration) ? tool : undefined;
  }

  getIntegration(name: string): Integration | undefined {
    return this.isDisabled(name) ? undefined : this.plugins.get(name)?.integration;
  }

  listIntegrations(): Integration[] {
    return this.listAllIntegrations().filter((i) => !this.isDisabled(i.name));
  }

  /** Every registered integration, disabled or not. For the admin Config tab only. */
  listAllIntegrations(): Integration[] {
    return Array.from(this.plugins.values()).map((p) => p.integration);
  }

  listTools(): PluginTool[] {
    return Array.from(this.tools.values()).filter((t) => !this.isDisabled(t.integration));
  }

  /** Built-in tools matching `query`, best first. See ./search. */
  searchTools(query: string): PluginTool[] {
    return rankTools(this.listTools(), query).map((r) => r.tool);
  }
}
```

(Keep the existing `export const registry = new Registry();` line.)

- [ ] **Step 4: Wire the boot sequence**

In `packages/server/src/index.ts` add imports:

```ts
import { registry } from "./plugins/registry";
import { isIntegrationDisabled, loadSettings, startSettingsPoll } from "./settings/instance-settings";
```

and, directly after `await initDb();` (before `await loadPlugins();`), add:

```ts
  // Load instance settings before any request can be served, and keep them fresh
  // against changes made through other workers or pods.
  await loadSettings();
  registry.setDisabledPredicate(isIntegrationDisabled);
  startSettingsPoll();
```

- [ ] **Step 5: Run tests and the whole server suite**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/registry-disabled.test.ts && NODE_ENV=test npx vitest run`
Expected: PASS.

Run: `grep -rn "registry\.\(plugins\|tools\)" packages/server/src`
Expected: no output (the maps are private, so nothing can bypass the filter).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/plugins/registry.ts packages/server/src/index.ts packages/server/tests/registry-disabled.test.ts
git commit -m "feat(admin): registry hides disabled integrations"
```

---

### Task 7: Custom-app policy enforcement

**Files:**
- Modify: `packages/server/src/custom-apps/index.ts`, `packages/server/src/api/routes.ts`, `packages/server/tests/routes.test.ts`
- Test: `packages/server/tests/custom-apps-policy.test.ts`

**Interfaces:**
- Consumes: `customAppsAllowedFor`, `saveSetting`, `resetSettingsForTest` (Task 5).
- Produces: `ensureIndex` returns `[]` for an excluded user without touching the store; `POST /api/custom-apps` answers `403 {error: "custom_apps_disabled"}` for an excluded user before any discovery; `GET /api/auth/me` adds `canCreateCustomApps: boolean`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/tests/custom-apps-policy.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => ({ listCustomApps: vi.fn(async () => []) }));
vi.mock("../src/custom-apps/store", async (orig) => ({
  ...(await orig<typeof import("../src/custom-apps/store")>()),
  listCustomApps: store.listCustomApps,
}));

import { ensureIndex, invalidateIndex } from "../src/custom-apps/index";
import { db } from "../src/db";
import { resetSettingsForTest, saveSetting } from "../src/settings/instance-settings";

beforeEach(async () => {
  store.listCustomApps.mockClear();
  await db.exec("DELETE FROM instance_settings");
  resetSettingsForTest();
  invalidateIndex("u1");
  invalidateIndex("u2");
});

describe("ensureIndex and the custom-app policy", () => {
  it("looks up the user's apps when custom apps are open to everyone", async () => {
    await ensureIndex("u1");
    expect(store.listCustomApps).toHaveBeenCalledWith("u1");
  });

  it("returns no tools, and never reads the user's apps, when the policy is none", async () => {
    await saveSetting("custom_apps_policy", { mode: "none", user_ids: [] }, "u-admin");
    expect(await ensureIndex("u1")).toEqual([]);
    expect(store.listCustomApps).not.toHaveBeenCalled();
  });

  it("an allowlist admits only the listed users", async () => {
    await saveSetting("custom_apps_policy", { mode: "allowlist", user_ids: ["u1"] }, "u-admin");
    await ensureIndex("u1");
    expect(store.listCustomApps).toHaveBeenCalledWith("u1");
    store.listCustomApps.mockClear();
    expect(await ensureIndex("u2")).toEqual([]);
    expect(store.listCustomApps).not.toHaveBeenCalled();
  });

  it("applies a policy change even when the user's index is cached", async () => {
    await ensureIndex("u1"); // caches an (empty) index
    await saveSetting("custom_apps_policy", { mode: "none", user_ids: [] }, "u-admin");
    store.listCustomApps.mockClear();
    expect(await ensureIndex("u1")).toEqual([]);
    expect(store.listCustomApps).not.toHaveBeenCalled();
  });
});
```

In `packages/server/tests/routes.test.ts`, find the existing `describe("GET /api/auth/me")` test `"returns user profile with valid JWT"` and change its expectation to

```ts
      expect(JSON.parse(res.body)).toEqual({
        id: "user-1",
        email: "test@example.com",
        isAdmin: false,
        canCreateCustomApps: true,
      });
```

then add inside the same `describe("GET /api/auth/me")`:

```ts
    it("reports canCreateCustomApps false when the policy excludes the user", async () => {
      const { saveSetting, resetSettingsForTest } = await import("../src/settings/instance-settings");
      await saveSetting("custom_apps_policy", { mode: "none", user_ids: [] }, "u-admin");
      try {
        const app = await buildApp();
        const res = await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { authorization: "Bearer valid-jwt" },
        });
        expect(JSON.parse(res.body).canCreateCustomApps).toBe(false);
      } finally {
        await db.exec("DELETE FROM instance_settings");
        resetSettingsForTest();
      }
    });
```

and a new `describe` near the existing custom-app route tests (or at the end of the top-level `describe("API routes")`):

```ts
  describe("POST /api/custom-apps and the custom-app policy", () => {
    async function withPolicy(policy: unknown, run: () => Promise<void>) {
      const { saveSetting, resetSettingsForTest } = await import("../src/settings/instance-settings");
      await saveSetting("custom_apps_policy", policy, "u-admin");
      try {
        await run();
      } finally {
        await db.exec("DELETE FROM instance_settings");
        resetSettingsForTest();
      }
    }

    const create = (app: Awaited<ReturnType<typeof buildApp>>) =>
      app.inject({
        method: "POST",
        url: "/api/custom-apps",
        headers: { authorization: "Bearer valid-jwt" },
        payload: {},
      });

    it("403 custom_apps_disabled when the policy is none, before any validation or discovery", async () => {
      await withPolicy({ mode: "none", user_ids: [] }, async () => {
        const res = await create(await buildApp());
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body)).toEqual({ error: "custom_apps_disabled" });
      });
    });

    it("403 for a user not on the allowlist", async () => {
      await withPolicy({ mode: "allowlist", user_ids: ["someone-else"] }, async () => {
        expect((await create(await buildApp())).statusCode).toBe(403);
      });
    });

    it("lets a listed user through to normal validation", async () => {
      await withPolicy({ mode: "allowlist", user_ids: ["user-1"] }, async () => {
        const res = await create(await buildApp());
        expect(res.statusCode).toBe(400); // missing name and baseUrl, not 403
      });
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/custom-apps-policy.test.ts tests/routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/server/src/custom-apps/index.ts`: add `import { customAppsAllowedFor } from "../settings/instance-settings";` and, as the first line of `ensureIndex` (before the cache lookup), add:

```ts
  // Checked before the cache, so a policy change takes effect without waiting
  // for the cached index to expire.
  if (!customAppsAllowedFor(userId)) return [];
```

`packages/server/src/api/routes.ts`: add `import { customAppsAllowedFor } from "../settings/instance-settings";`. In the `POST /api/custom-apps` handler, directly after the `if (!user) return reply.status(401)...` line, add:

```ts
    if (!customAppsAllowedFor(user.userId)) {
      return reply.status(403).send({ error: "custom_apps_disabled" });
    }
```

In the `/api/auth/me` handler change the return to:

```ts
    return {
      id: profile.id,
      email: profile.email,
      isAdmin: isAdminEmail(profile.email),
      canCreateCustomApps: customAppsAllowedFor(profile.id),
    };
```

- [ ] **Step 4: Run tests to verify they pass, then the whole server suite**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/custom-apps-policy.test.ts tests/routes.test.ts && NODE_ENV=test npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/tests
git commit -m "feat(admin): custom-app policy enforcement"
```

---

### Task 8: Admin config endpoints

**Files:**
- Create: `packages/server/src/admin/config.ts`, `packages/server/tests/admin-config.test.ts`
- Modify: `packages/server/src/api/admin-routes.ts`

**Interfaces:**
- Consumes: `registry.listAllIntegrations`, `getSettings`, `saveSetting`, `isIntegrationDisabled`, `adminActor`, `auditLogger`.
- Produces:
  ```ts
  export interface ConfigView { integrations: { name: string; display_name: string; enabled: boolean }[]; custom_apps_policy: CustomAppsPolicy }
  export type ConfigResult = { ok: true } | { ok: false; status: 400 | 404; error: "unknown_integration" | "invalid_body" | "invalid_policy" | "unknown_user" };
  export function getConfigView(): ConfigView;
  export function setIntegrationEnabled(actor: AdminActor, name: string, body: unknown): Promise<ConfigResult>;
  export function setCustomAppsPolicy(actor: AdminActor, body: unknown): Promise<ConfigResult>;
  ```
  Routes: `GET /api/admin/config`; `PUT /api/admin/config/integrations/:name` (body `{enabled: boolean}`); `PUT /api/admin/config/custom-apps` (body `{mode, user_ids?}`).

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/admin-config.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    ADMIN_EMAILS: ["admin@example.com"],
    AUDIT_LOG_DEST: "sqlite",
    CLUSTER_ENABLED: false,
    INSTANCE_SETTINGS_POLL_SECONDS: 5,
  },
}));

vi.mock("../src/auth/session", () => ({
  verifySession: vi.fn((token: string) => {
    if (token === "admin-jwt") return { userId: "user-admin", email: "admin@example.com" };
    if (token === "dev-jwt") return { userId: "user-dev", email: "dev@example.com" };
    throw new Error("Invalid token");
  }),
}));

vi.mock("../src/auth/users", async (orig) => ({
  ...(await orig<typeof import("../src/auth/users")>()),
  verifyApiKey: vi.fn(async () => null),
  getUserById: vi.fn(async (id: string) => {
    if (id === "user-admin") return { id, email: "admin@example.com" };
    if (id === "user-dev") return { id, email: "dev@example.com" };
    return null;
  }),
}));

import { registerAdminRoutes } from "../src/api/admin-routes";
import { db } from "../src/db";
import { registry } from "../src/plugins/registry";
import { isIntegrationDisabled, resetSettingsForTest, getSettings } from "../src/settings/instance-settings";

const ADMIN = { authorization: "Bearer admin-jwt" };
const DEV = { authorization: "Bearer dev-jwt" };

registry.register({
  integration: {
    name: "acme-cfg",
    version: "1.0.0",
    displayName: "Acme Cfg",
    auth: { type: "oauth2", authorizationUrl: "", tokenUrl: "", scopes: [] },
  } as any,
  tools: [
    { name: "acme_cfg_search", description: "x", integration: "acme-cfg", inputSchema: z.object({}), handler: async () => ({}) } as any,
  ],
});

beforeAll(() => {
  // The same wiring the real boot does.
  registry.setDisabledPredicate(isIntegrationDisabled);
});

async function call(
  method: "GET" | "PUT",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = ADMIN
) {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app.inject({ method, url, headers, payload: payload as object | undefined });
}

beforeEach(async () => {
  for (const t of ["audit_log", "instance_settings", "users"]) await db.exec(`DELETE FROM ${t}`);
  resetSettingsForTest();
  await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["user-admin", "admin@example.com"]);
  await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["user-dev", "dev@example.com"]);
});

const WRITES = [
  ["GET", "/api/admin/config", undefined],
  ["PUT", "/api/admin/config/integrations/acme-cfg", { enabled: false }],
  ["PUT", "/api/admin/config/custom-apps", { mode: "none" }],
] as const;

describe.each(WRITES)("%s %s gate", (method, url, payload) => {
  it("401 without a session", async () => {
    expect((await call(method, url, payload, {})).statusCode).toBe(401);
  });
  it("403 for a signed-in non-admin", async () => {
    expect((await call(method, url, payload, DEV)).statusCode).toBe(403);
  });
});

describe("GET /api/admin/config", () => {
  it("lists every integration with its enabled flag, plus the custom-app policy", async () => {
    const body = JSON.parse((await call("GET", "/api/admin/config")).body);
    const acme = body.integrations.find((i: { name: string }) => i.name === "acme-cfg");
    expect(acme).toEqual({ name: "acme-cfg", display_name: "Acme Cfg", enabled: true });
    expect(body.custom_apps_policy).toEqual({ mode: "all", user_ids: [] });
  });
});

describe("PUT /api/admin/config/integrations/:name", () => {
  it("disables an integration: it leaves the registry, stays in the admin view, and is audited", async () => {
    const res = await call("PUT", "/api/admin/config/integrations/acme-cfg", { enabled: false });
    expect(res.statusCode).toBe(200);
    expect(registry.getIntegration("acme-cfg")).toBeUndefined();
    expect(registry.getTool("acme_cfg_search")).toBeUndefined();
    const view = JSON.parse((await call("GET", "/api/admin/config")).body);
    expect(view.integrations.find((i: { name: string }) => i.name === "acme-cfg").enabled).toBe(false);
    const row = await db.get<{ updated_by: string }>("SELECT updated_by FROM instance_settings WHERE key = ?", [
      "disabled_integrations",
    ]);
    expect(row?.updated_by).toBe("user-admin");
    const audit = await db.all<{ user_id: string; action: string; tool: string }>(
      "SELECT user_id, action, tool FROM audit_log"
    );
    expect(audit).toEqual([
      { user_id: "user-admin", action: "ADMIN_INTEGRATION_SET", tool: "admin.config.integration acme-cfg=disabled" },
    ]);
  });

  it("re-enables it", async () => {
    await call("PUT", "/api/admin/config/integrations/acme-cfg", { enabled: false });
    const res = await call("PUT", "/api/admin/config/integrations/acme-cfg", { enabled: true });
    expect(res.statusCode).toBe(200);
    expect(registry.getIntegration("acme-cfg")).toBeDefined();
    expect(getSettings().disabled_integrations).not.toContain("acme-cfg");
  });

  it("404 for an integration that is not registered, and saves nothing", async () => {
    const res = await call("PUT", "/api/admin/config/integrations/does-not-exist", { enabled: false });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "unknown_integration" });
    expect(await db.all("SELECT 1 FROM instance_settings")).toHaveLength(0);
  });

  it.each([[{}], [{ enabled: "no" }], [null]])("400 for a body without a boolean enabled: %j", async (body) => {
    const res = await call("PUT", "/api/admin/config/integrations/acme-cfg", body);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_body" });
  });
});

describe("PUT /api/admin/config/custom-apps", () => {
  it("sets the mode and audits it", async () => {
    const res = await call("PUT", "/api/admin/config/custom-apps", { mode: "none" });
    expect(res.statusCode).toBe(200);
    expect(getSettings().custom_apps_policy).toEqual({ mode: "none", user_ids: [] });
    const audit = await db.all<{ action: string; tool: string }>("SELECT action, tool FROM audit_log");
    expect(audit).toEqual([{ action: "ADMIN_CUSTOM_APPS_POLICY", tool: "admin.config.custom-apps=none" }]);
  });

  it("accepts an allowlist of users that exist", async () => {
    const res = await call("PUT", "/api/admin/config/custom-apps", { mode: "allowlist", user_ids: ["user-dev"] });
    expect(res.statusCode).toBe(200);
    expect(getSettings().custom_apps_policy).toEqual({ mode: "allowlist", user_ids: ["user-dev"] });
  });

  it("drops user_ids when the mode is not allowlist", async () => {
    await call("PUT", "/api/admin/config/custom-apps", { mode: "all", user_ids: ["user-dev"] });
    expect(getSettings().custom_apps_policy).toEqual({ mode: "all", user_ids: [] });
  });

  it("400 unknown_user when an id does not exist, and saves nothing", async () => {
    const res = await call("PUT", "/api/admin/config/custom-apps", { mode: "allowlist", user_ids: ["user-dev", "ghost"] });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "unknown_user" });
    expect(await db.all("SELECT 1 FROM instance_settings")).toHaveLength(0);
  });

  it.each([[{ mode: "everyone" }], [{}], [{ mode: "allowlist", user_ids: "user-dev" }], [{ mode: "allowlist", user_ids: [7] }], [null]])(
    "400 invalid_policy for %j",
    async (body) => {
      const res = await call("PUT", "/api/admin/config/custom-apps", body);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "invalid_policy" });
    }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-config.test.ts`
Expected: FAIL (routes 404).

- [ ] **Step 3: Implement**

Create `packages/server/src/admin/config.ts`:

```ts
import { db } from "../db";
import { auditLogger } from "../audit/logger";
import { registry } from "../plugins/registry";
import {
  getSettings,
  isIntegrationDisabled,
  saveSetting,
  type CustomAppsPolicy,
} from "../settings/instance-settings";
import type { AdminActor } from "../api/admin-scope";

export interface ConfigView {
  integrations: { name: string; display_name: string; enabled: boolean }[];
  custom_apps_policy: CustomAppsPolicy;
}

export type ConfigResult =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 404;
      error: "unknown_integration" | "invalid_body" | "invalid_policy" | "unknown_user";
    };

const MAX_ALLOWLIST = 500;

export function getConfigView(): ConfigView {
  return {
    integrations: registry
      .listAllIntegrations()
      .map((i) => ({ name: i.name, display_name: i.displayName || i.name, enabled: !isIntegrationDisabled(i.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    custom_apps_policy: getSettings().custom_apps_policy,
  };
}

export async function setIntegrationEnabled(
  actor: AdminActor,
  name: string,
  body: unknown
): Promise<ConfigResult> {
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") return { ok: false, status: 400, error: "invalid_body" };
  if (!registry.listAllIntegrations().some((i) => i.name === name)) {
    return { ok: false, status: 404, error: "unknown_integration" };
  }

  const disabled = new Set(getSettings().disabled_integrations);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  await saveSetting("disabled_integrations", [...disabled].sort(), actor.userId);

  await auditLogger.log({
    user_id: actor.userId,
    action: "ADMIN_INTEGRATION_SET",
    tool: `admin.config.integration ${name}=${enabled ? "enabled" : "disabled"}`,
    success: true,
  });
  return { ok: true };
}

export async function setCustomAppsPolicy(actor: AdminActor, body: unknown): Promise<ConfigResult> {
  const b = body as { mode?: unknown; user_ids?: unknown } | null;
  const mode = b?.mode;
  if (mode !== "all" && mode !== "none" && mode !== "allowlist") {
    return { ok: false, status: 400, error: "invalid_policy" };
  }

  let userIds: string[] = [];
  if (mode === "allowlist") {
    const ids = b?.user_ids ?? [];
    if (!Array.isArray(ids) || ids.length > MAX_ALLOWLIST || !ids.every((x) => typeof x === "string")) {
      return { ok: false, status: 400, error: "invalid_policy" };
    }
    userIds = [...new Set(ids as string[])];
    if (userIds.length > 0) {
      const found = await db.all<{ id: string }>(
        `SELECT id FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`,
        userIds
      );
      if (found.length !== userIds.length) return { ok: false, status: 400, error: "unknown_user" };
    }
  }

  await saveSetting("custom_apps_policy", { mode, user_ids: userIds }, actor.userId);
  await auditLogger.log({
    user_id: actor.userId,
    action: "ADMIN_CUSTOM_APPS_POLICY",
    tool: `admin.config.custom-apps=${mode}`,
    success: true,
  });
  return { ok: true };
}
```

In `packages/server/src/api/admin-routes.ts` add `import { getConfigView, setIntegrationEnabled, setCustomAppsPolicy } from "../admin/config";` and inside the scope callback:

```ts
    scope.get("/config", async () => getConfigView());
    scope.put<{ Params: { name: string }; Body: unknown }>("/config/integrations/:name", async (request, reply) => {
      const result = await setIntegrationEnabled(adminActor(request), request.params.name, request.body);
      if (!result.ok) return reply.status(result.status).send({ error: result.error });
      return { ok: true };
    });
    scope.put<{ Body: unknown }>("/config/custom-apps", async (request, reply) => {
      const result = await setCustomAppsPolicy(adminActor(request), request.body);
      if (!result.ok) return reply.status(result.status).send({ error: result.error });
      return { ok: true };
    });
```

- [ ] **Step 4: Run tests, then the whole server suite**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-config.test.ts && NODE_ENV=test npx vitest run`
Expected: PASS. If `PUT` with a `null` body is rejected by Fastify before the handler (a 400 with a different error shape), send `{}` for that case in the `it.each` instead, and keep `null` covered by a direct call to `setIntegrationEnabled`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/tests/admin-config.test.ts
git commit -m "feat(admin): config endpoints for integrations and custom-app policy"
```

---

### Task 9: Portal Users tab

**Files:**
- Modify: `packages/portal/src/api.ts`, `packages/portal/src/pages/Admin.tsx`, `packages/portal/src/pages/Admin.test.tsx`
- Create: `packages/portal/src/components/admin/UsersTab.tsx`, `packages/portal/src/components/admin/UsersTab.test.tsx`

**Interfaces:**
- Consumes: `/api/admin/users` and its three `POST` actions; `ADMIN_STALE_MS`, `CardBody`, `Box`, `DataTable`, `Modal`, `Button`, `Badge`, `EmptyState`; `useAuth`.
- Produces: in `api.ts`
  ```ts
  export interface AdminUser { id: string; email: string | null; created_at: number; disabled_at: number | null; has_api_key: boolean; connection_count: number; custom_app_count: number; last_activity: number | null }
  export function fetchAdminUsers(): Promise<{ users: AdminUser[]; total: number }>;
  export function disableAdminUser(id: string): Promise<void>;
  export function enableAdminUser(id: string): Promise<void>;
  export function revokeAdminUserKey(id: string): Promise<void>;
  ```
  and a default-exported `UsersTab`. Action failures throw `Error` with a readable message.

- [ ] **Step 1: Write the failing tests**

Create `packages/portal/src/components/admin/UsersTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import UsersTab from "./UsersTab";

const api = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn(),
  disableAdminUser: vi.fn(),
  enableAdminUser: vi.fn(),
  revokeAdminUserKey: vi.fn(),
}));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", email: "admin@example.com", isAdmin: true }, isLoading: false }),
}));

const NOW = Math.floor(Date.now() / 1000);

function user(over: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "dev@example.com",
    created_at: NOW - 86400,
    disabled_at: null,
    has_api_key: true,
    connection_count: 2,
    custom_app_count: 1,
    last_activity: NOW - 120,
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminUsers.mockResolvedValue({ users: [user()], total: 1 });
  api.disableAdminUser.mockResolvedValue(undefined);
  api.enableAdminUser.mockResolvedValue(undefined);
  api.revokeAdminUserKey.mockResolvedValue(undefined);
});

describe("UsersTab", () => {
  it("lists users with counts, key state and status", async () => {
    api.fetchAdminUsers.mockResolvedValue({
      users: [user(), user({ id: "u2", email: "off@example.com", disabled_at: NOW - 5, has_api_key: false, last_activity: null })],
      total: 2,
    });
    renderWithClient(<UsersTab />);
    const dev = (await screen.findByText("dev@example.com")).closest("tr")!;
    expect(dev).toHaveTextContent("Active");
    expect(dev).toHaveTextContent("2");
    const off = screen.getByText("off@example.com").closest("tr")!;
    expect(off).toHaveTextContent("Disabled");
    expect(off).toHaveTextContent("—");
  });

  it("shows empty and error states", async () => {
    api.fetchAdminUsers.mockResolvedValueOnce({ users: [], total: 0 });
    const { unmount } = renderWithClient(<UsersTab />);
    expect(await screen.findByText("No users yet.")).toBeInTheDocument();
    unmount();
    api.fetchAdminUsers.mockRejectedValue(new Error("boom"));
    renderWithClient(<UsersTab />);
    expect(await screen.findByText("Couldn't load users.")).toBeInTheDocument();
  });

  it("disabling asks for confirmation first, then calls the API and refreshes", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Disable dev@example.com" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/signed out/i)).toBeInTheDocument();
    expect(api.disableAdminUser).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.disableAdminUser).toHaveBeenCalledWith("u1"));
    await waitFor(() => expect(api.fetchAdminUsers).toHaveBeenCalledTimes(2));
  });

  it("cancelling the confirmation does nothing", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Disable dev@example.com" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.disableAdminUser).not.toHaveBeenCalled();
  });

  it("enabling a disabled user needs no confirmation", async () => {
    api.fetchAdminUsers.mockResolvedValue({ users: [user({ disabled_at: NOW - 5 })], total: 1 });
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Enable dev@example.com" }));
    await waitFor(() => expect(api.enableAdminUser).toHaveBeenCalledWith("u1"));
  });

  it("revoking a key asks for confirmation, and is offered only when the user has a key", async () => {
    api.fetchAdminUsers.mockResolvedValue({
      users: [user(), user({ id: "u2", email: "nokey@example.com", has_api_key: false })],
      total: 2,
    });
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    expect(screen.queryByRole("button", { name: "Revoke key for nokey@example.com" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke key for dev@example.com" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));
    await waitFor(() => expect(api.revokeAdminUserKey).toHaveBeenCalledWith("u1"));
  });

  it("offers no Disable button on your own row", async () => {
    api.fetchAdminUsers.mockResolvedValue({ users: [user({ id: "me", email: "admin@example.com" })], total: 1 });
    renderWithClient(<UsersTab />);
    await screen.findByText("admin@example.com");
    expect(screen.queryByRole("button", { name: "Disable admin@example.com" })).not.toBeInTheDocument();
  });

  it("shows the server's reason when an action is refused", async () => {
    api.disableAdminUser.mockRejectedValueOnce(new Error("Admins named in ADMIN_EMAILS can't be disabled here."));
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Disable dev@example.com" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("can't be disabled here");
  });
});
```

Add to `packages/portal/src/api.admin.test.ts`:

```ts
import { disableAdminUser, enableAdminUser, revokeAdminUserKey, fetchAdminUsers } from "./api";
```

(merge into the existing `import { fetchAdminActivity, fetchAdminInstance } from "./api";` line) and these tests inside `describe("admin fetchers")`:

```ts
  it("fetchAdminUsers calls the users endpoint", async () => {
    await fetchAdminUsers();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/users");
  });

  it.each([
    ["disable", disableAdminUser],
    ["enable", enableAdminUser],
    ["revoke-key", revokeAdminUserKey],
  ] as const)("%s POSTs with the bearer token and no Content-Type", async (path, fn) => {
    await fn("u 1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/admin/users/u%201/${path}`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("an action the server refuses throws a readable message", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "cannot_disable_self" }) });
    await expect(disableAdminUser("me")).rejects.toThrow("You can't disable your own account.");
  });

  it("an unrecognised error code falls back to a generic message", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "weird" }) });
    await expect(enableAdminUser("u1")).rejects.toThrow("Action failed");
  });
```

Replace `packages/portal/src/pages/Admin.test.tsx` with:

```tsx
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Admin from "./Admin";

vi.mock("../components/admin/OverviewTab", () => ({ default: () => <p>overview-body</p> }));
vi.mock("../components/admin/UsersTab", () => ({ default: () => <p>users-body</p> }));
vi.mock("../components/admin/ConfigTab", () => ({ default: () => <p>config-body</p> }));

describe("Admin page", () => {
  it("has a title and opens on the Overview tab", () => {
    render(<Admin />);
    expect(screen.getByRole("heading", { level: 1, name: "Admin" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("overview-body")).toBeInTheDocument();
  });

  it("switches between Overview, Users and Config", () => {
    render(<Admin />);
    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    expect(screen.getByText("users-body")).toBeInTheDocument();
    expect(screen.queryByText("overview-body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Config" }));
    expect(screen.getByText("config-body")).toBeInTheDocument();
  });
});
```

(`ConfigTab` is created in Task 10; until then `Admin.test.tsx` fails on the missing module, so Task 9 creates a one-line stub for it, see Step 3.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/portal && npm run test -- src/components/admin/UsersTab.test.tsx src/api.admin.test.ts src/pages/Admin.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `packages/portal/src/api.ts` (after the admin overview fetchers):

```ts
// ─── Admin users ─────────────────────────────────────────────────────────
export interface AdminUser {
  id: string;
  email: string | null;
  /** Unix seconds. */
  created_at: number;
  /** Unix seconds when disabled, null when active. */
  disabled_at: number | null;
  has_api_key: boolean;
  connection_count: number;
  custom_app_count: number;
  /** Unix seconds, null when the user has no recorded activity. */
  last_activity: number | null;
}

export const fetchAdminUsers = () =>
  adminGet<{ users: AdminUser[]; total: number }>("/api/admin/users", "users");

const ADMIN_ACTION_MESSAGES: Record<string, string> = {
  cannot_disable_self: "You can't disable your own account.",
  cannot_disable_admin: "Admins named in ADMIN_EMAILS can't be disabled here.",
  user_not_found: "That user no longer exists.",
  unknown_integration: "That integration is not registered.",
  unknown_user: "One of the selected users no longer exists.",
  invalid_policy: "That policy is not valid.",
  invalid_body: "That request is not valid.",
};

// Bodyless POST: auth header only. A Content-Type of application/json with no
// body is rejected by Fastify (FST_ERR_CTP_EMPTY_JSON_BODY).
async function adminPost(path: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: authHeaders() });
  await throwIfAdminActionFailed(res);
}

async function adminPut(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { method: "PUT", headers: getHeaders(), body: JSON.stringify(body) });
  await throwIfAdminActionFailed(res);
}

async function throwIfAdminActionFailed(res: Response): Promise<void> {
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (res.ok) return;
  const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "";
  throw new Error(ADMIN_ACTION_MESSAGES[code] ?? "Action failed");
}

export const disableAdminUser = (id: string) => adminPost(`/api/admin/users/${encodeURIComponent(id)}/disable`);
export const enableAdminUser = (id: string) => adminPost(`/api/admin/users/${encodeURIComponent(id)}/enable`);
export const revokeAdminUserKey = (id: string) => adminPost(`/api/admin/users/${encodeURIComponent(id)}/revoke-key`);
```

(`adminPut` is used by Task 10; keep it here so both tabs share one error path.)

Create `packages/portal/src/components/admin/UsersTab.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  disableAdminUser,
  enableAdminUser,
  fetchAdminUsers,
  revokeAdminUserKey,
  type AdminUser,
} from "../../api";
import { useAuth } from "../../context/AuthContext";
import { dayLabel, relativeTime } from "../../format";
import { Badge } from "../ui/Badge";
import { Box } from "../ui/Box";
import { Button } from "../ui/Button";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Modal } from "../ui/Modal";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

type Action = { kind: "disable" | "enable" | "revoke"; id: string };
type Confirm = { kind: "disable" | "revoke"; user: AdminUser };

export default function UsersTab() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: fetchAdminUsers,
    staleTime: ADMIN_STALE_MS,
  });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: ({ kind, id }: Action) =>
      kind === "disable" ? disableAdminUser(id) : kind === "enable" ? enableAdminUser(id) : revokeAdminUserKey(id),
    onSuccess: () => {
      setConfirm(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (e) => {
      setConfirm(null);
      setError(e instanceof Error ? e.message : "Action failed");
    },
  });

  const users = data?.users ?? [];
  const label = (u: AdminUser) => u.email ?? u.id;

  return (
    <>
      {error && <div className="ui-form-error" role="alert">{error}</div>}
      <Box title="Users">
        <CardBody isLoading={isLoading} isError={isError} label="users">
          {users.length === 0 ? (
            <EmptyState message="No users yet." />
          ) : (
            <DataTable
              caption="All users"
              head={
                <tr>
                  <th scope="col">User</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Last active</th>
                  <th scope="col" className="ui-num">Connections</th>
                  <th scope="col" className="ui-num">Apps</th>
                  <th scope="col">API key</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="ui-sr-only">Actions</span></th>
                </tr>
              }
            >
              {users.map((u) => {
                const disabled = u.disabled_at !== null;
                return (
                  <tr key={u.id}>
                    <td>{label(u)}</td>
                    <td>{dayLabel(u.created_at)}</td>
                    <td>{u.last_activity ? relativeTime(u.last_activity) : "—"}</td>
                    <td className="ui-num">{u.connection_count}</td>
                    <td className="ui-num">{u.custom_app_count}</td>
                    <td>{u.has_api_key ? "Yes" : "—"}</td>
                    <td>
                      <Badge variant={disabled ? "red" : "green"}>{disabled ? "Disabled" : "Active"}</Badge>
                    </td>
                    <td>
                      <div className="wb-toolbar-form">
                        {u.has_api_key && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Revoke key for ${label(u)}`}
                            onClick={() => setConfirm({ kind: "revoke", user: u })}
                          >
                            Revoke key
                          </Button>
                        )}
                        {disabled ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Enable ${label(u)}`}
                            disabled={act.isPending}
                            onClick={() => act.mutate({ kind: "enable", id: u.id })}
                          >
                            Enable
                          </Button>
                        ) : (
                          u.id !== me?.id && (
                            <Button
                              variant="danger"
                              size="sm"
                              aria-label={`Disable ${label(u)}`}
                              onClick={() => setConfirm({ kind: "disable", user: u })}
                            >
                              Disable
                            </Button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </CardBody>
      </Box>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "disable" ? "Disable user" : "Revoke API key"}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={act.isPending}
              onClick={() => confirm && act.mutate({ kind: confirm.kind, id: confirm.user.id })}
            >
              {confirm?.kind === "disable" ? "Disable" : "Revoke key"}
            </Button>
          </>
        }
      >
        {confirm?.kind === "disable" ? (
          <p>
            Disable {confirm && label(confirm.user)}? They are signed out of the portal, and agents using their API key
            or OAuth login stop working. Their connections and files are kept, and you can enable them again.
          </p>
        ) : (
          <p>
            Revoke the API key for {confirm && label(confirm.user)}? Agents using it stop working until they create a
            new one.
          </p>
        )}
      </Modal>
    </>
  );
}
```

Replace `packages/portal/src/pages/Admin.tsx` with:

```tsx
import { useState } from "react";
import { PageHeader } from "../components/ui/PageHeader";
import { Tabs } from "../components/ui/Tabs";
import OverviewTab from "../components/admin/OverviewTab";
import UsersTab from "../components/admin/UsersTab";
import ConfigTab from "../components/admin/ConfigTab";

// One page, one tab per admin concern.
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "config", label: "Config" },
];

export default function Admin() {
  const [tab, setTab] = useState("overview");
  return (
    <>
      <PageHeader title="Admin" toolbar={<Tabs items={TABS} value={tab} onChange={setTab} label="Admin sections" />} />
      {tab === "overview" && <OverviewTab />}
      {tab === "users" && <UsersTab />}
      {tab === "config" && <ConfigTab />}
    </>
  );
}
```

Create a stub `packages/portal/src/components/admin/ConfigTab.tsx` so the page compiles (Task 10 replaces it):

```tsx
export default function ConfigTab() {
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass, then the whole portal suite**

Run: `cd packages/portal && npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/portal/src
git commit -m "feat(admin): users tab with disable, enable and revoke key"
```

---

### Task 10: Portal Config tab and Apps gating

**Files:**
- Modify: `packages/portal/src/api.ts`, `packages/portal/src/context/AuthContext.tsx`, `packages/portal/src/pages/Apps.tsx`, `packages/portal/src/pages/Apps.test.tsx`
- Create/Replace: `packages/portal/src/components/admin/ConfigTab.tsx`; Create: `packages/portal/src/components/admin/ConfigTab.test.tsx`

**Interfaces:**
- Consumes: `/api/admin/config`, `/api/admin/users`, `adminPut` (Task 9).
- Produces: in `api.ts`
  ```ts
  export interface AdminConfig { integrations: { name: string; display_name: string; enabled: boolean }[]; custom_apps_policy: { mode: "all" | "none" | "allowlist"; user_ids: string[] } }
  export function fetchAdminConfig(): Promise<AdminConfig>;
  export function setAdminIntegrationEnabled(name: string, enabled: boolean): Promise<void>;
  export function setAdminCustomAppsPolicy(policy: AdminConfig["custom_apps_policy"]): Promise<void>;
  ```
  `AuthUser.canCreateCustomApps?: boolean`; the Apps page hides "New custom app" when it is `false`.

- [ ] **Step 1: Write the failing tests**

Create `packages/portal/src/components/admin/ConfigTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ConfigTab from "./ConfigTab";

const api = vi.hoisted(() => ({
  fetchAdminConfig: vi.fn(),
  fetchAdminUsers: vi.fn(),
  setAdminIntegrationEnabled: vi.fn(),
  setAdminCustomAppsPolicy: vi.fn(),
}));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));

const CONFIG = {
  integrations: [
    { name: "acme", display_name: "Acme", enabled: true },
    { name: "demo-repo", display_name: "Demo Repo", enabled: false },
  ],
  custom_apps_policy: { mode: "all" as const, user_ids: [] as string[] },
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminConfig.mockResolvedValue(CONFIG);
  api.fetchAdminUsers.mockResolvedValue({
    users: [
      { id: "u1", email: "dev@example.com" },
      { id: "u2", email: "other@example.com" },
    ],
    total: 2,
  });
  api.setAdminIntegrationEnabled.mockResolvedValue(undefined);
  api.setAdminCustomAppsPolicy.mockResolvedValue(undefined);
});

describe("ConfigTab integrations", () => {
  it("lists each integration with its state", async () => {
    renderWithClient(<ConfigTab />);
    const acme = (await screen.findByText("Acme")).closest("tr")!;
    expect(acme).toHaveTextContent("Enabled");
    expect(screen.getByText("Demo Repo").closest("tr")).toHaveTextContent("Disabled");
  });

  it("disabling asks for confirmation, then saves and refreshes", async () => {
    renderWithClient(<ConfigTab />);
    await screen.findByText("Acme");
    fireEvent.click(screen.getByRole("button", { name: "Disable Acme" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/every user/i)).toBeInTheDocument();
    expect(api.setAdminIntegrationEnabled).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.setAdminIntegrationEnabled).toHaveBeenCalledWith("acme", false));
    await waitFor(() => expect(api.fetchAdminConfig).toHaveBeenCalledTimes(2));
  });

  it("enabling needs no confirmation", async () => {
    renderWithClient(<ConfigTab />);
    await screen.findByText("Demo Repo");
    fireEvent.click(screen.getByRole("button", { name: "Enable Demo Repo" }));
    await waitFor(() => expect(api.setAdminIntegrationEnabled).toHaveBeenCalledWith("demo-repo", true));
  });

  it("shows the server's reason when a change is refused", async () => {
    api.setAdminIntegrationEnabled.mockRejectedValueOnce(new Error("That integration is not registered."));
    renderWithClient(<ConfigTab />);
    await screen.findByText("Demo Repo");
    fireEvent.click(screen.getByRole("button", { name: "Enable Demo Repo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not registered");
  });

  it("shows an error state when the config cannot be loaded", async () => {
    api.fetchAdminConfig.mockRejectedValue(new Error("boom"));
    renderWithClient(<ConfigTab />);
    expect(await screen.findByText("Couldn't load config.")).toBeInTheDocument();
  });
});

describe("ConfigTab custom-app policy", () => {
  it("shows the current mode and keeps Save disabled until something changes", async () => {
    renderWithClient(<ConfigTab />);
    const select = await screen.findByLabelText("Who can add custom apps");
    expect(select).toHaveValue("all");
    expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
  });

  it("saves a new mode", async () => {
    renderWithClient(<ConfigTab />);
    fireEvent.change(await screen.findByLabelText("Who can add custom apps"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(api.setAdminCustomAppsPolicy).toHaveBeenCalledWith({ mode: "none", user_ids: [] }));
  });

  it("an allowlist offers the users and saves the ticked ones", async () => {
    renderWithClient(<ConfigTab />);
    fireEvent.change(await screen.findByLabelText("Who can add custom apps"), { target: { value: "allowlist" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "dev@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() =>
      expect(api.setAdminCustomAppsPolicy).toHaveBeenCalledWith({ mode: "allowlist", user_ids: ["u1"] })
    );
  });

  it("does not offer the user list unless the mode is allowlist", async () => {
    renderWithClient(<ConfigTab />);
    await screen.findByLabelText("Who can add custom apps");
    expect(screen.queryByRole("checkbox", { name: "dev@example.com" })).not.toBeInTheDocument();
  });

  it("shows the server's reason when the policy is refused", async () => {
    api.setAdminCustomAppsPolicy.mockRejectedValueOnce(new Error("One of the selected users no longer exists."));
    renderWithClient(<ConfigTab />);
    fireEvent.change(await screen.findByLabelText("Who can add custom apps"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer exists");
  });
});
```

In `packages/portal/src/pages/Apps.test.tsx`: replace the `vi.mock("../context/AuthContext", ...)` block with a mutable one:

```tsx
const auth = vi.hoisted(() => ({
  user: { id: "u1", email: "dev@example.com" } as { id: string; email: string; canCreateCustomApps?: boolean },
}));
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: auth.user, token: "t", isLoading: false, login: vi.fn(), logout: vi.fn() }),
}));
```

and append inside the file's top-level (a new `describe`):

```tsx
describe("custom-app policy", () => {
  beforeEach(() => {
    vi.mocked(fetchIntegrations).mockResolvedValue({ integrations: INTEGRATIONS } as any);
    vi.mocked(fetchConnections).mockResolvedValue({ connections: [] } as any);
  });

  it("offers New custom app by default", async () => {
    auth.user = { id: "u1", email: "dev@example.com" };
    renderPage();
    expect(await screen.findByRole("button", { name: "New custom app" })).toBeInTheDocument();
  });

  it("hides New custom app when the policy excludes this user", async () => {
    auth.user = { id: "u1", email: "dev@example.com", canCreateCustomApps: false };
    renderPage();
    await screen.findByText("Acme");
    expect(screen.queryByRole("button", { name: "New custom app" })).not.toBeInTheDocument();
    auth.user = { id: "u1", email: "dev@example.com" };
  });
});
```

(If `Apps.test.tsx` already has its own `beforeEach` that sets these mocks, drop the `beforeEach` above and rely on it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/portal && npm run test -- src/components/admin/ConfigTab.test.tsx src/pages/Apps.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `packages/portal/src/api.ts`:

```ts
// ─── Admin config ────────────────────────────────────────────────────────
export interface AdminConfig {
  integrations: { name: string; display_name: string; enabled: boolean }[];
  custom_apps_policy: { mode: "all" | "none" | "allowlist"; user_ids: string[] };
}

export const fetchAdminConfig = () => adminGet<AdminConfig>("/api/admin/config", "config");

export const setAdminIntegrationEnabled = (name: string, enabled: boolean) =>
  adminPut(`/api/admin/config/integrations/${encodeURIComponent(name)}`, { enabled });

export const setAdminCustomAppsPolicy = (policy: AdminConfig["custom_apps_policy"]) =>
  adminPut("/api/admin/config/custom-apps", policy);
```

`packages/portal/src/context/AuthContext.tsx`: add `canCreateCustomApps?: boolean;` to `interface AuthUser`.

`packages/portal/src/pages/Apps.tsx`: check whether `useAuth` is imported (`grep -n useAuth src/pages/Apps.tsx`); if not, add `import { useAuth } from "../context/AuthContext";`. Inside the component add `const { user } = useAuth();` and `const canCreateCustomApp = user?.canCreateCustomApps !== false;`, then wrap the existing `<Tooltip label="New custom app ...">...</Tooltip>` element in `{canCreateCustomApp && ( ... )}`. Also wrap the "New custom app" `<Modal>` the same way is unnecessary (it only opens from the button).

Replace the stub `packages/portal/src/components/admin/ConfigTab.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAdminConfig,
  fetchAdminUsers,
  setAdminCustomAppsPolicy,
  setAdminIntegrationEnabled,
  type AdminConfig,
} from "../../api";
import { Badge } from "../ui/Badge";
import { Box, BoxRow } from "../ui/Box";
import { Button } from "../ui/Button";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

type Policy = AdminConfig["custom_apps_policy"];
type Row = AdminConfig["integrations"][number];

export default function ConfigTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "config"],
    queryFn: fetchAdminConfig,
    staleTime: ADMIN_STALE_MS,
  });
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Row | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "config"] });
  const onError = (e: unknown) => {
    setConfirm(null);
    setError(e instanceof Error ? e.message : "Action failed");
  };

  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => setAdminIntegrationEnabled(name, enabled),
    onSuccess: () => {
      setConfirm(null);
      setError(null);
      refresh();
    },
    onError,
  });

  const integrations = data?.integrations ?? [];

  return (
    <div className="wb-section-gap">
      {error && <div className="ui-form-error" role="alert">{error}</div>}

      <Box title="Integrations">
        <CardBody isLoading={isLoading} isError={isError} label="config">
          {integrations.length === 0 ? (
            <EmptyState message="No integrations are registered." />
          ) : (
            <DataTable
              caption="Integrations and whether they are enabled"
              head={
                <tr>
                  <th scope="col">Integration</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="ui-sr-only">Actions</span></th>
                </tr>
              }
            >
              {integrations.map((i) => (
                <tr key={i.name}>
                  <td>{i.display_name}</td>
                  <td>
                    <Badge variant={i.enabled ? "green" : "neutral"}>{i.enabled ? "Enabled" : "Disabled"}</Badge>
                  </td>
                  <td>
                    {i.enabled ? (
                      <Button
                        variant="danger"
                        size="sm"
                        aria-label={`Disable ${i.display_name}`}
                        onClick={() => setConfirm(i)}
                      >
                        Disable
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Enable ${i.display_name}`}
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate({ name: i.name, enabled: true })}
                      >
                        Enable
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </CardBody>
      </Box>

      {data && <CustomAppsPolicy policy={data.custom_apps_policy} onSaved={refresh} onError={onError} />}

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Disable integration"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={toggle.isPending}
              onClick={() => confirm && toggle.mutate({ name: confirm.name, enabled: false })}
            >
              Disable
            </Button>
          </>
        }
      >
        <p>
          Disable {confirm?.display_name} for every user? Its tools disappear from search and execution and it can't be
          connected. Existing connections are kept, and enabling it again restores everything. Other workers pick the
          change up within a few seconds.
        </p>
      </Modal>
    </div>
  );
}

function CustomAppsPolicy({
  policy,
  onSaved,
  onError,
}: {
  policy: Policy;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [mode, setMode] = useState<Policy["mode"]>(policy.mode);
  const [userIds, setUserIds] = useState<string[]>(policy.user_ids);
  const [saved, setSaved] = useState(false);

  // Follow the server's copy after a save or a refetch.
  useEffect(() => {
    setMode(policy.mode);
    setUserIds(policy.user_ids);
  }, [policy.mode, policy.user_ids]);

  const { data: users } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: fetchAdminUsers,
    staleTime: ADMIN_STALE_MS,
    enabled: mode === "allowlist",
  });

  const save = useMutation({
    mutationFn: (p: Policy) => setAdminCustomAppsPolicy(p),
    onSuccess: () => {
      setSaved(true);
      onSaved();
    },
    onError,
  });

  const next: Policy = { mode, user_ids: mode === "allowlist" ? userIds : [] };
  const changed =
    next.mode !== policy.mode ||
    next.user_ids.length !== policy.user_ids.length ||
    next.user_ids.some((id) => !policy.user_ids.includes(id));

  function toggleUser(id: string) {
    setSaved(false);
    setUserIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  return (
    <Box title="Custom apps">
      <BoxRow>
        <label htmlFor="admin-custom-apps-mode">Who can add custom apps</label>
        <Select
          id="admin-custom-apps-mode"
          value={mode}
          onChange={(e) => {
            setSaved(false);
            setMode(e.target.value as Policy["mode"]);
          }}
        >
          <option value="all">Everyone</option>
          <option value="none">No one</option>
          <option value="allowlist">Only selected users</option>
        </Select>
      </BoxRow>

      {mode === "allowlist" && (
        <BoxRow>
          <fieldset>
            <legend className="ui-sr-only">Users who can add custom apps</legend>
            {(users?.users ?? []).map((u) => (
              <label key={u.id} className="wb-toolbar-form">
                <input type="checkbox" checked={userIds.includes(u.id)} onChange={() => toggleUser(u.id)} />
                {u.email ?? u.id}
              </label>
            ))}
          </fieldset>
        </BoxRow>
      )}

      <BoxRow>
        <Button disabled={!changed || save.isPending} onClick={() => save.mutate(next)}>
          Save policy
        </Button>
        {saved && !changed && <span role="status">Saved.</span>}
        <p className="ui-stat-note">
          Excluded users keep their existing apps but agents stop seeing their tools. Other workers pick the change up
          within a few seconds.
        </p>
      </BoxRow>
    </Box>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the whole portal suite and a build**

Run: `cd packages/portal && npm run test`
Expected: PASS.

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add packages/portal/src
git commit -m "feat(admin): config tab and custom-app gating in the Apps page"
```

---

### Task 11: Docs and finding

**Files:**
- Modify: `docs/site/_content/deploy/admin.md`, `docs/site/_content/reference/http-api.md`, `docs/site/_content/reference/environment.md`, `docs/site/_content/reference/database-schema.md`, `CLAUDE.md`
- Create: `docs/findings/2026-10-01-admin-users-config.md`

- [ ] **Step 1: HTTP API rows**

In `http-api.md`, add after the `/api/admin/overview/browser-profiles` row:

```
| GET | `/api/admin/users` | session only, admin | — | `{ users: [{ id, email, created_at, disabled_at, has_api_key, connection_count, custom_app_count, last_activity }], total }` | 401, 403 |
| POST | `/api/admin/users/:id/disable` | session only, admin | — | `{ ok: true }` | 400 `cannot_disable_self` / `cannot_disable_admin`, 401, 403, 404 |
| POST | `/api/admin/users/:id/enable` | session only, admin | — | `{ ok: true }` | 401, 403, 404 |
| POST | `/api/admin/users/:id/revoke-key` | session only, admin | — | `{ ok: true }` | 401, 403, 404 |
| GET | `/api/admin/config` | session only, admin | — | `{ integrations: [{ name, display_name, enabled }], custom_apps_policy }` | 401, 403 |
| PUT | `/api/admin/config/integrations/:name` | session only, admin | `{ enabled: boolean }` | `{ ok: true }` | 400, 401, 403, 404 `unknown_integration` |
| PUT | `/api/admin/config/custom-apps` | session only, admin | `{ mode: "all" \| "none" \| "allowlist", user_ids? }` | `{ ok: true }` | 400 `invalid_policy` / `unknown_user`, 401, 403 |
```

and change the `/api/auth/me` row's response to `{ id, email, isAdmin, canCreateCustomApps }`.

- [ ] **Step 2: Environment variable**

In `environment.md`, in the **Core** table, add:

```
| `INSTANCE_SETTINGS_POLL_SECONDS` | positive integer | `5` | no | How often each process re-reads admin-set instance settings (disabled integrations, custom-app policy). A change made through one process applies there immediately; other workers and pods pick it up within this many seconds |
```

- [ ] **Step 3: Database schema**

Read `docs/site/_content/reference/database-schema.md`. In its `users` table section add a row `| disabled_at | INTEGER | Nullable. Unix seconds when an admin disabled the account; NULL when active | — |` (match the file's existing column format), and add a short section for `instance_settings` with columns `key` (TEXT, primary key), `value` (TEXT, JSON), `updated_at` (INTEGER), `updated_by` (TEXT) in the same style, noting the two keys it holds: `disabled_integrations` (JSON array of integration names) and `custom_apps_policy` (JSON `{mode, user_ids}`). If the file has an ER diagram block, add `instance_settings` and `disabled_at` there too.

- [ ] **Step 4: Admin guide**

In `admin.md`, after the Overview section and before the closing warning, add:

```
## Managing users

The **Users** tab lists every user with their connection and custom-app counts, last activity, whether they have an API key, and whether they are disabled.

- **Disable** signs the user out of the portal and stops every credential: their API key, OAuth logins and refresh tokens, and new SSO sign-ins. Their connections, vault and files are kept, so **Enable** restores the account. Disabling asks for confirmation.
- **Revoke key** clears the user's API key; agents using it stop working until they create a new one.
- You cannot disable yourself or any email on `ADMIN_EMAILS`. Admins are managed by that variable, not here, and this also stops an admin locking everyone out.
- Every action is written to the audit log with your account as the actor.

## Instance config

The **Config** tab holds two instance-wide settings:

- **Integrations:** turn an integration off for every user. It disappears from tool search, schema lookup and execution, the REST endpoint and the connect flow. Existing connections are kept, and turning it back on restores everything.
- **Custom apps:** choose who can add custom apps: everyone, no one, or selected users. Excluded users keep their existing apps, but agents stop seeing those apps' tools.

Changes apply at once in the process that handled the request. Other workers and pods pick them up within `INSTANCE_SETTINGS_POLL_SECONDS` (default 5), so allow that long before assuming a change is everywhere. OAuth client secrets are not editable here; they stay in environment variables.
```

and change the closing warning's last sentence to: "List only people you would trust with that, and with disabling accounts and turning integrations off."

- [ ] **Step 5: Finding and index**

Create `docs/findings/2026-10-01-admin-users-config.md`:

```
# Admin users and config

- "Disabled" is enforced inside the credential verifiers (`verifyApiKey`,
  `verifySession`, `verifyAccessToken`, `verifyCurlToken`) rather than at each of
  their call sites, because every call site goes through one of them: a new
  consumer cannot forget the check. Credential issuance is checked separately,
  because it does not pass through a verifier: both SSO callbacks and both OAuth
  `/token` grants refuse a disabled user. Disabling also deletes the user's
  refresh tokens, so a token they already hold cannot mint a new access token.
- A user with no row is not "disabled": `isUserDisabled` is true only for a row
  with `disabled_at` set, so tokens signed for ids the table has never seen keep
  working as before.
- `disabled_at` is a nullable timestamp, not a BOOLEAN, so it avoids the
  PostgreSQL 1/0 trap, and it records when the account was disabled.
- An admin cannot disable themselves or any email on `ADMIN_EMAILS`. Admins come
  from the env var, so this also prevents locking every admin out.
- `Registry` takes an injected `isDisabled` predicate and filters `getTool`,
  `getIntegration`, `listTools`, `listIntegrations`, `listToolsByIntegration` and
  `searchTools`. About 25 call sites read those, so filtering there beats
  patching each. The maps are private, so nothing can bypass it.
  `listAllIntegrations` is the one unfiltered view, for the admin Config tab.
- Instance settings are read from an in-memory snapshot (the registry and the
  request path are synchronous), replaced whole on every write and by a poll
  (`INSTANCE_SETTINGS_POLL_SECONDS`, default 5). Other workers and pods lag by at
  most that interval. A corrupt stored value falls back to the default for its
  key; it never throws and never disables anything.
- `disabled_integrations` is one JSON list updated read-modify-write, so two
  admins toggling different integrations within the poll interval through
  different workers can lose one update (last write wins). Admin config changes
  are rare and human-driven; per-integration rows would remove the race if it
  ever matters.
- The custom-app policy check runs before the cached index lookup in
  `ensureIndex`, so a policy change does not wait for the cache to expire, and
  `POST /api/custom-apps` refuses before it does any network discovery.
- A bodyless `POST` from the portal must not send `Content-Type: application/json`
  (the 2026-06-10 finding), so the disable, enable and revoke calls use the
  auth-only header helper.
- In a vitest `beforeEach`, `() => mock.mockReset()` returns the mock and vitest
  runs it as a teardown call; use a block body (the 2026-09-28 note).
```

Append to the Findings Index in `CLAUDE.md`:

```
- [2026-10-01 admin users and config](docs/findings/2026-10-01-admin-users-config.md) — "disabled" is enforced inside the credential verifiers and at credential issuance (both SSO callbacks, both OAuth grants) so no call site can skip it; a user with no row is not disabled; `Registry` filters through an injected predicate so one setting hides an integration from all ~25 lookups; instance settings are an in-memory snapshot refreshed on write and by a short poll, so other workers lag by up to `INSTANCE_SETTINGS_POLL_SECONDS`
```

- [ ] **Step 6: Build the docs and scan**

Run: `node docs/site/build.mjs`
Expected: completes, no broken-link error.

Run: `git add docs CLAUDE.md && git diff --cached | grep -inIE '@(icloud|gmail)\.com|<real-name>|<company>'`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git commit -m "docs(admin): users and config guide, api rows, schema, finding"
```

---

## Final verification

- [ ] Run: `npm run test` and `npm run build`. Expected: all green.
- [ ] Rebuild the local container and, signed in as an admin: open **Admin > Users**, disable another test user and confirm their API key now gets 401 on `/mcp`; enable them and confirm it works again.
- [ ] **Admin > Config:** disable an integration, confirm it vanishes from **Apps** and from `search_tools`; re-enable it. Set the custom-app policy to "No one" and confirm **New custom app** disappears for a signed-in user.
- [ ] Release: this PR carries two schema changes and a Dockerfile change on top of auth, so it ships as `vX.Y.Z-rc.N` with a hand-written `docs/releases/<stable-tag>.md` (use the `release-prep` skill). Not part of this plan.
