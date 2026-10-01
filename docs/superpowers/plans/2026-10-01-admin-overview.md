# Admin Overview (visibility) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the Admin page's Overview tab with five read-only cards (Instance, Activity across all users, Connections by integration, Custom apps, Browser profiles), each backed by its own `/api/admin/overview/*` endpoint.

**Architecture:** Each card has one endpoint and one React component with its own loading, empty and error states, so a slow or failing card never blanks the page. Server handlers live in small modules under `packages/server/src/admin/` that take plain inputs and return plain data; `api/admin-routes.ts` only wires them into the gated scope from sub-project 1. The gate moves into `api/admin-scope.ts` (no DB imports) so gate tests do not drag in the database.

**Tech Stack:** TypeScript, Fastify 5, SQLite/PostgreSQL via the `db` adapter, vitest, React + TanStack Query v5, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-01-admin-page-design.md` (section 2, "B: visibility"). Builds on sub-project 1 (`docs/superpowers/plans/2026-10-01-admin-gate-and-shell.md`, PR #129).

**Branch:** work on `feat/admin-overview`, cut from `worktree-admin-page` while PR #129 is unmerged. Open its PR against `worktree-admin-page`, or against `main` after #129 merges (then rebase).

## Global Constraints

- Read-only. No DDL, no writes, no schema changes.
- Every `/api/admin/*` route is registered through `adminScope` (session-JWT-only gate). Never register an admin route on the bare app.
- No secrets in any response: no tokens, no `client_secret_enc`, no `client_id`, no `api_key_*`, no admin emails, no filesystem paths.
- PostgreSQL parity: keyset paging stays the longhand `created_at < ? OR (created_at = ? AND id < ?)`; boolean params are real booleans; `?` appears only as a placeholder, never inside a string literal; no row-value comparisons.
- Audit events for non-sqlite `AUDIT_LOG_DEST` are not in the DB: the activity endpoint returns `stored: false`, never an empty list that looks like "nothing happened".
- Portal tests run through `npm run test` in `packages/portal` (the script sets `NODE_OPTIONS=--no-experimental-webstorage`); a bare `npx vitest run` fails 7 unrelated tests on Node 25.
- Test fixtures use synthetic values only: `admin@example.com`, `dev@example.com`, `acme`, `demo-repo`, fake secrets like `gsecret`, `tok-abc`.
- No `Co-Authored-By` or "Generated with" trailer on any commit.

## Review Focus

- Activity paging across several rows that share one `created_at` second: no row skipped or duplicated between pages.
- Custom-apps and connections responses must not contain any stored secret even when the row has one (`client_secret_enc`, `access_token`).
- `needs_reconnect` counts only expired-with-no-refresh-token rows; a cookie or API-key connection with `expires_at` null, or an expired one that still has a refresh token, must not count.
- With `AUDIT_LOG_DEST` not `sqlite`, the Activity card must say events are not stored in the database, not "No tool calls recorded yet."
- Browser profiles: base dir missing, a profile dir that matches no user, and a profile with no use-marker files must each render without error and without leaking the base path.

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/src/version.ts` (create) | `readVersion()` that works in dev and in the Docker image |
| `Dockerfile` (modify) | ship root `package.json` so the version resolves in the image |
| `packages/server/src/custom-apps/client.ts` (modify) | reuse `readVersion` |
| `packages/server/src/api/admin-scope.ts` (create) | the gated scope (moved out of `admin-routes.ts`) |
| `packages/server/src/api/admin-routes.ts` (modify) | wires overview endpoints; `/ping` removed |
| `packages/server/src/admin/instance.ts` (create) | Instance card data |
| `packages/server/src/admin/activity.ts` (create) | Activity card data and query parsing |
| `packages/server/src/audit/query.ts` (modify) | `listAllAuditEvents` (cross-user, with email) |
| `packages/server/src/admin/connections.ts` (create) | Connections card data |
| `packages/server/src/admin/custom-apps.ts` (create) | Custom apps card data |
| `packages/server/src/admin/profiles.ts` (create) | Browser profiles card data (pure, injected inputs) |
| `packages/server/tests/*.test.ts` | one suite per concern, see tasks |
| `packages/portal/src/api.ts` (modify) | admin fetchers and types |
| `packages/portal/src/format.ts` (modify) | `formatBytes` |
| `packages/portal/src/test-utils.tsx` (create) | `renderWithClient` |
| `packages/portal/src/components/admin/*.tsx` (create) | `CardBody`, five cards, `OverviewTab` |
| `packages/portal/src/pages/Admin.tsx` (modify) | renders `OverviewTab` |
| docs, findings, `CLAUDE.md` (modify/create) | docs |

---

### Task 1: A version reader that works in the Docker image

**Why first:** the Instance card shows the version. The current reader in `custom-apps/client.ts` resolves `../../../../package.json`, which inside the image (`/app/server/custom-apps`) is `/package.json`, and the image ships no `package.json` at all, so it returns `0.0.0`.

**Files:**
- Create: `packages/server/src/version.ts`
- Modify: `packages/server/src/custom-apps/client.ts`, `Dockerfile`
- Test: `packages/server/tests/version.test.ts`

**Interfaces:**
- Produces: `readVersion(baseDir?: string, candidates?: string[]): string` (default `baseDir` is the module's own `__dirname`; falls back to `"0.0.0"`).

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/version.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readVersion } from "../src/version";

const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "version-"));
  dirs.push(d);
  return d;
}

function write(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readVersion", () => {
  it("dev layout: takes the repo-root version, not packages/server's own", () => {
    const d = scratch();
    write(join(d, "package.json"), JSON.stringify({ version: "1.2.3" }));
    write(join(d, "packages/server/package.json"), JSON.stringify({ version: "0.0.1" }));
    expect(readVersion(join(d, "packages/server/src"))).toBe("1.2.3");
  });

  it("image layout: finds package.json beside the flattened server dir", () => {
    const d = scratch();
    write(join(d, "x/app/package.json"), JSON.stringify({ version: "2.0.0" }));
    expect(readVersion(join(d, "x/app/server"))).toBe("2.0.0");
  });

  it("falls through a candidate that has no version", () => {
    const d = scratch();
    write(join(d, "package.json"), JSON.stringify({ name: "no-version" }));
    write(join(d, "x/app/package.json"), JSON.stringify({ version: "3.1.4" }));
    expect(readVersion(join(d, "x/app/server"))).toBe("3.1.4");
  });

  it("falls through a candidate that is not valid JSON", () => {
    const d = scratch();
    write(join(d, "package.json"), "not json");
    write(join(d, "x/app/package.json"), JSON.stringify({ version: "3.1.5" }));
    expect(readVersion(join(d, "x/app/server"))).toBe("3.1.5");
  });

  it('returns "0.0.0" when no candidate exists', () => {
    const d = scratch();
    mkdirSync(join(d, "a/b/c"), { recursive: true });
    expect(readVersion(join(d, "a/b/c"))).toBe("0.0.0");
  });

  it("reads the real repo root by default", () => {
    const rootPkg = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const expected = (JSON.parse(readFileSync(rootPkg, "utf8")) as { version: string }).version;
    expect(readVersion()).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/version.test.ts`
Expected: FAIL (`../src/version` not found).

- [ ] **Step 3: Implement**

Create `packages/server/src/version.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Where the repo-root package.json sits relative to this file depends on the
// layout. From src/ or dist/ in a checkout it is three levels up. The Docker
// image ships the compiled server flattened at /app/server with package.json
// beside it at /app, one level up. Order matters: from src/, "../package.json"
// is packages/server's own (stale) version, so the root candidate must win there.
const CANDIDATES = ["../../../package.json", "../package.json"];

export function readVersion(baseDir: string = __dirname, candidates: string[] = CANDIDATES): string {
  for (const rel of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(baseDir, rel), "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      /* try the next layout */
    }
  }
  return "0.0.0";
}
```

In `packages/server/src/custom-apps/client.ts`, delete the local `readVersion` function (the block starting `// Identifies workbench to the remote MCP server` through its closing brace), add `import { readVersion } from "../version";` with the other imports, and keep the existing `const CLIENT_INFO = { name: "workbench", version: readVersion() };` line. Then run `grep -n "readFileSync\|join(" packages/server/src/custom-apps/client.ts` and remove any import name from the `node:fs` / `node:path` imports that now has zero uses.

In `Dockerfile`, directly after the line `COPY --from=builder /app/packages/server/dist ./server`, add:

```
# The version shown on the admin Overview, and sent to custom MCP servers, is
# read from the root package.json. Nothing else in the image carries it.
COPY --from=builder /app/package.json ./package.json
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/version.test.ts tests/custom-apps.test.ts`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: success (catches an unused-import error in `client.ts`).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/version.ts packages/server/src/custom-apps/client.ts Dockerfile packages/server/tests/version.test.ts
git commit -m "fix(version): read the version in the docker image, not just a checkout"
```

---

### Task 2: Move the gate out, add the Instance endpoint, drop `/ping`

**Files:**
- Create: `packages/server/src/api/admin-scope.ts`, `packages/server/src/admin/instance.ts`, `packages/server/tests/admin-overview.test.ts`
- Modify: `packages/server/src/api/admin-routes.ts`, `packages/server/tests/admin-routes.test.ts`

**Interfaces:**
- Consumes: `resolveAdmin` (sub-project 1); `readVersion` (Task 1); `auditStored` from `audit/query`.
- Produces:
  ```ts
  // api/admin-scope.ts
  export function adminScope(app: FastifyInstance, setup: (scope: FastifyInstance) => Promise<void> | void): Promise<void>;
  // admin/instance.ts
  export interface InstanceInfo {
    version: string;
    db_backend: "sqlite" | "postgres";
    cluster_enabled: boolean;
    audit_log_dest: "sqlite" | "stdout" | "kafka";
    audit_stored: boolean;
    user_count: number;
    admin_count: number;
  }
  export function getInstanceInfo(): Promise<InstanceInfo>;
  ```
  Route: `GET /api/admin/overview/instance`. `adminScopeForTest` and `GET /api/admin/ping` are removed.

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/admin-overview.test.ts` (shared scaffolding; later tasks append to it):

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

