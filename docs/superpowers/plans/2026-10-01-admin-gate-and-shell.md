# Admin gate + shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Name admins in an `ADMIN_EMAILS` env var, gate `/api/admin/*` behind a session-only admin check, and show an Admin tab shell in the existing portal for admins only.

**Architecture:** `config.ts` parses `ADMIN_EMAILS` into a lowercase array. `auth/admin.ts` holds `isAdminEmail` and `resolveAdmin` (session JWT only, email read from the DB). `api/admin-routes.ts` registers an encapsulated Fastify scope under `/api/admin` whose `onRequest` hook runs `resolveAdmin`, so every later admin route inherits the gate and cannot forget it. `/api/auth/me` returns `isAdmin`; the portal uses it to show a nav item and wrap `/admin` in `RequireAdmin`. The server is the gate; the portal check is UX.

**Tech Stack:** TypeScript, Fastify 5, vitest, React + react-router, Testing Library, Zod.

**Spec:** `docs/superpowers/specs/2026-10-01-admin-page-design.md` (section 1, "Gate + shell"). Sub-projects 2 to 4 (visibility, users, config) are separate plans.

## Global Constraints

- Admin is derived from `ADMIN_EMAILS` only. `users.is_admin` stays unused. No DDL in this plan.
- `ADMIN_EMAILS`: comma-separated, trimmed, lowercased, parsed once in `config.ts`. Default empty means admin is off.
- `requireAdmin` / `resolveAdmin` accepts the **session JWT only**. The `x-workbench-api-key` path must never satisfy it.
- Compare against `users.email` loaded from the DB, not the JWT `email` claim.
- 401 with no valid session, 403 for a valid session that is not an admin.
- Do not gate `/mcp` or `/rest`.
- Fixtures use synthetic emails only: `admin@example.com`, `dev@example.com`, `other@example.com`.
- No `Co-Authored-By` or "Generated with" trailer on any commit.
- Tests that mock `../src/config` omit `ADMIN_EMAILS`; code reading it must tolerate `undefined` (`config.ADMIN_EMAILS ?? []`).

## Review Focus

- Admin's API key sent to `/api/admin/*` must be 401, not 200.
- Allowlist entry with different case or surrounding spaces still matches the user's email.
- Allowlist entry empty (`ADMIN_EMAILS=","` or `""`) must never match a user whose DB `email` is `null` or `""`.
- Session for a user row that no longer exists must be 401, not 403 or 200.
- A session whose JWT `email` claim is allowlisted but whose DB email is not must be 403 (DB wins).
- Existing tests that mock config without `ADMIN_EMAILS` still pass.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/src/config.ts` (modify) | `parseAdminEmails`, `ADMIN_EMAILS` field |
| `packages/server/src/auth/admin.ts` (create) | `isAdminEmail`, `resolveAdmin` |
| `packages/server/src/api/admin-routes.ts` (create) | gated `/api/admin` scope, `GET /api/admin/ping` |
| `packages/server/src/api/routes.ts` (modify) | `/api/auth/me` adds `isAdmin` |
| `packages/server/src/index.ts` (modify) | register admin routes |
| `packages/server/tests/admin-gate.test.ts` (create) | config parse + `isAdminEmail` + `resolveAdmin` |
| `packages/server/tests/admin-routes.test.ts` (create) | route-level gate behavior |
| `packages/server/tests/routes.test.ts` (modify) | `/me` expectation |
| `packages/portal/src/context/AuthContext.tsx` (modify) | `isAdmin` on `AuthUser` |
| `packages/portal/src/components/RequireAdmin.tsx` (create) | route guard |
| `packages/portal/src/pages/Admin.tsx` (create) | tab shell page |
| `packages/portal/src/components/shell/Sidebar.tsx` (modify) | Admin link for admins |
| `packages/portal/src/App.tsx` (modify) | `/admin` route |
| `.env.example`, `docs/site/...`, `docs/findings/...`, `CLAUDE.md` (modify/create) | docs |

`GET /api/admin/ping` exists so the gate has a guarded route to test end to end. Sub-project 2 replaces it with real endpoints.

---

### Task 1: `ADMIN_EMAILS` config and `isAdminEmail`

**Files:**
- Modify: `packages/server/src/config.ts`
- Create: `packages/server/src/auth/admin.ts`
- Test: `packages/server/tests/admin-gate.test.ts`

**Interfaces:**
- Produces: `parseAdminEmails(raw: string): string[]` (exported from `config.ts`); `config.ADMIN_EMAILS: string[]`; `isAdminEmail(email: string | null | undefined): boolean` (exported from `auth/admin.ts`).

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/admin-gate.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { config, parseAdminEmails } from "../src/config";
import { isAdminEmail } from "../src/auth/admin";

describe("parseAdminEmails", () => {
  it("splits on commas, trims, and lowercases", () => {
    expect(parseAdminEmails(" Admin@Example.com , ops@example.com ")).toEqual([
      "admin@example.com",
      "ops@example.com",
    ]);
  });

  it("drops empty entries", () => {
    expect(parseAdminEmails("")).toEqual([]);
    expect(parseAdminEmails(",, ,")).toEqual([]);
  });
});

describe("config.ADMIN_EMAILS", () => {
  it("defaults to an empty list, so admin is off", () => {
    expect(config.ADMIN_EMAILS).toEqual([]);
  });
});

describe("isAdminEmail", () => {
  beforeEach(() => {
    config.ADMIN_EMAILS = ["admin@example.com"];
  });

  it("matches case-insensitively", () => {
    expect(isAdminEmail("Admin@Example.com")).toBe(true);
  });

  it("rejects an email that is not listed", () => {
    expect(isAdminEmail("dev@example.com")).toBe(false);
  });

  it("rejects null, undefined and empty even when the list is empty", () => {
    config.ADMIN_EMAILS = [];
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });

  it("tolerates a config object with no ADMIN_EMAILS at all", () => {
    (config as { ADMIN_EMAILS?: string[] }).ADMIN_EMAILS = undefined;
    expect(isAdminEmail("admin@example.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-gate.test.ts`
Expected: FAIL (`parseAdminEmails` / `../src/auth/admin` not found).

- [ ] **Step 3: Implement**

In `packages/server/src/config.ts`, add above `const configSchema`:

```ts
// Comma-separated allowlist of admin emails. Trimmed and lowercased once here so
// every comparison elsewhere is a plain `includes`. Empty entries are dropped:
// ADMIN_EMAILS="," must not produce an entry that matches a user with no email.
export function parseAdminEmails(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}
```

Add inside the schema object, after `SESSION_SECRET`'s entry:

```ts
  // Who may use /api/admin/* and the portal's Admin page. Empty (the default)
  // means nobody: admin is off unless an operator names an admin.
  ADMIN_EMAILS: z.string().default("").transform(parseAdminEmails),
```

Create `packages/server/src/auth/admin.ts`:

```ts
import { config } from "../config";

// Read at call time, not import time, and tolerate a missing field: many suites
// mock `../src/config` with a hand-built object that has no ADMIN_EMAILS.
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return (config.ADMIN_EMAILS ?? []).includes(email.trim().toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-gate.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Document the variable**

Append to `.env.example` after the `SESSION_SECRET` block:

```
# Emails allowed to use the Admin page and /api/admin/*, comma-separated.
# Empty (default) = nobody is admin. Matched case-insensitively against the
# signed-in user's email. Changing it needs a restart.
# ADMIN_EMAILS=admin@example.com
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/auth/admin.ts packages/server/tests/admin-gate.test.ts .env.example
git commit -m "feat(admin): ADMIN_EMAILS allowlist and isAdminEmail"
```

---

### Task 2: `resolveAdmin` and the gated `/api/admin` scope

**Files:**
- Modify: `packages/server/src/auth/admin.ts`
- Create: `packages/server/src/api/admin-routes.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/tests/admin-routes.test.ts`

**Interfaces:**
- Consumes: `isAdminEmail` (Task 1); `verifySession(token): Promise<{userId, email}>` from `auth/session`; `getUserById(id): Promise<{id, email: string | null} | null>` from `auth/users`.
- Produces:
  ```ts
  export type AdminResult =
    | { ok: true; userId: string; email: string }
    | { ok: false; status: 401 | 403 };
  export function resolveAdmin(request: { headers: { authorization?: string } }): Promise<AdminResult>;
  export function registerAdminRoutes(app: FastifyInstance): Promise<void>;
  ```
  Routes: `GET /api/admin/ping` returns `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/admin-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    ADMIN_EMAILS: ["admin@example.com"],
  },
}));