vi.mock("../src/auth/users", () => ({
  verifyApiKey: vi.fn(async () => null),
  getUserById: vi.fn(async (id: string) => {
    if (id === "user-admin") return { id, email: "admin@example.com" };
    if (id === "user-dev") return { id, email: "dev@example.com" };
    return null;
  }),
}));

import { registerAdminRoutes } from "../src/api/admin-routes";
import { config } from "../src/config";
import { db } from "../src/db";

const ADMIN = { authorization: "Bearer admin-jwt" };
const DEV = { authorization: "Bearer dev-jwt" };

async function get(url: string, headers: Record<string, string> = ADMIN) {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app.inject({ method: "GET", url, headers });
}

async function seedUser(id: string, email: string | null) {
  await db.run("INSERT INTO users (id, email) VALUES (?, ?)", [id, email]);
}

beforeEach(async () => {
  for (const t of ["audit_log", "connections", "custom_apps", "users"]) {
    await db.exec(`DELETE FROM ${t}`);
  }
  config.ADMIN_EMAILS = ["admin@example.com"];
  config.AUDIT_LOG_DEST = "sqlite";
  config.CLUSTER_ENABLED = false;
});

// Every overview endpoint is listed here so the gate is asserted for each.
const OVERVIEW_URLS = ["/api/admin/overview/instance"];

describe.each(OVERVIEW_URLS)("%s gate", (url) => {
  it("401 without a session", async () => {
    const res = await get(url, {});
    expect(res.statusCode).toBe(401);
  });

  it("403 for a signed-in non-admin", async () => {
    const res = await get(url, DEV);
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/admin/overview/instance", () => {
  it("reports version, backend, cluster flag, audit destination and counts", async () => {
    await seedUser("user-admin", "admin@example.com");
    await seedUser("user-dev", "dev@example.com");
    const res = await get("/api/admin/overview/instance");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      db_backend: "sqlite",
      cluster_enabled: false,
      audit_log_dest: "sqlite",
      audit_stored: true,
      user_count: 2,
      admin_count: 1,
    });
  });

  it("reports audit_stored false when events go elsewhere", async () => {
    config.AUDIT_LOG_DEST = "stdout";
    const body = JSON.parse((await get("/api/admin/overview/instance")).body);
    expect(body.audit_log_dest).toBe("stdout");
    expect(body.audit_stored).toBe(false);
  });

  it("reports the cluster flag", async () => {
    config.CLUSTER_ENABLED = true;
    const body = JSON.parse((await get("/api/admin/overview/instance")).body);
    expect(body.cluster_enabled).toBe(true);
  });

  it("counts admins but never reveals their emails", async () => {
    const res = await get("/api/admin/overview/instance");
    expect(JSON.parse(res.body).admin_count).toBe(1);
    expect(res.body).not.toContain("admin@example.com");
  });
});
```

Also edit `packages/server/tests/admin-routes.test.ts` so the gate tests no longer depend on `/ping` or on `admin-routes`:

- Replace `import { registerAdminRoutes } from "../src/api/admin-routes";` with `import { adminScope } from "../src/api/admin-scope";`.
- Replace `buildApp` with:

```ts
async function buildApp() {
  const app = Fastify();
  await adminScope(app, (scope) => {
    scope.get("/probe", async () => ({ ok: true }));
  });
  return app;
}
```

- In the `ping` helper change `url: "/api/admin/ping"` to `url: "/api/admin/probe"`.
- In the test `"a rejected request still reaches root onRequest hooks registered after the scope"` replace `await registerAdminRoutes(app);` with `await adminScope(app, (scope) => { scope.get("/probe", async () => ({ ok: true })); });`.
- In the test `"gates a route added later in the same scope without it opting in"` delete the line `const { adminScopeForTest } = await import("../src/api/admin-routes");` and call `adminScope(app, ...)` instead of `adminScopeForTest(app, ...)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-overview.test.ts tests/admin-routes.test.ts`
Expected: FAIL (`../src/api/admin-scope` not found; instance route 404).

- [ ] **Step 3: Implement**

Create `packages/server/src/api/admin-scope.ts` by moving `adminScope` and its comment out of `admin-routes.ts` unchanged:

```ts
import type { FastifyInstance } from "fastify";
import { resolveAdmin } from "../auth/admin";

type ScopeSetup = (scope: FastifyInstance) => Promise<void> | void;

// Everything under /api/admin lives in one encapsulated scope whose hook runs
// the gate. A route registered inside it cannot forget to check: there is no
// per-route opt-in to miss.
//
// preHandler, not onRequest: every onRequest hook, including root ones added
// after this scope (the HTTP metrics timer), runs before any preHandler. An
// onRequest gate that replies would short-circuit those, and rejected admin
// requests would drop out of the metrics.
//
// Kept apart from admin-routes.ts so gate tests do not import the database.
export async function adminScope(app: FastifyInstance, setup: ScopeSetup): Promise<void> {
  await app.register(
    async (scope) => {
      scope.addHook("preHandler", async (request, reply) => {
        const admin = await resolveAdmin(request);
        if (!admin.ok) {
          return reply
            .status(admin.status)
            .send({ error: admin.status === 401 ? "Unauthorized" : "Forbidden" });
        }
      });
      await setup(scope);
    },
    { prefix: "/api/admin" }
  );
}
```

Create `packages/server/src/admin/instance.ts`:

```ts
import { config } from "../config";
import { db } from "../db";
import { auditStored } from "../audit/query";
import { readVersion } from "../version";

export interface InstanceInfo {
  version: string;
  db_backend: "sqlite" | "postgres";
  cluster_enabled: boolean;
  audit_log_dest: "sqlite" | "stdout" | "kafka";
  audit_stored: boolean;
  user_count: number;
  admin_count: number;
}

const VERSION = readVersion();