vi.mock("../src/auth/session", () => ({
  verifySession: vi.fn((token: string) => {
    if (token === "admin-jwt") return { userId: "user-admin", email: "admin@example.com" };
    if (token === "dev-jwt") return { userId: "user-dev", email: "dev@example.com" };
    // The JWT claim says admin, but the DB (below) disagrees: DB must win.
    if (token === "claim-jwt") return { userId: "user-claim", email: "admin@example.com" };
    if (token === "ghost-jwt") return { userId: "user-ghost", email: "admin@example.com" };
    if (token === "noemail-jwt") return { userId: "user-noemail", email: "admin@example.com" };
    throw new Error("Invalid token");
  }),
}));

vi.mock("../src/auth/users", () => ({
  // An admin's MCP key resolves to a real admin user: it still must not pass.
  verifyApiKey: vi.fn(async (key: string) => (key === "admin-key" ? "user-admin" : null)),
  getUserById: vi.fn(async (id: string) => {
    if (id === "user-admin") return { id, email: "Admin@Example.com " };
    if (id === "user-dev") return { id, email: "dev@example.com" };
    if (id === "user-claim") return { id, email: "other@example.com" };
    if (id === "user-noemail") return { id, email: null };
    return null; // user-ghost: row is gone
  }),
}));

import { registerAdminRoutes } from "../src/api/admin-routes";
import { config } from "../src/config";

async function buildApp() {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app;
}

const ping = (headers: Record<string, string> = {}) => ({
  method: "GET" as const,
  url: "/api/admin/ping",
  headers,
});

beforeEach(() => {
  vi.clearAllMocks();
  config.ADMIN_EMAILS = ["admin@example.com"];
});