export async function getInstanceInfo(): Promise<InstanceInfo> {
  const row = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM users");
  return {
    version: VERSION,
    db_backend: db.dialect,
    cluster_enabled: !!config.CLUSTER_ENABLED,
    audit_log_dest: config.AUDIT_LOG_DEST,
    audit_stored: auditStored(),
    user_count: Number(row?.n ?? 0),
    // A count, not the list: the allowlist is not for display.
    admin_count: (config.ADMIN_EMAILS ?? []).length,
  };
}
```

Replace the whole of `packages/server/src/api/admin-routes.ts` with:

```ts
import type { FastifyInstance } from "fastify";
import { adminScope } from "./admin-scope";
import { getInstanceInfo } from "../admin/instance";

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await adminScope(app, (scope) => {
    scope.get("/overview/instance", async () => getInstanceInfo());
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-overview.test.ts tests/admin-routes.test.ts tests/admin-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api packages/server/src/admin packages/server/tests/admin-overview.test.ts packages/server/tests/admin-routes.test.ts
git commit -m "feat(admin): instance overview endpoint; gate in its own module"
```

---

### Task 3: Activity across all users

**Files:**
- Modify: `packages/server/src/audit/query.ts`, `packages/server/src/api/admin-routes.ts`, `packages/server/tests/admin-overview.test.ts`
- Create: `packages/server/src/admin/activity.ts`

**Interfaces:**
- Consumes: `auditStored`, `encodeCursor`, `decodeCursor`, `AuditEventRow`, `normalize` (module-private, same file) from `audit/query`.
- Produces:
  ```ts
  // audit/query.ts
  export interface AdminAuditEventRow extends AuditEventRow { user_id: string; user_email: string | null }
  export interface ListAllAuditOptions {
    limit: number;
    cursor?: { createdAt: number; id: number };
    integration?: string;
    status?: "success" | "error";
    email?: string; // exact, case-insensitive
  }
  export function listAllAuditEvents(o: ListAllAuditOptions): Promise<AdminAuditEventRow[]>;
  // admin/activity.ts
  export type AdminActivityResult =
    | { ok: true; page: { stored: boolean; events: AdminAuditEventRow[]; next_cursor: string | null } }
    | { ok: false; error: "invalid_cursor" };
  export function adminActivity(raw: Record<string, string | string[] | undefined>): Promise<AdminActivityResult>;
  ```
  Route: `GET /api/admin/overview/activity?limit&cursor&integration&status&email`.

- [ ] **Step 1: Write the failing tests**

In `packages/server/tests/admin-overview.test.ts`: add `"/api/admin/overview/activity"` to `OVERVIEW_URLS`, add the helper below after `seedUser`, and append the `describe` at the end of the file.

```ts
const NOW = Math.floor(Date.now() / 1000);

async function seedEvent(o: {
  userId: string;
  integration?: string;
  tool?: string;
  success?: boolean;
  createdAt?: number;
}) {
  await db.run(
    `INSERT INTO audit_log (user_id, integration, tool, action, success, error, duration_ms, created_at)
     VALUES (?, ?, ?, 'EXECUTE', ?, NULL, 100, ?)`,
    [o.userId, o.integration ?? "acme", o.tool ?? "acme_search", o.success ?? true, o.createdAt ?? NOW]
  );
}
```

```ts
describe("GET /api/admin/overview/activity", () => {
  it("returns every user's events, newest first, with the user's email", async () => {
    await seedUser("user-admin", "admin@example.com");
    await seedUser("user-dev", "dev@example.com");
    await seedEvent({ userId: "user-admin", tool: "older", createdAt: NOW - 10 });
    await seedEvent({ userId: "user-dev", tool: "newer", createdAt: NOW });
    const body = JSON.parse((await get("/api/admin/overview/activity")).body);
    expect(body.stored).toBe(true);
    expect(body.events.map((e: { tool: string }) => e.tool)).toEqual(["newer", "older"]);
    expect(body.events.map((e: { user_email: string }) => e.user_email)).toEqual([
      "dev@example.com",
      "admin@example.com",
    ]);
    expect(body.next_cursor).toBeNull();
  });

  it("gives a null email for an event whose user row is gone", async () => {
    await seedEvent({ userId: "user-ghost" });
    const body = JSON.parse((await get("/api/admin/overview/activity")).body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].user_id).toBe("user-ghost");
    expect(body.events[0].user_email).toBeNull();
  });

  it("filters by user email, case-insensitively", async () => {
    await seedUser("user-admin", "admin@example.com");
    await seedUser("user-dev", "dev@example.com");
    await seedEvent({ userId: "user-admin", tool: "a" });
    await seedEvent({ userId: "user-dev", tool: "d" });
    const body = JSON.parse((await get("/api/admin/overview/activity?email=DEV@Example.com")).body);
    expect(body.events.map((e: { tool: string }) => e.tool)).toEqual(["d"]);
  });

  it("filters by integration and by status", async () => {
    await seedUser("user-dev", "dev@example.com");
    await seedEvent({ userId: "user-dev", integration: "acme", tool: "ok_tool", success: true });
    await seedEvent({ userId: "user-dev", integration: "demo-repo", tool: "bad_tool", success: false });
    const byInteg = JSON.parse((await get("/api/admin/overview/activity?integration=demo-repo")).body);
    expect(byInteg.events.map((e: { tool: string }) => e.tool)).toEqual(["bad_tool"]);
    const byStatus = JSON.parse((await get("/api/admin/overview/activity?status=error")).body);
    expect(byStatus.events.map((e: { tool: string }) => e.tool)).toEqual(["bad_tool"]);
  });

  it("says events are not stored when the audit destination is not sqlite", async () => {
    config.AUDIT_LOG_DEST = "stdout";
    await seedEvent({ userId: "user-dev" });
    const body = JSON.parse((await get("/api/admin/overview/activity")).body);
    expect(body).toEqual({ stored: false, events: [], next_cursor: null });
  });

  it("pages across rows sharing one second without skipping or repeating any", async () => {
    for (const tool of ["a", "b", "c"]) await seedEvent({ userId: "user-dev", tool, createdAt: NOW });
    const first = JSON.parse((await get("/api/admin/overview/activity?limit=2")).body);
    expect(first.events).toHaveLength(2);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = JSON.parse(
      (await get(`/api/admin/overview/activity?limit=2&cursor=${first.next_cursor}`)).body
    );
    expect(second.events).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    const ids = [...first.events, ...second.events].map((e: { id: number }) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("rejects a cursor it did not mint", async () => {
    const res = await get("/api/admin/overview/activity?cursor=not-a-cursor");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_cursor" });
  });

  it("clamps the page size to at least one row", async () => {
    await seedEvent({ userId: "user-dev", tool: "a", createdAt: NOW });
    await seedEvent({ userId: "user-dev", tool: "b", createdAt: NOW - 1 });
    const body = JSON.parse((await get("/api/admin/overview/activity?limit=0")).body);
    expect(body.events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-overview.test.ts`
Expected: FAIL (activity route 404; gate tests for the new URL return 404).

- [ ] **Step 3: Implement the query**

Append to `packages/server/src/audit/query.ts`:

```ts
export interface AdminAuditEventRow extends AuditEventRow {
  user_id: string;
  user_email: string | null;
}

export interface ListAllAuditOptions {
  limit: number;
  cursor?: { createdAt: number; id: number };
  integration?: string;
  status?: "success" | "error";
  /** Exact match on the user's email, case-insensitive. */
  email?: string;
}

/**
 * Every user's events, newest first, each with its owner's email. LEFT JOIN so
 * an event whose user row is gone still appears, with a null email. Keyset
 * paging uses the same longhand predicate as listAuditEvents: the two backends
 * do not agree on a row-value comparison.
 */
export async function listAllAuditEvents(o: ListAllAuditOptions): Promise<AdminAuditEventRow[]> {
  const where: string[] = [];
  const params: SqlParam[] = [];

  if (o.integration) {
    where.push("a.integration = ?");
    params.push(o.integration);
  }
  if (o.status) {
    where.push("a.success = ?");
    params.push(o.status === "success");
  }
  if (o.email) {
    where.push("LOWER(u.email) = ?");
    params.push(o.email.trim().toLowerCase());
  }
  if (o.cursor) {
    where.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
    params.push(o.cursor.createdAt, o.cursor.createdAt, o.cursor.id);
  }
  params.push(o.limit);

  const rows = await db.all<Record<string, unknown>>(
    `SELECT a.id, a.user_id, u.email AS user_email, a.integration, a.tool, a.action,
            a.success, a.error, a.duration_ms, a.created_at
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    params
  );
  return rows.map((r) => ({
    ...normalize(r),
    user_id: String(r.user_id),
    user_email: (r.user_email as string | null) ?? null,
  }));
}
```

- [ ] **Step 4: Implement the handler and route**

Create `packages/server/src/admin/activity.ts`:

```ts
import {
  auditStored,
  decodeCursor,
  encodeCursor,
  listAllAuditEvents,
  type AdminAuditEventRow,
} from "../audit/query";

type Raw = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export type AdminActivityResult =
  | { ok: true; page: { stored: boolean; events: AdminAuditEventRow[]; next_cursor: string | null } }
  | { ok: false; error: "invalid_cursor" };

export async function adminActivity(raw: Raw): Promise<AdminActivityResult> {
  // stdout and kafka write nothing to the table, so an empty list would read as
  // "nothing happened". Say so instead.
  if (!auditStored()) return { ok: true, page: { stored: false, events: [], next_cursor: null } };

  const rawLimit = first(raw.limit);
  const requested = Number(rawLimit);
  const limit =
    rawLimit === undefined || !Number.isFinite(requested)
      ? 50
      : Math.min(100, Math.max(1, Math.floor(requested)));

  let cursor: { createdAt: number; id: number } | undefined;
  const rawCursor = first(raw.cursor);
  if (rawCursor) {
    const decoded = decodeCursor(rawCursor);
    if (!decoded) return { ok: false, error: "invalid_cursor" };
    cursor = decoded;
  }

  const rawStatus = first(raw.status);
  const status = rawStatus === "success" || rawStatus === "error" ? rawStatus : undefined;

  // One extra row: its presence says another page exists, without a COUNT.
  const rows = await listAllAuditEvents({
    limit: limit + 1,
    cursor,
    integration: first(raw.integration),
    status,
    email: first(raw.email),
  });
  const events = rows.slice(0, limit);
  const last = events[events.length - 1];
  const next_cursor = rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null;
  return { ok: true, page: { stored: true, events, next_cursor } };
}
```

In `packages/server/src/api/admin-routes.ts` add `import { adminActivity } from "../admin/activity";` and inside the scope callback:

```ts
    scope.get("/overview/activity", async (request, reply) => {
      const result = await adminActivity(request.query as Record<string, string | string[] | undefined>);
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return result.page;
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-overview.test.ts tests/audit-query.test.ts tests/activity-routes.test.ts`
Expected: PASS (the per-user activity suites must stay green).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src packages/server/tests/admin-overview.test.ts
git commit -m "feat(admin): activity overview across all users"
```

---

### Task 4: Connections by integration and custom apps

**Files:**
- Create: `packages/server/src/admin/connections.ts`, `packages/server/src/admin/custom-apps.ts`
- Modify: `packages/server/src/api/admin-routes.ts`, `packages/server/tests/admin-overview.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // admin/connections.ts
  export interface ConnectionRow { integration: string; connected: number; needs_reconnect: number }
  export function getConnectionStats(nowSeconds?: number): Promise<{ integrations: ConnectionRow[] }>;
  // admin/custom-apps.ts
  export interface CustomAppRow { id: string; name: string; base_url: string; owner_email: string | null; created_at: number }
  export function listAllCustomApps(limit?: number): Promise<{ apps: CustomAppRow[]; total: number }>;
  ```
  Routes: `GET /api/admin/overview/connections`, `GET /api/admin/overview/custom-apps`.

- [ ] **Step 1: Write the failing tests**

In `packages/server/tests/admin-overview.test.ts` add `"/api/admin/overview/connections"` and `"/api/admin/overview/custom-apps"` to `OVERVIEW_URLS`, add these helpers after `seedEvent`, and append the two `describe` blocks.

```ts
async function seedConn(o: {
  userId: string;
  integration: string;
  expiresAt: number | null;
  refresh: boolean;
}) {
  await db.run(
    `INSERT INTO connections (user_id, integration, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [o.userId, o.integration, Buffer.from("tok-abc"), o.refresh ? Buffer.from("rtok-abc") : null, o.expiresAt]
  );
}

async function seedApp(o: { id: string; userId: string; name: string; url: string; createdAt: number }) {
  await db.run(
    `INSERT INTO custom_apps (id, user_id, name, base_url, metadata, client_id, client_secret_enc, created_at)
     VALUES (?, ?, ?, ?, '{}', 'cid-1', ?, ?)`,
    [o.id, o.userId, o.name, o.url, Buffer.from("gsecret-xyz"), o.createdAt]
  );
}
```

```ts
describe("GET /api/admin/overview/connections", () => {
  it("counts connected users per integration and those needing a reconnect", async () => {
    await seedConn({ userId: "u1", integration: "jira", expiresAt: NOW + 3600, refresh: true });
    await seedConn({ userId: "u2", integration: "jira", expiresAt: NOW - 10, refresh: false }); // needs reconnect
    await seedConn({ userId: "u3", integration: "jira", expiresAt: NOW - 10, refresh: true }); // can refresh
    await seedConn({ userId: "u1", integration: "slack", expiresAt: null, refresh: false }); // cookie / api key
    await seedConn({ userId: "u1", integration: "custom:abc", expiresAt: NOW - 10, refresh: false }); // custom app
    const res = await get("/api/admin/overview/connections");
    expect(JSON.parse(res.body)).toEqual({
      integrations: [
        { integration: "jira", connected: 3, needs_reconnect: 1 },
        { integration: "slack", connected: 1, needs_reconnect: 0 },
      ],
    });
    expect(res.body).not.toContain("tok-abc");
  });

  it("returns an empty list when nothing is connected", async () => {
    expect(JSON.parse((await get("/api/admin/overview/connections")).body)).toEqual({ integrations: [] });
  });
});

describe("GET /api/admin/overview/custom-apps", () => {
  it("lists apps across users with the owner's email, newest first, and no secrets", async () => {
    await seedUser("user-dev", "dev@example.com");
    await seedApp({ id: "app-1", userId: "user-dev", name: "older", url: "https://mcp.example.com/a", createdAt: NOW - 100 });
    await seedApp({ id: "app-2", userId: "user-dev", name: "newer", url: "https://mcp.example.com/b", createdAt: NOW });
    const res = await get("/api/admin/overview/custom-apps");
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.apps.map((a: { name: string }) => a.name)).toEqual(["newer", "older"]);
    expect(body.apps[0]).toEqual({
      id: "app-2",
      name: "newer",
      base_url: "https://mcp.example.com/b",
      owner_email: "dev@example.com",
      created_at: NOW,
    });
    expect(res.body).not.toContain("gsecret");
    expect(res.body).not.toContain("cid-1");
    expect(res.body).not.toContain("client_secret");
  });

  it("gives a null owner email when the owning user is gone", async () => {
    await seedApp({ id: "app-9", userId: "user-ghost", name: "orphan", url: "https://mcp.example.com/z", createdAt: NOW });
    const body = JSON.parse((await get("/api/admin/overview/custom-apps")).body);
    expect(body.apps[0].owner_email).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-overview.test.ts`
Expected: FAIL (both routes 404).

- [ ] **Step 3: Implement**

Create `packages/server/src/admin/connections.ts`:

```ts
import { db } from "../db";

export interface ConnectionRow {
  integration: string;
  connected: number;
  needs_reconnect: number;
}

/**
 * Connected-user counts per integration. `connections` records no refresh
 * failure, so "needs reconnect" means the access token has expired and there is
 * no refresh token to renew it. A cookie or API-key connection has a null
 * expires_at and never counts. Custom-app connections (`custom:<id>`) are
 * listed on their own card, so they are left out here.
 */
export async function getConnectionStats(
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ integrations: ConnectionRow[] }> {
  const rows = await db.all<{
    integration: string;
    connected: number | string;
    needs_reconnect: number | string | null;
  }>(
    `SELECT integration,
            COUNT(*) AS connected,
            SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ? AND refresh_token IS NULL
                     THEN 1 ELSE 0 END) AS needs_reconnect
       FROM connections
      WHERE integration NOT LIKE ?
      GROUP BY integration
      ORDER BY integration`,
    [nowSeconds, "custom:%"]
  );
  return {
    integrations: rows.map((r) => ({
      integration: r.integration,
      connected: Number(r.connected),
      needs_reconnect: Number(r.needs_reconnect ?? 0),
    })),
  };
}
```

Create `packages/server/src/admin/custom-apps.ts`:

```ts
import { db } from "../db";

export interface CustomAppRow {
  id: string;
  name: string;
  base_url: string;
  owner_email: string | null;
  created_at: number;
}

// Explicit column list, never SELECT *: client_id and client_secret_enc live on
// this table and must not reach a response.
export async function listAllCustomApps(limit = 200): Promise<{ apps: CustomAppRow[]; total: number }> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT a.id, a.name, a.base_url, a.created_at, u.email AS owner_email
       FROM custom_apps a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    [limit]
  );
  const count = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM custom_apps");
  return {
    apps: rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      base_url: String(r.base_url),
      owner_email: (r.owner_email as string | null) ?? null,
      created_at: Number(r.created_at),
    })),
    total: Number(count?.n ?? 0),
  };
}
```

In `packages/server/src/api/admin-routes.ts` add the two imports and routes:

```ts
import { getConnectionStats } from "../admin/connections";
import { listAllCustomApps } from "../admin/custom-apps";
```

```ts
    scope.get("/overview/connections", async () => getConnectionStats());
    scope.get("/overview/custom-apps", async () => listAllCustomApps());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-overview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/tests/admin-overview.test.ts
git commit -m "feat(admin): connections and custom-apps overview"
```

---

### Task 5: Browser profiles

**Files:**
- Create: `packages/server/src/admin/profiles.ts`, `packages/server/tests/admin-profiles.test.ts`
- Modify: `packages/server/src/api/admin-routes.ts`, `packages/server/tests/admin-overview.test.ts`

**Interfaces:**
- Consumes: `listProfileDirs`, `duBytes`, `profileLastUsed`, `LIVE_WINDOW_MS` from `reap/profiles`; `profilesBaseDir`, `profileDirName`, `activeProfiles` from `auth/profile-chromium`.
- Produces:
  ```ts
  // admin/profiles.ts
  export interface ProfileInfo { name: string; email: string | null; bytes: number; last_used: number | null; live: boolean }
  export function listBrowserProfiles(o: {
    baseDir: string;
    activeDirs: Iterable<string>;
    emailByDirName: Map<string, string | null>;
    now?: number; // ms
  }): Promise<ProfileInfo[]>;
  ```
  Route: `GET /api/admin/overview/browser-profiles` returns `{ profiles: ProfileInfo[]; this_worker_only: boolean }`.

- [ ] **Step 1: Write the failing unit test**

Create `packages/server/tests/admin-profiles.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBrowserProfiles } from "../src/admin/profiles";

const bases: string[] = [];

function makeBase(): string {
  const d = mkdtempSync(join(tmpdir(), "profiles-"));
  bases.push(d);
  return d;
}

// A profile whose Cookies use-marker has `bytes` bytes and was last written
// `ageMs` ago.
function makeProfile(base: string, name: string, bytes: number, ageMs: number) {
  const marker = join(base, name, "Default", "Cookies");
  mkdirSync(join(base, name, "Default"), { recursive: true });
  writeFileSync(marker, Buffer.alloc(bytes));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(marker, t, t);
}

afterEach(() => {
  for (const d of bases.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noEmails = new Map<string, string | null>();

describe("listBrowserProfiles", () => {
  it("sorts by size, largest first, and reports each profile's size", async () => {
    const base = makeBase();
    makeProfile(base, "small", 100, 0);
    makeProfile(base, "big", 300, 0);
    const out = await listBrowserProfiles({ baseDir: base, activeDirs: [], emailByDirName: noEmails });
    expect(out.map((p) => [p.name, p.bytes])).toEqual([
      ["big", 300],
      ["small", 100],
    ]);
  });

  it("marks a profile live when its use-marker moved recently, idle otherwise", async () => {
    const base = makeBase();
    makeProfile(base, "fresh", 10, 1000);
    makeProfile(base, "stale", 10, 2 * 86_400_000);
    const out = await listBrowserProfiles({ baseDir: base, activeDirs: [], emailByDirName: noEmails });
    const byName = Object.fromEntries(out.map((p) => [p.name, p]));
    expect(byName.fresh.live).toBe(true);
    expect(byName.stale.live).toBe(false);
    expect(byName.stale.last_used).toBeLessThan(Math.floor(Date.now() / 1000) - 86_400);
  });

  it("marks a profile live when this process holds it, whatever its marker age", async () => {
    const base = makeBase();
    makeProfile(base, "held", 10, 2 * 86_400_000);
    const out = await listBrowserProfiles({
      baseDir: base,
      activeDirs: [join(base, "held")],
      emailByDirName: noEmails,
    });
    expect(out[0].live).toBe(true);
  });

  it("maps a dir name to the user's email, and leaves unknown dirs null", async () => {
    const base = makeBase();
    makeProfile(base, "user-dev", 10, 0);
    makeProfile(base, "orphan", 5, 0);
    const out = await listBrowserProfiles({
      baseDir: base,
      activeDirs: [],
      emailByDirName: new Map([["user-dev", "dev@example.com"]]),
    });
    const byName = Object.fromEntries(out.map((p) => [p.name, p]));
    expect(byName["user-dev"].email).toBe("dev@example.com");
    expect(byName.orphan.email).toBeNull();
  });

  it("copes with a missing base dir", async () => {
    const out = await listBrowserProfiles({
      baseDir: join(makeBase(), "does-not-exist"),
      activeDirs: [],
      emailByDirName: noEmails,
    });
    expect(out).toEqual([]);
  });

  it("copes with a profile that has no use-marker files", async () => {
    const base = makeBase();
    mkdirSync(join(base, "bare"));
    const out = await listBrowserProfiles({ baseDir: base, activeDirs: [], emailByDirName: noEmails });
    expect(out).toHaveLength(1);
    expect(out[0].bytes).toBe(0);
    expect(out[0].live).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-profiles.test.ts`
Expected: FAIL (`../src/admin/profiles` not found).

- [ ] **Step 3: Implement the lister**

Create `packages/server/src/admin/profiles.ts`:

```ts
import { basename } from "node:path";
import { duBytes, listProfileDirs, profileLastUsed, LIVE_WINDOW_MS } from "../reap/profiles";

export interface ProfileInfo {
  name: string;
  email: string | null;
  bytes: number;
  /** Unix seconds, or null when no marker or directory time is available. */
  last_used: number | null;
  live: boolean;
}

/**
 * One row per profile directory under `baseDir`. Pure over its inputs so it can
 * be tested against a temp dir; the route supplies the live values. "Live" uses
 * the same rule as the reaper: this process holds it, or a use-marker moved
 * inside LIVE_WINDOW_MS.
 */
export async function listBrowserProfiles(o: {
  baseDir: string;
  activeDirs: Iterable<string>;
  emailByDirName: Map<string, string | null>;
  now?: number;
}): Promise<ProfileInfo[]> {
  const now = o.now ?? Date.now();
  const active = new Set(o.activeDirs);
  const out: ProfileInfo[] = [];

  for (const dir of await listProfileDirs(o.baseDir)) {
    const name = basename(dir);
    const lastUsedMs = await profileLastUsed(dir);
    out.push({
      name,
      email: o.emailByDirName.get(name) ?? null,
      bytes: await duBytes(dir),
      last_used: lastUsedMs > 0 ? Math.floor(lastUsedMs / 1000) : null,
      live: active.has(dir) || now - lastUsedMs < LIVE_WINDOW_MS,
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-profiles.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing route test**

In `packages/server/tests/admin-overview.test.ts`: add `"/api/admin/overview/browser-profiles"` to `OVERVIEW_URLS`; add this block right after the `vi.mock("../src/auth/users", ...)` block (before the imports):

```ts
const prof = vi.hoisted(() => ({ dir: "" }));

vi.mock("../src/auth/profile-chromium", () => ({
  profilesBaseDir: () => prof.dir,
  profileDirName: (u: string) => u.replace(/[^a-zA-Z0-9_-]/g, "_"),
  activeProfiles: new Set<string>(),
}));
```

add `import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";`, `import { tmpdir } from "node:os";` and `import { join } from "node:path";` with the other imports, add `prof.dir = mkdtempSync(join(tmpdir(), "overview-profiles-"));` as the first line of the existing `beforeEach`, and append:

```ts
describe("GET /api/admin/overview/browser-profiles", () => {
  it("lists profiles with the owner's email and size, without leaking the path", async () => {
    await seedUser("user-dev", "dev@example.com");
    mkdirSync(join(prof.dir, "user-dev", "Default"), { recursive: true });
    writeFileSync(join(prof.dir, "user-dev", "Default", "Cookies"), Buffer.alloc(10));
    const res = await get("/api/admin/overview/browser-profiles");
    const body = JSON.parse(res.body);
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]).toMatchObject({
      name: "user-dev",
      email: "dev@example.com",
      bytes: 10,
      live: true,
    });
    expect(body.this_worker_only).toBe(false);
    expect(res.body).not.toContain(prof.dir);
  });

  it("says this worker only when cluster mode is on", async () => {
    config.CLUSTER_ENABLED = true;
    const body = JSON.parse((await get("/api/admin/overview/browser-profiles")).body);
    expect(body.this_worker_only).toBe(true);
    expect(body.profiles).toEqual([]);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-overview.test.ts`
Expected: FAIL (route 404).

- [ ] **Step 7: Implement the route**

In `packages/server/src/api/admin-routes.ts` add:

```ts
import { join } from "node:path";
import { config } from "../config";
import { db } from "../db";
import { activeProfiles, profileDirName, profilesBaseDir } from "../auth/profile-chromium";
import { listBrowserProfiles } from "../admin/profiles";
```

and inside the scope callback:

```ts
    scope.get("/overview/browser-profiles", async () => {
      const base = profilesBaseDir();
      const users = await db.all<{ id: string; email: string | null }>("SELECT id, email FROM users");
      const emailByDirName = new Map(users.map((u) => [profileDirName(u.id), u.email ?? null]));
      const profiles = await listBrowserProfiles({
        baseDir: base,
        activeDirs: [...activeProfiles].map((userId) => join(base, profileDirName(userId))),
        emailByDirName,
      });
      // Under CLUSTER_ENABLED each process sees only its own volume.
      return { profiles, this_worker_only: !!config.CLUSTER_ENABLED };
    });
```

- [ ] **Step 8: Run tests, then the whole server suite**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-overview.test.ts tests/admin-profiles.test.ts && NODE_ENV=test npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src packages/server/tests
git commit -m "feat(admin): browser profiles overview"
```

---

### Task 6: Portal: fetchers, `formatBytes`, and the four simple cards

**Files:**
- Modify: `packages/portal/src/api.ts`, `packages/portal/src/format.ts`, `packages/portal/src/format.test.ts`, `packages/portal/src/pages/Admin.tsx`, `packages/portal/src/pages/Admin.test.tsx`
- Create: `packages/portal/src/test-utils.tsx`, `packages/portal/src/api.admin.test.ts`, `packages/portal/src/components/admin/{CardBody,InstanceCard,ConnectionsCard,CustomAppsCard,ProfilesCard,OverviewTab}.tsx` and a `.test.tsx` beside each card and `OverviewTab`.

**Interfaces:**
- Consumes: the five `/api/admin/overview/*` endpoints above; `Box`, `DataTable`, `EmptyState`, `Badge`.
- Produces: in `api.ts`:
  ```ts
  export interface AdminInstance { version: string; db_backend: "sqlite" | "postgres"; cluster_enabled: boolean; audit_log_dest: string; audit_stored: boolean; user_count: number; admin_count: number }
  export interface AdminActivityEvent extends ActivityEvent { user_id: string; user_email: string | null }
  export interface AdminActivityPage { stored: boolean; events: AdminActivityEvent[]; next_cursor: string | null }
  export interface AdminConnectionRow { integration: string; connected: number; needs_reconnect: number }
  export interface AdminCustomApp { id: string; name: string; base_url: string; owner_email: string | null; created_at: number }
  export interface AdminProfile { name: string; email: string | null; bytes: number; last_used: number | null; live: boolean }
  export function fetchAdminInstance(): Promise<AdminInstance>;
  export function fetchAdminConnections(): Promise<{ integrations: AdminConnectionRow[] }>;
  export function fetchAdminCustomApps(): Promise<{ apps: AdminCustomApp[]; total: number }>;
  export function fetchAdminProfiles(): Promise<{ profiles: AdminProfile[]; this_worker_only: boolean }>;
  export function fetchAdminActivity(opts?: { limit?: number; cursor?: string; integration?: string; status?: "success" | "error"; email?: string }): Promise<AdminActivityPage>;
  ```
  in `format.ts`: `formatBytes(n: number): string`. In `components/admin/`: default exports `InstanceCard`, `ConnectionsCard`, `CustomAppsCard`, `ProfilesCard`, `OverviewTab`; named export `CardBody({ isLoading, isError, label, children })`.

- [ ] **Step 1: Write the failing tests**

`packages/portal/src/format.test.ts`: add `formatBytes` to the existing import from `./format` and append:

```ts
describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [150 * 1024 * 1024, "150 MB"],
    [3 * 1024 ** 3, "3.0 GB"],
  ])("formats %i as %s", (n, expected) => {
    expect(formatBytes(n)).toBe(expected);
  });
});
```

Create `packages/portal/src/test-utils.tsx`:

```tsx
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

export function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
```

Create `packages/portal/src/api.admin.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAdminActivity, fetchAdminInstance } from "./api";

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.setItem("awb_token", "tok-abc");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  localStorage.clear();
});

describe("admin fetchers", () => {
  it("fetchAdminInstance calls the instance endpoint with the bearer token", async () => {
    await fetchAdminInstance();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/overview/instance");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
  });

  it("fetchAdminActivity sends only the filters it was given", async () => {
    await fetchAdminActivity({ limit: 50, status: "error", email: "dev@example.com", cursor: "c1" });
    const url = new URL(fetchMock.mock.calls[0][0], "http://x");
    expect(url.pathname).toBe("/api/admin/overview/activity");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "50",
      status: "error",
      email: "dev@example.com",
      cursor: "c1",
    });
  });

  it("fetchAdminActivity with no options adds no query string", async () => {
    await fetchAdminActivity();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/overview/activity");
  });

  it("throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    await expect(fetchAdminInstance()).rejects.toThrow("Failed to fetch instance info");
  });
});
```

Create `packages/portal/src/components/admin/InstanceCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import InstanceCard from "./InstanceCard";

const api = vi.hoisted(() => ({ fetchAdminInstance: vi.fn() }));
vi.mock("../../api", () => api);

const info = {
  version: "0.30.0",
  db_backend: "sqlite",
  cluster_enabled: false,
  audit_log_dest: "sqlite",
  audit_stored: true,
  user_count: 3,
  admin_count: 1,
};

beforeEach(() => api.fetchAdminInstance.mockReset());

describe("InstanceCard", () => {
  it("shows version, database, cluster, audit log and counts", async () => {
    api.fetchAdminInstance.mockResolvedValue(info);
    renderWithClient(<InstanceCard />);
    const table = await screen.findByRole("table", { name: "Instance settings" });
    const rows = within(table).getAllByRole("row").map((r) => r.textContent);
    expect(rows).toEqual(
      expect.arrayContaining(["Version0.30.0", "Databasesqlite", "ClusterOff", "Audit logsqlite", "Users3", "Admins1"])
    );
  });

  it("says when audit events are not stored in the database", async () => {
    api.fetchAdminInstance.mockResolvedValue({ ...info, audit_log_dest: "stdout", audit_stored: false });
    renderWithClient(<InstanceCard />);
    expect(await screen.findByText("stdout (not in database)")).toBeInTheDocument();
  });

  it("shows a loading state, then an error state", async () => {
    api.fetchAdminInstance.mockRejectedValue(new Error("boom"));
    renderWithClient(<InstanceCard />);
    expect(screen.getByText("Loading instance info…")).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load instance info.")).toBeInTheDocument();
  });
});
```

Create `packages/portal/src/components/admin/ConnectionsCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ConnectionsCard from "./ConnectionsCard";

const api = vi.hoisted(() => ({ fetchAdminConnections: vi.fn() }));
vi.mock("../../api", () => api);

beforeEach(() => api.fetchAdminConnections.mockReset());

describe("ConnectionsCard", () => {
  it("lists each integration with its connected and needs-reconnect counts", async () => {
    api.fetchAdminConnections.mockResolvedValue({
      integrations: [
        { integration: "jira", connected: 3, needs_reconnect: 1 },
        { integration: "slack", connected: 1, needs_reconnect: 0 },
      ],
    });
    renderWithClient(<ConnectionsCard />);
    const jira = (await screen.findByText("jira")).closest("tr")!;
    expect(jira).toHaveTextContent("3");
    expect(jira).toHaveTextContent("1");
    expect(screen.getByText("slack").closest("tr")).toHaveTextContent("0");
  });

  it("shows an empty state", async () => {
    api.fetchAdminConnections.mockResolvedValue({ integrations: [] });
    renderWithClient(<ConnectionsCard />);
    expect(await screen.findByText("No connections yet.")).toBeInTheDocument();
  });

  it("shows an error state", async () => {
    api.fetchAdminConnections.mockRejectedValue(new Error("boom"));
    renderWithClient(<ConnectionsCard />);
    expect(await screen.findByText("Couldn't load connections.")).toBeInTheDocument();
  });
});
```

Create `packages/portal/src/components/admin/CustomAppsCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import CustomAppsCard from "./CustomAppsCard";

const api = vi.hoisted(() => ({ fetchAdminCustomApps: vi.fn() }));
vi.mock("../../api", () => api);

const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => api.fetchAdminCustomApps.mockReset());

describe("CustomAppsCard", () => {
  it("lists apps with owner and URL", async () => {
    api.fetchAdminCustomApps.mockResolvedValue({
      apps: [{ id: "a1", name: "wiki", base_url: "https://mcp.example.com/wiki", owner_email: "dev@example.com", created_at: NOW }],
      total: 1,
    });
    renderWithClient(<CustomAppsCard />);
    const row = (await screen.findByText("wiki")).closest("tr")!;
    expect(row).toHaveTextContent("dev@example.com");
    expect(row).toHaveTextContent("https://mcp.example.com/wiki");
  });

  it("shows a dash for an app whose owner is gone", async () => {
    api.fetchAdminCustomApps.mockResolvedValue({
      apps: [{ id: "a1", name: "orphan", base_url: "https://mcp.example.com/o", owner_email: null, created_at: NOW }],
      total: 1,
    });
    renderWithClient(<CustomAppsCard />);
    expect((await screen.findByText("orphan")).closest("tr")).toHaveTextContent("—");
  });

  it("notes when the list is truncated", async () => {
    api.fetchAdminCustomApps.mockResolvedValue({
      apps: [{ id: "a1", name: "wiki", base_url: "https://mcp.example.com/w", owner_email: "dev@example.com", created_at: NOW }],
      total: 250,
    });
    renderWithClient(<CustomAppsCard />);
    expect(await screen.findByText("Showing the latest 1 of 250.")).toBeInTheDocument();
  });

  it("shows empty and error states", async () => {
    api.fetchAdminCustomApps.mockResolvedValueOnce({ apps: [], total: 0 });
    const { unmount } = renderWithClient(<CustomAppsCard />);
    expect(await screen.findByText("No custom apps.")).toBeInTheDocument();
    unmount();
    api.fetchAdminCustomApps.mockRejectedValueOnce(new Error("boom"));
    renderWithClient(<CustomAppsCard />);
    expect(await screen.findByText("Couldn't load custom apps.")).toBeInTheDocument();
  });
});
```

Create `packages/portal/src/components/admin/ProfilesCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ProfilesCard from "./ProfilesCard";

const api = vi.hoisted(() => ({ fetchAdminProfiles: vi.fn() }));
vi.mock("../../api", () => api);

beforeEach(() => api.fetchAdminProfiles.mockReset());

describe("ProfilesCard", () => {
  it("shows user, formatted size and live or idle status", async () => {
    api.fetchAdminProfiles.mockResolvedValue({
      this_worker_only: false,
      profiles: [
        { name: "user-dev", email: "dev@example.com", bytes: 5 * 1024 * 1024, last_used: Math.floor(Date.now() / 1000) - 60, live: true },
        { name: "orphan", email: null, bytes: 2048, last_used: null, live: false },
      ],
    });
    renderWithClient(<ProfilesCard />);
    const dev = (await screen.findByText("dev@example.com")).closest("tr")!;
    expect(dev).toHaveTextContent("5.0 MB");
    expect(dev).toHaveTextContent("Live");
    const orphan = screen.getByText("orphan").closest("tr")!;
    expect(orphan).toHaveTextContent("2.0 KB");
    expect(orphan).toHaveTextContent("Idle");
    expect(orphan).toHaveTextContent("—");
  });

  it("warns that only this worker's profiles are listed in cluster mode", async () => {
    api.fetchAdminProfiles.mockResolvedValue({ this_worker_only: true, profiles: [] });
    renderWithClient(<ProfilesCard />);
    expect(await screen.findByText(/only this worker/i)).toBeInTheDocument();
    expect(screen.getByText("No browser profiles.")).toBeInTheDocument();
  });

  it("shows an error state", async () => {
    api.fetchAdminProfiles.mockRejectedValue(new Error("boom"));
    renderWithClient(<ProfilesCard />);
    expect(await screen.findByText("Couldn't load browser profiles.")).toBeInTheDocument();
  });
});
```

Create `packages/portal/src/components/admin/OverviewTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import OverviewTab from "./OverviewTab";

const api = vi.hoisted(() => ({
  fetchAdminInstance: vi.fn(),
  fetchAdminActivity: vi.fn(),
  fetchAdminConnections: vi.fn(),
  fetchAdminCustomApps: vi.fn(),
  fetchAdminProfiles: vi.fn(),
  fetchIntegrations: vi.fn(),
}));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [], next_cursor: null });
  api.fetchAdminCustomApps.mockResolvedValue({ apps: [], total: 0 });
  api.fetchAdminProfiles.mockResolvedValue({ profiles: [], this_worker_only: false });
  api.fetchIntegrations.mockResolvedValue({ integrations: [] });
});

describe("OverviewTab", () => {
  it("one failing card does not blank the others", async () => {
    api.fetchAdminInstance.mockRejectedValue(new Error("boom"));
    api.fetchAdminConnections.mockResolvedValue({
      integrations: [{ integration: "jira", connected: 2, needs_reconnect: 0 }],
    });
    renderWithClient(<OverviewTab />);
    expect(await screen.findByText("Couldn't load instance info.")).toBeInTheDocument();
    expect(await screen.findByText("jira")).toBeInTheDocument();
    expect(await screen.findByText("No custom apps.")).toBeInTheDocument();
  });
});
```

Replace `packages/portal/src/pages/Admin.test.tsx` with:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Admin from "./Admin";

vi.mock("../components/admin/OverviewTab", () => ({ default: () => <p>overview-body</p> }));

describe("Admin page", () => {
  it("has a page title and an Overview tab selected, showing the overview", () => {
    render(<Admin />);
    expect(screen.getByRole("heading", { level: 1, name: "Admin" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("overview-body")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/portal && npm run test -- src/format.test.ts src/api.admin.test.ts src/components/admin src/pages/Admin.test.tsx`
Expected: FAIL (missing exports and modules).

- [ ] **Step 3: Implement `formatBytes`**

Append to `packages/portal/src/format.ts`:

```ts
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
```

- [ ] **Step 4: Implement the fetchers**

Append to `packages/portal/src/api.ts`:

```ts
// ─── Admin overview ──────────────────────────────────────────────────────
// Read-only cards on the Admin page. Each has its own endpoint so one failing
// card does not take the page down.
async function adminGet<T>(path: string, what: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: getHeaders() });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(`Failed to fetch ${what}`);
  return res.json();
}

export interface AdminInstance {
  version: string;
  db_backend: "sqlite" | "postgres";
  cluster_enabled: boolean;
  audit_log_dest: string;
  audit_stored: boolean;
  user_count: number;
  admin_count: number;
}

export interface AdminActivityEvent extends ActivityEvent {
  user_id: string;
  user_email: string | null;
}

export interface AdminActivityPage {
  /** False when audit events are routed somewhere other than the database. */
  stored: boolean;
  events: AdminActivityEvent[];
  next_cursor: string | null;
}

export interface AdminConnectionRow {
  integration: string;
  connected: number;
  needs_reconnect: number;
}

export interface AdminCustomApp {
  id: string;
  name: string;
  base_url: string;
  owner_email: string | null;
  /** Unix seconds. */
  created_at: number;
}

export interface AdminProfile {
  name: string;
  email: string | null;
  bytes: number;
  /** Unix seconds, or null when unknown. */
  last_used: number | null;
  live: boolean;
}

export const fetchAdminInstance = () =>
  adminGet<AdminInstance>("/api/admin/overview/instance", "instance info");

export const fetchAdminConnections = () =>
  adminGet<{ integrations: AdminConnectionRow[] }>("/api/admin/overview/connections", "connections");

export const fetchAdminCustomApps = () =>
  adminGet<{ apps: AdminCustomApp[]; total: number }>("/api/admin/overview/custom-apps", "custom apps");

export const fetchAdminProfiles = () =>
  adminGet<{ profiles: AdminProfile[]; this_worker_only: boolean }>(
    "/api/admin/overview/browser-profiles",
    "browser profiles"
  );

export function fetchAdminActivity(opts: {
  limit?: number;
  cursor?: string;
  integration?: string;
  status?: "success" | "error";
  email?: string;
} = {}): Promise<AdminActivityPage> {
  const qs = new URLSearchParams();
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.integration) qs.set("integration", opts.integration);
  if (opts.status) qs.set("status", opts.status);
  if (opts.email) qs.set("email", opts.email);
  const suffix = qs.toString() ? `?${qs}` : "";
  return adminGet<AdminActivityPage>(`/api/admin/overview/activity${suffix}`, "activity");
}
```

- [ ] **Step 5: Implement the cards**

Create `packages/portal/src/components/admin/CardBody.tsx`:

```tsx
import type { ReactNode } from "react";

// The loading and error states every overview card shares, so each card only
// has to say what it renders once its data has arrived.
export function CardBody({
  isLoading,
  isError,
  label,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  label: string;
  children: ReactNode;
}) {
  if (isLoading) return <div className="ui-loading">Loading {label}…</div>;
  if (isError) return <div className="ui-form-error">Couldn't load {label}.</div>;
  return <>{children}</>;
}
```

Create `packages/portal/src/components/admin/InstanceCard.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { fetchAdminInstance } from "../../api";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { CardBody } from "./CardBody";

export default function InstanceCard() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["admin", "instance"], queryFn: fetchAdminInstance });
  const rows: [string, string | number][] = data
    ? [
        ["Version", data.version],
        ["Database", data.db_backend],
        ["Cluster", data.cluster_enabled ? "On" : "Off"],
        ["Audit log", data.audit_stored ? data.audit_log_dest : `${data.audit_log_dest} (not in database)`],
        ["Users", data.user_count],
        ["Admins", data.admin_count],
      ]
    : [];
  return (
    <Box title="Instance">
      <CardBody isLoading={isLoading} isError={isError} label="instance info">
        <DataTable
          caption="Instance settings"
          head={
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Value</th>
            </tr>
          }
        >
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </DataTable>
      </CardBody>
    </Box>
  );
}
```

Create `packages/portal/src/components/admin/ConnectionsCard.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { fetchAdminConnections } from "../../api";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { CardBody } from "./CardBody";

export default function ConnectionsCard() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["admin", "connections"], queryFn: fetchAdminConnections });
  const rows = data?.integrations ?? [];
  return (
    <Box title="Connections">
      <CardBody isLoading={isLoading} isError={isError} label="connections">
        {rows.length === 0 ? (
          <EmptyState message="No connections yet." />
        ) : (
          <DataTable
            caption="Connections by integration"
            head={
              <tr>
                <th scope="col">Integration</th>
                <th scope="col" className="ui-num">Connected</th>
                <th scope="col" className="ui-num">Needs reconnect</th>
              </tr>
            }
          >
            {rows.map((r) => (
              <tr key={r.integration}>
                <td>{r.integration}</td>
                <td className="ui-num">{r.connected}</td>
                <td className={`ui-num${r.needs_reconnect > 0 ? " wb-status-bad" : ""}`}>{r.needs_reconnect}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </CardBody>
    </Box>
  );
}
```

Create `packages/portal/src/components/admin/CustomAppsCard.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { fetchAdminCustomApps } from "../../api";
import { dayLabel } from "../../format";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { CardBody } from "./CardBody";

export default function CustomAppsCard() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["admin", "custom-apps"], queryFn: fetchAdminCustomApps });
  const apps = data?.apps ?? [];
  return (
    <Box title="Custom apps">
      <CardBody isLoading={isLoading} isError={isError} label="custom apps">
        {apps.length === 0 ? (
          <EmptyState message="No custom apps." />
        ) : (
          <>
            <DataTable
              caption="Custom apps across all users"
              head={
                <tr>
                  <th scope="col">App</th>
                  <th scope="col">Owner</th>
                  <th scope="col">URL</th>
                  <th scope="col">Added</th>
                </tr>
              }
            >
              {apps.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.owner_email ?? "—"}</td>
                  <td><code className="wb-mono">{a.base_url}</code></td>
                  <td>{dayLabel(a.created_at)}</td>
                </tr>
              ))}
            </DataTable>
            {data && data.total > apps.length && (
              <div className="ui-stat-note">Showing the latest {apps.length} of {data.total}.</div>
            )}
          </>
        )}
      </CardBody>
    </Box>
  );
}
```

Create `packages/portal/src/components/admin/ProfilesCard.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { fetchAdminProfiles } from "../../api";
import { formatBytes, relativeTime } from "../../format";
import { Badge } from "../ui/Badge";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { CardBody } from "./CardBody";

export default function ProfilesCard() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["admin", "profiles"], queryFn: fetchAdminProfiles });
  const profiles = data?.profiles ?? [];
  return (
    <Box title="Browser profiles">
      <CardBody isLoading={isLoading} isError={isError} label="browser profiles">
        {data?.this_worker_only && (
          <div className="ui-stat-note">Cluster mode is on: only this worker's profiles are listed.</div>
        )}
        {profiles.length === 0 ? (
          <EmptyState message="No browser profiles." />
        ) : (
          <DataTable
            caption="Browser profiles on disk"
            head={
              <tr>
                <th scope="col">User</th>
                <th scope="col" className="ui-num">Size</th>
                <th scope="col">Last used</th>
                <th scope="col">Status</th>
              </tr>
            }
          >
            {profiles.map((p) => (
              <tr key={p.name}>
                <td>{p.email ?? p.name}</td>
                <td className="ui-num">{formatBytes(p.bytes)}</td>
                <td>{p.last_used ? relativeTime(p.last_used) : "—"}</td>
                <td>
                  <Badge variant={p.live ? "green" : "neutral"}>{p.live ? "Live" : "Idle"}</Badge>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </CardBody>
    </Box>
  );
}
```

Create `packages/portal/src/components/admin/OverviewTab.tsx`:

```tsx
import ConnectionsCard from "./ConnectionsCard";
import CustomAppsCard from "./CustomAppsCard";
import InstanceCard from "./InstanceCard";
import ProfilesCard from "./ProfilesCard";

export default function OverviewTab() {
  return (
    <div className="wb-section-gap">
      <InstanceCard />
      <ConnectionsCard />
      <CustomAppsCard />
      <ProfilesCard />
    </div>
  );
}
```

In `packages/portal/src/pages/Admin.tsx` replace the `EmptyState` import with `import OverviewTab from "../components/admin/OverviewTab";` and replace `{tab === "overview" && <EmptyState message="Nothing to show here yet." />}` with `{tab === "overview" && <OverviewTab />}`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/portal && npm run test`
Expected: PASS, whole portal suite.

- [ ] **Step 7: Commit**

```bash
git add packages/portal/src
git commit -m "feat(admin): overview cards for instance, connections, custom apps, profiles"
```

---

### Task 7: Portal: the Activity card

**Files:**
- Create: `packages/portal/src/components/admin/ActivityCard.tsx`, `packages/portal/src/components/admin/ActivityCard.test.tsx`
- Modify: `packages/portal/src/components/admin/OverviewTab.tsx`

**Interfaces:**
- Consumes: `fetchAdminActivity`, `fetchIntegrations`, `UNSTORED_MESSAGE`, `AdminActivityEvent`, `IntegrationSummary` from `api`; `integrationLookup` from `components/ActivityTable`; `Tabs`, `Select`, `Input`, `Button`, `Box`, `DataTable`, `EmptyState`, `CardBody`.
- Produces: default export `ActivityCard`.

- [ ] **Step 1: Write the failing test**

Create `packages/portal/src/components/admin/ActivityCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ActivityCard from "./ActivityCard";

const api = vi.hoisted(() => ({ fetchAdminActivity: vi.fn(), fetchIntegrations: vi.fn() }));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));

const NOW = Math.floor(Date.now() / 1000);

function ev(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: "u1",
    user_email: "dev@example.com",
    integration: "acme",
    tool: `tool_${id}`,
    action: "EXECUTE",
    success: true,
    error: null,
    duration_ms: 120,
    created_at: NOW,
    ...over,
  };
}

beforeEach(() => {
  api.fetchAdminActivity.mockReset();
  api.fetchIntegrations.mockReset();
  api.fetchIntegrations.mockResolvedValue({ integrations: [{ name: "acme", displayName: "Acme" }] });
});

describe("ActivityCard", () => {
  it("shows each event with the user's email and the app's display name", async () => {
    api.fetchAdminActivity.mockResolvedValue({
      stored: true,
      events: [ev(1, { tool: "acme_search" }), ev(2, { user_email: null, tool: "orphan_tool" })],
      next_cursor: null,
    });
    renderWithClient(<ActivityCard />);
    const row = (await screen.findByText("acme_search")).closest("tr")!;
    expect(row).toHaveTextContent("dev@example.com");
    expect(row).toHaveTextContent("Acme");
    expect(screen.getByText("orphan_tool").closest("tr")).toHaveTextContent("—");
  });

  it("says events are not stored, rather than that nothing ran", async () => {
    api.fetchAdminActivity.mockResolvedValue({ stored: false, events: [], next_cursor: null });
    renderWithClient(<ActivityCard />);
    expect(await screen.findByText(/not stored in the database/i)).toBeInTheDocument();
    expect(screen.queryByText("No tool calls recorded yet.")).not.toBeInTheDocument();
  });

  it("shows an empty state and an error state", async () => {
    api.fetchAdminActivity.mockResolvedValueOnce({ stored: true, events: [], next_cursor: null });
    const { unmount } = renderWithClient(<ActivityCard />);
    expect(await screen.findByText("No tool calls recorded yet.")).toBeInTheDocument();
    unmount();
    api.fetchAdminActivity.mockRejectedValueOnce(new Error("boom"));
    renderWithClient(<ActivityCard />);
    expect(await screen.findByText("Couldn't load activity.")).toBeInTheDocument();
  });

  it("the Errors tab refetches with status=error", async () => {
    api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [ev(1)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("tab", { name: "Errors" }));
    await waitFor(() =>
      expect(api.fetchAdminActivity).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }))
    );
  });

  it("filtering by email sends the trimmed email on submit", async () => {
    api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [ev(1)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.change(screen.getByLabelText("User email"), { target: { value: "  dev@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() =>
      expect(api.fetchAdminActivity).toHaveBeenLastCalledWith(expect.objectContaining({ email: "dev@example.com" }))
    );
  });

  it("Load more appends the next page using the cursor", async () => {
    api.fetchAdminActivity
      .mockResolvedValueOnce({ stored: true, events: [ev(1)], next_cursor: "c1" })
      .mockResolvedValueOnce({ stored: true, events: [ev(2)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("tool_2")).toBeInTheDocument();
    expect(screen.getByText("tool_1")).toBeInTheDocument();
    expect(api.fetchAdminActivity).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c1" }));
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("does not show the same event twice when two pages both contain it", async () => {
    api.fetchAdminActivity
      .mockResolvedValueOnce({ stored: true, events: [ev(1)], next_cursor: "c1" })
      .mockResolvedValueOnce({ stored: true, events: [ev(1), ev(2)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("tool_2");
    expect(screen.getAllByText("tool_1")).toHaveLength(1);
  });
});
```

Add a test to `OverviewTab.test.tsx` so the new card is covered there:

```tsx
  it("includes the activity card", async () => {
    api.fetchAdminInstance.mockResolvedValue({
      version: "0.30.0", db_backend: "sqlite", cluster_enabled: false, audit_log_dest: "sqlite",
      audit_stored: true, user_count: 1, admin_count: 1,
    });
    api.fetchAdminConnections.mockResolvedValue({ integrations: [] });
    renderWithClient(<OverviewTab />);
    expect(await screen.findByText("No tool calls recorded yet.")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/portal && npm run test -- src/components/admin`
Expected: FAIL (`./ActivityCard` not found).

- [ ] **Step 3: Implement**

Create `packages/portal/src/components/admin/ActivityCard.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchAdminActivity,
  fetchIntegrations,
  UNSTORED_MESSAGE,
  type AdminActivityEvent,
  type IntegrationSummary,
} from "../../api";
import { dayLabel, timeLabel } from "../../format";
import { integrationLookup } from "../ActivityTable";
import { Box } from "../ui/Box";
import { Button } from "../ui/Button";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Input, Select } from "../ui/Input";
import { Tabs } from "../ui/Tabs";
import { CardBody } from "./CardBody";

const PAGE_SIZE = 50;

export default function ActivityCard() {
  const [status, setStatus] = useState<"all" | "error">("all");
  const [integration, setIntegration] = useState("all");
  // The email box is a draft until submitted, so typing does not refetch.
  const [emailDraft, setEmailDraft] = useState("");
  const [email, setEmail] = useState("");

  const filters = useMemo(
    () => ({
      limit: PAGE_SIZE,
      ...(status === "error" ? { status: "error" as const } : {}),
      ...(integration !== "all" ? { integration } : {}),
      ...(email ? { email } : {}),
    }),
    [status, integration, email]
  );

  const query = useInfiniteQuery({
    queryKey: ["admin", "activity", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchAdminActivity({ ...filters, cursor: pageParam }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const { data: registry } = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrations });
  const integrations = (registry?.integrations ?? []) as IntegrationSummary[];
  const appFor = useMemo(() => integrationLookup(integrations), [integrations]);

  const pages = query.data?.pages ?? [];
  const stored = pages[0]?.stored ?? true;
  // De-duplicate by id: a refetch of an earlier page racing a "Load more" can
  // otherwise land the same row twice.
  const events = useMemo(() => {
    const seen = new Set<number>();
    return pages.flatMap((p) => p.events).filter((e: AdminActivityEvent) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }, [pages]);

  return (
    <Box title="Activity">
      <div className="wb-page-toolbar">
        <Tabs
          label="Filter activity"
          value={status}
          onChange={(id) => setStatus(id as "all" | "error")}
          items={[{ id: "all", label: "All" }, { id: "error", label: "Errors" }]}
        />
        <div className="wb-toolbar-controls">
          <label className="ui-sr-only" htmlFor="admin-activity-integration">Integration</label>
          <Select
            id="admin-activity-integration"
            value={integration}
            onChange={(e) => setIntegration(e.target.value)}
          >
            <option value="all">All apps</option>
            {integrations.map((i) => (
              <option key={i.name} value={i.name}>{i.displayName || i.name}</option>
            ))}
          </Select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setEmail(emailDraft.trim());
            }}
          >
            <label className="ui-sr-only" htmlFor="admin-activity-email">User email</label>
            <Input
              id="admin-activity-email"
              type="text"
              placeholder="User email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
            />
            <Button type="submit" variant="outline">Filter</Button>
          </form>
        </div>
      </div>

      <CardBody isLoading={query.isLoading} isError={query.isError} label="activity">
        {!stored ? (
          <EmptyState message={UNSTORED_MESSAGE} />
        ) : events.length === 0 ? (
          <EmptyState message="No tool calls recorded yet." />
        ) : (
          <DataTable
            caption="Tool calls across all users"
            head={
              <tr>
                <th scope="col">Time</th>
                <th scope="col">User</th>
                <th scope="col">App</th>
                <th scope="col">Tool</th>
                <th scope="col">Status</th>
              </tr>
            }
          >
            {events.map((e) => {
              const app = e.integration ? appFor(e.integration).label : "—";
              return (
                <tr key={e.id}>
                  <td className="wb-cell-time">{dayLabel(e.created_at)} {timeLabel(e.created_at)}</td>
                  <td>{e.user_email ?? "—"}</td>
                  <td>{app}</td>
                  <td>
                    <code className="wb-mono">{e.tool ?? "—"}</code>
                    {!e.success && e.error && <div className="wb-cell-error" title={e.error}>{e.error}</div>}
                  </td>
                  <td>
                    <span className={e.success ? "wb-status-ok" : "wb-status-bad"}>
                      <span aria-hidden>{e.success ? "✓" : "✕"}</span> {e.success ? "Succeeded" : "Failed"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </CardBody>

      {query.hasNextPage && (
        <div className="wb-load-more">
          <Button variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </Box>
  );
}
```

In `packages/portal/src/components/admin/OverviewTab.tsx` add `import ActivityCard from "./ActivityCard";` and render `<ActivityCard />` directly after `<InstanceCard />`.

Check that `UNSTORED_MESSAGE` contains the phrase "not stored in the database" (the test matches it case-insensitively): run `grep -n "UNSTORED_MESSAGE" -A3 packages/portal/src/api.ts`. If its wording differs, change the test's regex to match the real message rather than changing the message.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/portal && npm run test`
Expected: PASS, whole portal suite.

- [ ] **Step 5: Type-check and build**

Run: `npm run build`
Expected: success for all packages.

- [ ] **Step 6: Commit**

```bash
git add packages/portal/src
git commit -m "feat(admin): activity card with filters and paging"
```

---

### Task 8: Docs and finding

**Files:**
- Modify: `docs/site/_content/reference/http-api.md`, `docs/site/_content/deploy/admin.md`, `CLAUDE.md`
- Create: `docs/findings/2026-10-01-admin-overview.md`

- [ ] **Step 1: HTTP API rows**

In `http-api.md`, replace the `/api/admin/ping` row with:

```
| GET | `/api/admin/overview/instance` | session only, admin | — | `{ version, db_backend, cluster_enabled, audit_log_dest, audit_stored, user_count, admin_count }` | 401, 403 |
| GET | `/api/admin/overview/activity` | session only, admin | query `limit`, `cursor`, `integration`, `status`, `email` | `{ stored, events[], next_cursor }`; each event carries `user_id`, `user_email` | 400, 401, 403 |
| GET | `/api/admin/overview/connections` | session only, admin | — | `{ integrations: [{ integration, connected, needs_reconnect }] }` | 401, 403 |
| GET | `/api/admin/overview/custom-apps` | session only, admin | — | `{ apps[], total }` | 401, 403 |
| GET | `/api/admin/overview/browser-profiles` | session only, admin | — | `{ profiles[], this_worker_only }` | 401, 403 |
```

- [ ] **Step 2: Admin guide**

In `docs/site/_content/deploy/admin.md`, add before the closing warning a section:

```
## What the Overview shows

Five read-only cards, each loaded independently:

- **Instance:** version, database backend, cluster mode, audit-log destination, user and admin counts (the admin count is a number, never the list).
- **Activity:** every user's tool calls, newest first, with the user's email. Filter by app, errors only, or a user's email. Shows tool names and error text, never arguments. With `AUDIT_LOG_DEST` other than `sqlite` the events are not in the database, and the card says so.
- **Connections:** connected users per integration. "Needs reconnect" counts connections whose access token has expired and which have no refresh token; the server does not record refresh failures, so a connection that merely failed to refresh is not counted.
- **Custom apps:** every user's custom apps with owner and URL. Credentials are never shown.
- **Browser profiles:** disk used per user and whether the profile is live. Under `CLUSTER_ENABLED` each worker sees only its own volume, so the card lists that worker's profiles only.
```

and change the warning's first sentence to: "The Overview shows every user's tool-call metadata (app, tool, error text, never arguments) and which users have which integrations connected."

- [ ] **Step 3: Finding and index**

Create `docs/findings/2026-10-01-admin-overview.md`:

```
# Admin overview

- The Docker image shipped no `package.json`, and `custom-apps/client.ts` resolved
  `../../../../package.json` (`/package.json` inside the image), so every
  container reported version `0.0.0`, including to custom MCP servers. The layout
  differs: a checkout has the root three levels above `src/`, the image has the
  flattened server at `/app/server` with `package.json` one level up. `readVersion`
  tries both, root first, because from `src/` the one-level-up file is
  `packages/server/package.json`, whose version is stale. The Dockerfile now
  copies the root `package.json`.
- `connections` records no refresh failure, so "needs reconnect" is derived:
  expired `expires_at` and a null `refresh_token`. Cookie and API-key connections
  have a null `expires_at` and never count. Real failure tracking needs DDL.
- Cross-user activity is `audit_log LEFT JOIN users`, so an event whose user row
  is gone still shows, with a null email. Keyset paging stays the longhand
  `created_at < ? OR (created_at = ? AND id < ?)`.
- Each card has its own endpoint and its own component state, so a slow disk walk
  in the profiles card cannot blank the activity card.
- Gate tests import `api/admin-scope.ts`, which has no database import, because
  the gate suite mocks `config` with a hand-built object and the DB opens a file
  from `config.DATABASE_URL` at import time.
```

Append to the Findings Index in `CLAUDE.md` (after the 2026-10-01 admin gate line):

```
- [2026-10-01 admin overview](docs/findings/2026-10-01-admin-overview.md) — the Docker image shipped no `package.json`, so every container reported version `0.0.0` (also to custom MCP servers); `readVersion` now tries the checkout and image layouts. Overview cards are independent endpoints; "needs reconnect" is derived (expired + no refresh token) because refresh failures are not recorded
```

- [ ] **Step 4: Build the docs and scan**

Run: `node docs/site/build.mjs`
Expected: completes, no broken-link error.

Run: `git add docs CLAUDE.md && git diff --cached | grep -inIE '@(icloud|gmail)\.com|<real-name>|<company>'`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git commit -m "docs(admin): overview endpoints, guide, finding"
```

---

## Final verification

- [ ] Run: `npm run test` and `npm run build`. Expected: all green.
- [ ] Rebuild the local container and confirm the image now carries the version: `docker compose -f docker-compose.yml up --build -d a-workbench`, then `docker exec <container> grep '"version"' /app/package.json` prints the root version, not nothing.
- [ ] Manual: sign in as an admin, open `/admin`. All five cards render. The Instance card shows the real version (not `0.0.0`), the Activity card lists your own calls, and filtering by your email narrows it.
- [ ] Manual: set `AUDIT_LOG_DEST=stdout`, restart. The Activity card says events are not stored in the database, and Instance shows `stdout (not in database)`.
- [ ] Ship plan: this sub-project touches the Dockerfile, so it rides the same RC as sub-projects 3 and 4 (schema) unless you want it earlier.