describe("/api/admin gate", () => {
  it("401 with no credentials", async () => {
    const res = await (await buildApp()).inject(ping());
    expect(res.statusCode).toBe(401);
  });

  it("401 for an invalid session token", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer nope" }));
    expect(res.statusCode).toBe(401);
  });

  it("401 for an admin's API key: the key path never satisfies the gate", async () => {
    const res = await (await buildApp()).inject(ping({ "x-workbench-api-key": "admin-key" }));
    expect(res.statusCode).toBe(401);
  });

  it("403 for a signed-in user who is not an admin", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer dev-jwt" }));
    expect(res.statusCode).toBe(403);
  });

  it("200 for an admin session, matching despite case and whitespace in the DB email", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer admin-jwt" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("403 when the JWT claim is an admin email but the DB email is not", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer claim-jwt" }));
    expect(res.statusCode).toBe(403);
  });

  it("401 when the session's user row no longer exists", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer ghost-jwt" }));
    expect(res.statusCode).toBe(401);
  });

  it("403 for a user with no email, even if the allowlist has an empty entry", async () => {
    config.ADMIN_EMAILS = ["", "admin@example.com"];
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer noemail-jwt" }));
    expect(res.statusCode).toBe(403);
  });

  it("403 for everyone when the allowlist is empty", async () => {
    config.ADMIN_EMAILS = [];
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer admin-jwt" }));
    expect(res.statusCode).toBe(403);
  });

  it("gates a route added later in the same scope without it opting in", async () => {
    // Routes registered by later sub-projects live in this scope. Simulate one
    // on a fresh app (the same prefix cannot be registered twice on one app).
    const { adminScopeForTest } = await import("../src/api/admin-routes");
    const app = Fastify();
    await adminScopeForTest(app, async (scope) => {
      scope.get("/later", async () => ({ secret: true }));
    });
    const anon = await app.inject({ method: "GET", url: "/api/admin/later" });
    expect(anon.statusCode).toBe(401);
    const dev = await app.inject({
      method: "GET",
      url: "/api/admin/later",
      headers: { authorization: "Bearer dev-jwt" },
    });
    expect(dev.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-routes.test.ts`
Expected: FAIL (`../src/api/admin-routes` not found).

- [ ] **Step 3: Implement `resolveAdmin`**

Append to `packages/server/src/auth/admin.ts`:

```ts
import { verifySession } from "./session";
import { getUserById } from "./users";

export type AdminResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 403 };

// Session JWT only, on purpose. The portal session is the one credential a
// human holds; an API key is what an agent holds, and an admin's agent must not
// inherit admin rights. The email comes from the DB, not the JWT claim, so a
// token minted before an email change cannot outlive it.
export async function resolveAdmin(request: {
  headers: { authorization?: string };
}): Promise<AdminResult> {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return { ok: false, status: 401 };

  let userId: string;
  try {
    userId = (await verifySession(auth.slice(7))).userId;
  } catch {
    return { ok: false, status: 401 };
  }

  const user = await getUserById(userId);
  if (!user) return { ok: false, status: 401 };
  if (!isAdminEmail(user.email)) return { ok: false, status: 403 };
  return { ok: true, userId: user.id, email: user.email as string };
}
```

(Move the two new `import` lines to the top of the file with the existing import.)

- [ ] **Step 4: Implement the gated scope**

Create `packages/server/src/api/admin-routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { resolveAdmin } from "../auth/admin";

type ScopeSetup = (scope: FastifyInstance) => Promise<void> | void;

// Everything under /api/admin lives in one encapsulated scope whose onRequest
// hook runs the gate. A route registered inside it cannot forget to check:
// there is no per-route opt-in to miss.
export async function adminScope(app: FastifyInstance, setup: ScopeSetup): Promise<void> {
  await app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
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

// Test seam: lets a test add a route to a fresh gated scope.
export const adminScopeForTest = adminScope;

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await adminScope(app, (scope) => {
    // Placeholder the sub-project 2 endpoints replace. It exists so the gate has
    // a guarded route to exercise end to end.
    scope.get("/ping", async () => ({ ok: true }));
  });
}
```

- [ ] **Step 5: Register in the server**

In `packages/server/src/index.ts`, add the import next to `registerApiRoutes`:

```ts
import { registerAdminRoutes } from "./api/admin-routes";
```

and call it right after `await registerApiRoutes(app);` (line ~53):

```ts
  await registerAdminRoutes(app);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/admin-routes.test.ts tests/admin-gate.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/auth/admin.ts packages/server/src/api/admin-routes.ts packages/server/src/index.ts packages/server/tests/admin-routes.test.ts
git commit -m "feat(admin): session-only gate for /api/admin"
```

---

### Task 3: `/api/auth/me` returns `isAdmin`

**Files:**
- Modify: `packages/server/src/api/routes.ts` (the `/api/auth/me` handler, ~line 220)
- Modify: `packages/server/tests/routes.test.ts` (the `GET /api/auth/me` block, ~line 374)

**Interfaces:**
- Consumes: `isAdminEmail` (Task 1).
- Produces: `GET /api/auth/me` response `{ id: string; email: string | null; isAdmin: boolean }`.

- [ ] **Step 1: Update the failing test**

In `packages/server/tests/routes.test.ts`, change the expectation in "returns user profile with valid JWT":

```ts
      expect(JSON.parse(res.body)).toEqual({ id: "user-1", email: "test@example.com", isAdmin: false });
```

and add inside the same `describe("GET /api/auth/me")`:

```ts
    it("reports isAdmin true when the user's email is on the allowlist", async () => {
      const { config } = await import("../src/config");
      (config as { ADMIN_EMAILS?: string[] }).ADMIN_EMAILS = ["test@example.com"];
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(JSON.parse(res.body).isAdmin).toBe(true);
      (config as { ADMIN_EMAILS?: string[] }).ADMIN_EMAILS = undefined;
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/routes.test.ts -t "auth/me"`
Expected: FAIL (response lacks `isAdmin`).

- [ ] **Step 3: Implement**

In `packages/server/src/api/routes.ts` add `import { isAdminEmail } from "../auth/admin";` with the other auth imports, and change the `/api/auth/me` return to:

```ts
    return { id: profile.id, email: profile.email, isAdmin: isAdminEmail(profile.email) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && NODE_ENV=test npx vitest run tests/routes.test.ts`
Expected: PASS. The existing mocked-config suites do not set `ADMIN_EMAILS`; `isAdminEmail` tolerates that.

- [ ] **Step 5: Run the whole server suite**

Run: `cd packages/server && NODE_ENV=test npx vitest run`
Expected: PASS, no new failures (a config mock that lacked `ADMIN_EMAILS` would fail here if `isAdminEmail` threw).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/api/routes.ts packages/server/tests/routes.test.ts
git commit -m "feat(admin): expose isAdmin on /api/auth/me"
```

---

### Task 4: Portal shell: `isAdmin`, `RequireAdmin`, Admin page, nav link

**Files:**
- Modify: `packages/portal/src/context/AuthContext.tsx`
- Create: `packages/portal/src/components/RequireAdmin.tsx`
- Create: `packages/portal/src/pages/Admin.tsx`
- Modify: `packages/portal/src/components/shell/Sidebar.tsx`
- Modify: `packages/portal/src/App.tsx`
- Test: `packages/portal/src/components/RequireAdmin.test.tsx`, `packages/portal/src/pages/Admin.test.tsx`, `packages/portal/src/components/shell/Sidebar.test.tsx` (extend)

**Interfaces:**
- Consumes: `/api/auth/me` `isAdmin` (Task 3); existing `Tabs`, `PageHeader`, `EmptyState`.
- Produces: `AuthUser.isAdmin?: boolean`; `RequireAdmin({ children })`; default export `Admin` page; Sidebar link "Admin" to `/admin`, rendered only when `user.isAdmin`.

- [ ] **Step 1: Write the failing tests**

Create `packages/portal/src/components/RequireAdmin.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import RequireAdmin from "./RequireAdmin";

const auth = vi.hoisted(() => ({
  value: { user: null as null | { id: string; email: string; isAdmin?: boolean }, isLoading: false },
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => auth.value }));

function renderAdmin() {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/admin" element={<RequireAdmin><p>secret</p></RequireAdmin>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("RequireAdmin", () => {
  it("renders children for an admin", () => {
    auth.value = { user: { id: "u1", email: "admin@example.com", isAdmin: true }, isLoading: false };
    renderAdmin();
    expect(screen.getByText("secret")).toBeInTheDocument();
  });

  it("redirects a non-admin to the home page", () => {
    auth.value = { user: { id: "u2", email: "dev@example.com", isAdmin: false }, isLoading: false };
    renderAdmin();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.getByText("home")).toBeInTheDocument();
  });

  it("treats a missing isAdmin as not admin", () => {
    auth.value = { user: { id: "u2", email: "dev@example.com" }, isLoading: false };
    renderAdmin();
    expect(screen.getByText("home")).toBeInTheDocument();
  });

  it("shows nothing privileged while the session is still loading", () => {
    auth.value = { user: null, isLoading: true };
    renderAdmin();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.queryByText("home")).not.toBeInTheDocument();
  });
});
```

Create `packages/portal/src/pages/Admin.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Admin from "./Admin";

describe("Admin page", () => {
  it("has a page title and an Overview tab selected", () => {
    render(<Admin />);
    expect(screen.getByRole("heading", { level: 1, name: "Admin" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  });
});
```

Extend `packages/portal/src/components/shell/Sidebar.test.tsx`: replace the top-level `vi.mock("../../context/AuthContext", ...)` with a hoisted, mutable one and add tests:

```tsx
const auth = vi.hoisted(() => ({
  user: { id: "u1", email: "dev@example.com", isAdmin: false } as {
    id: string; email: string; isAdmin?: boolean;
  },
}));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: auth.user, token: "t", isLoading: false, login: vi.fn(), logout: vi.fn() }),
}));
```

```tsx
  it("hides the Admin link from non-admins", () => {
    auth.user = { id: "u1", email: "dev@example.com", isAdmin: false };
    renderAt("/");
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("shows the Admin link to admins, pointing at /admin", () => {
    auth.user = { id: "u2", email: "admin@example.com", isAdmin: true };
    renderAt("/");
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
  });
```

(The existing "lists every destination" and group-order tests keep passing: Admin goes in the footer, not in `NAV_GROUPS`, and the default user is a non-admin.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/portal && npx vitest run src/components/RequireAdmin.test.tsx src/pages/Admin.test.tsx src/components/shell/Sidebar.test.tsx`
Expected: FAIL (`RequireAdmin`, `Admin` not found; no Admin link).

- [ ] **Step 3: Implement**

`packages/portal/src/context/AuthContext.tsx`: add the field.

```tsx
interface AuthUser {
  id: string;
  email: string | null;
  isAdmin?: boolean;
}
```

Create `packages/portal/src/components/RequireAdmin.tsx`:

```tsx
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

// UX only: the server's /api/admin gate is the real check. This keeps a
// non-admin from landing on a page whose every request would 403.
export default function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user?.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
```

Create `packages/portal/src/pages/Admin.tsx`:

```tsx
import { useState } from "react";
import { PageHeader } from "../components/ui/PageHeader";
import { Tabs } from "../components/ui/Tabs";
import { EmptyState } from "../components/ui/EmptyState";

// One page, one tab per admin concern. Later sub-projects append to TABS
// (Users, Config) and render their panel below.
const TABS = [{ id: "overview", label: "Overview" }];

export default function Admin() {
  const [tab, setTab] = useState("overview");
  return (
    <>
      <PageHeader title="Admin" toolbar={<Tabs items={TABS} value={tab} onChange={setTab} label="Admin sections" />} />
      {tab === "overview" && <EmptyState message="Nothing to show here yet." />}
    </>
  );
}
```

`packages/portal/src/components/shell/Sidebar.tsx`: add an icon after `SettingsIcon`:

```tsx
const AdminIcon = () => (
  <Icon>
    <path d="M8 1.5l5.5 2v4c0 3.2-2.3 5.7-5.5 7-3.2-1.3-5.5-3.8-5.5-7v-4z" />
  </Icon>
);
```

and in the footer, above the Settings link:

```tsx
        {user?.isAdmin && (
          <NavLink to="/admin" className={itemClass}>
            <AdminIcon />
            Admin
          </NavLink>
        )}
        <NavLink to="/settings" className={itemClass}>
```

`packages/portal/src/App.tsx`: import and route.

```tsx
import RequireAdmin from "./components/RequireAdmin";
import Admin from "./pages/Admin";
```

```tsx
        <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
```

(place it with the other shell routes, after `/settings`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/portal && npx vitest run`
Expected: PASS, whole portal suite.

- [ ] **Step 5: Type-check and build**

Run: `npm run build`
Expected: success for all packages.

- [ ] **Step 6: Commit**

```bash
git add packages/portal/src
git commit -m "feat(admin): portal Admin tab shell, nav link for admins"
```

---

### Task 5: Docs and finding

**Files:**
- Modify: `docs/site/_content/reference/environment.md` (Authentication and SSO table)
- Modify: `docs/site/_content/reference/http-api.md:58` (`/api/auth/me` row)
- Modify: `docs/site/_content/deploy/install.md:130-132` (the "does not exist" note)
- Create: `docs/site/_content/deploy/admin.md`
- Modify: `docs/site/nav.json` (Production group)
- Create: `docs/findings/2026-10-01-admin-gate-session-only.md`
- Modify: `CLAUDE.md` (Findings Index)

- [ ] **Step 1: Environment table row**

In the Authentication and SSO table of `environment.md`, add:

```
| `ADMIN_EMAILS` | comma-separated emails, trimmed and lowercased | `""` | no | Who may use the portal's Admin page and `/api/admin/*`. Empty means nobody. Matched against the signed-in user's stored email. Changing it needs a restart |
```

- [ ] **Step 2: HTTP API row**

In `http-api.md`, change the `/api/auth/me` row's response to `{ id, email, isAdmin }`. Add a row beneath it:

```
| GET | `/api/admin/ping` | session only (admin) | — | `{ ok }` | 401, 403 |
```

- [ ] **Step 3: Fix the now-false install note**

In `install.md`, replace the `[!NOTE] POST /api/admin/users does not exist` block with:

```
> [!NOTE] There is no admin user-creation endpoint
> `/api/admin/*` exists but is read and manage only, and only for emails in
> `ADMIN_EMAILS`. Users are created by SSO sign-in or the seed script, never
> through the admin API.
```

- [ ] **Step 4: Admin deploy page**

Create `docs/site/_content/deploy/admin.md`:

```
---
title: Admin page
description: Naming admins with ADMIN_EMAILS, what the gate accepts, and what an admin can see.
---

The portal has an **Admin** item in the sidebar, shown only to admins. It is the
same portal, not a separate app.

## Naming admins

Set `ADMIN_EMAILS` to a comma-separated list and restart:

```bash
ADMIN_EMAILS=admin@example.com,ops@example.com
```

Matching is case-insensitive and ignores surrounding spaces. Empty, the default,
means nobody is admin. There is no in-app promote or demote: the env var is the
only source, so access is revoked by removing the email and restarting.

## What the gate accepts

`/api/admin/*` accepts the **portal session only**. An API key, including an
admin's own MCP key, gets `401`, so an agent never acts as admin. A signed-in
user who is not on the list gets `403`.

The email is read from the stored user record, not from the session token, and
both SSO providers reject an unverified email, so an unverified address cannot
reach the allowlist.

> [!WARNING] The allowlist is a trust boundary
> Admin pages added later show every user's tool-call metadata and manage other
> users. List only people you would trust with that.
```

- [ ] **Step 5: Nav entry**

In `docs/site/nav.json`, in the Production group, add after the `deploy/security` item:

```json
            {
              "path": "deploy/admin",
              "label": "Admin page"
            },
```

- [ ] **Step 6: Finding and index**

Create `docs/findings/2026-10-01-admin-gate-session-only.md`:

```
# Admin gate accepts the session only

`users.is_admin` existed since the first schema and nothing read it. The admin
area derives admin from `ADMIN_EMAILS` instead.

- `authenticate()` in `api/routes.ts` accepts the API key header as well as the
  session JWT. Reusing it for `/api/admin/*` would let an admin's MCP key act as
  admin, so `resolveAdmin` verifies the session JWT directly.
- The email is compared from `users.email`, not the JWT claim.
- The gate is a Fastify `onRequest` hook on an encapsulated `/api/admin` scope,
  so a route added to it cannot omit the check.
- `parseAdminEmails` drops empty entries: `ADMIN_EMAILS=","` must not match a
  user whose email is null.
- Suites that mock `../src/config` have no `ADMIN_EMAILS`; readers tolerate
  `undefined`.
```

In `CLAUDE.md`, append to the Findings Index:

```
- [2026-10-01 admin gate session-only](docs/findings/2026-10-01-admin-gate-session-only.md) — `/api/admin/*` is gated by `ADMIN_EMAILS` and accepts the portal session only (`authenticate()` also takes an API key, which would let an admin's agent act as admin); email from the DB not the JWT; gate is a scope-level `onRequest` hook so no route can skip it
```

- [ ] **Step 7: Build the docs and verify links**

Run: `node docs/site/build.mjs`
Expected: completes with no broken-link error.

- [ ] **Step 8: Hygiene scan, then commit**

Run: `git add docs CLAUDE.md && git diff --cached | grep -inIE '@(icloud|gmail)\.com|<real-name>|<company>'`
Expected: no output.

```bash
git commit -m "docs(admin): ADMIN_EMAILS, admin page guide, finding"
```

---

## Final verification

- [ ] Run: `npm run test` and `npm run build`. Expected: all green.
- [ ] Manual: start the dev servers with `ADMIN_EMAILS` set to your SSO email. Sign in: the sidebar shows Admin, `/admin` renders the Overview tab. Unset it and restart: the link is gone and `/admin` redirects home. `curl -H "x-workbench-api-key: <your key>" localhost:3000/api/admin/ping` returns 401.
- [ ] Ship plan: this sub-project alone touches auth but not schema or Docker. Per CLAUDE.md, auth changes go out as an RC. Batch with sub-projects 2 to 4 into one RC unless you want an earlier soak.
