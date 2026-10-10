# Cookie Auto-Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a cookie-auth integration's session dies, workbench re-logs in from a plugin-declared recipe in the user's own chromium, captures fresh cookies, and retries the call.

**Architecture:** Manifest gains `session` (probe + dead rule) and `reconnect` (vault-bound credential slots + declarative steps). `ctx.http` detects a dead response and calls a single-flight runner. The runner drives a dedicated tab through a selector-based DOM layer, verifies via the probe, and stores the cookies. State lives in `connections.config` JSON (no DDL). Under a cluster, tool calls on recipe integrations are routed to the replica that owns the user's chromium, the same way `browser_*` calls already are.

**Tech Stack:** TypeScript, Fastify, zod, vitest, CDP over `ws`, React + TanStack Query (portal).

**Spec:** `docs/superpowers/specs/2026-10-10-cookie-auto-reconnect-design.md`

## Global Constraints

- Public repo. No company names, internal hosts or real emails anywhere. Fixtures use `example.com`, `acme`, `Test User`, `dev@example.com`, and secrets like `pw-abc`.
- No `Co-Authored-By` / "Generated with" trailers. The commit hook enforces this.
- No DDL. All new per-connection state goes in `connections.config` JSON under the key `reconnect`.
- Plugins without `session`/`reconnect` behave byte-for-byte as before.
- Credential plaintext reaches only `Input.insertText`. Never `Runtime.evaluate`, never an error, log line, audit row or return value.
- Cooldown after a failed attempt: 10 minutes (`RECONNECT_COOLDOWN_MS = 600_000`).
- Default whole-run timeout 30000 ms, max 120000 ms. Default per-step timeout 10000 ms.
- Error reason codes are exactly: `TIMEOUT`, `SELECTOR_NOT_FOUND`, `HOST_NOT_ALLOWED`, `CREDENTIAL_UNBOUND`, `NO_COOKIES`, `PROBE_FAILED`, `BROWSER_ERROR`.
- Server tests: `cd packages/server && npx vitest run <file>`. Shared: `cd packages/shared && npx vitest run`. Portal: `cd packages/portal && npx vitest run <file>`.
- Run `npm run build` at the repo root before the final commit of any task that touches `packages/shared`. Server imports the built shared package.

## Review Focus

- **Recipe on a page whose login form is inside an iframe or slow SPA.** `waitForSelector` must poll until timeout, not fail on the first miss. Covered in Task 4: the "polls until element appears" test.
- **Two tool calls hit the dead session in the same tick.** Exactly one recipe run. Both calls get the retried response. Covered in Task 5: the single-flight test.
- **Wrong password stored in the vault.** The probe fails, `deadAt` is set, and the next call within 10 min does NOT run the recipe again (account lockout). Covered in Task 5: the cooldown test.
- **SSO redirect lands on a host not in `allowHosts`** (e.g. the IdP's regional domain). Abort with `HOST_NOT_ALLOWED` before any `fill`, and record the failure. Covered in Task 5: the host-guard test.
- **Human is mid-connect in the live view when a call hits a dead session.** No recipe run, no failure recorded, the call returns its original response. Covered in Task 5: the busy test.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/types.ts` | `CookieConfig.session` / `.reconnect`, `ReconnectStep` types |
| `packages/shared/src/reconnect.ts` (new) | `validateCookieRecipe(auth): string[]`, a pure validator shared by the zod schema and the loader |
| `packages/shared/src/schemas.ts` | cookie branch accepts the new blocks, `superRefine` with the validator |
| `packages/server/src/plugins/loader.ts` | drops an invalid `reconnect` block with a warning |
| `packages/server/src/auth/reconnect/state.ts` (new) | read/update the `config.reconnect` JSON: bindings, `deadAt`, `last` |
| `packages/server/src/auth/cookie.ts` | `hasValidCookies` honours `deadAt`; `storeCookies` clears it |
| `packages/server/src/auth/reconnect/dead.ts` (new) | `matchesDead(res, rule, origin)` |
| `packages/server/src/auth/reconnect/dom.ts` (new) | selector wait/click/fill, url wait, current URL |
| `packages/server/src/auth/reconnect/runner.ts` (new) | `reconnectSession`: single flight, cooldown, guards, fast path, steps, verify, commit, audit |
| `packages/server/src/auth/reconnect/affinity.ts` (new) | ALS flag `runWithBrowserAffinity` / `mayOwnBrowser()`, `needsBrowserAffinity` |
| `packages/server/src/plugins/context.ts` | dead detection, reconnect, single retry |
| `packages/server/src/mcp/meta-tools.ts` | `execute_tools` pre-check reconnects a dead session |
| `packages/server/src/index.ts`, `src/api/rest-routes.ts` | route recipe integrations by affinity; set the ALS flag |
| `packages/server/src/api/routes.ts` | `PUT /api/connections/:integration/reconnect`; `autoReconnect` on `GET /api/connections`; `reconnectCredentials` on integration detail |
| `packages/portal/src/api.ts`, `src/components/AutoReconnectPanel.tsx` (new), `src/pages/AppDetail.tsx` | binding pickers and status line |
| `packages/server/tests/reconnect-*.test.ts` | unit tests per module |
| `packages/server/tests/reconnect.chromium.test.ts` | end-to-end against a local fixture app |
| `docs/site/_content/...cookie auth page`, `docs/findings/2026-10-10-cookie-auto-reconnect.md`, `CLAUDE.md` index, `packages/server/src/vault/store.ts` comment | docs |

---

### Task 1: Manifest types, validator, schema, loader guard

**Files:**
- Modify: `packages/shared/src/types.ts` (`CookieConfig`, ~line 99)
- Create: `packages/shared/src/reconnect.ts`
- Modify: `packages/shared/src/index.ts` (export the new module; check how existing modules are re-exported and follow that)
- Modify: `packages/shared/src/schemas.ts` (cookie branch, ~line 46)
- Modify: `packages/server/src/plugins/loader.ts` (where a manifest is registered)
- Test: `packages/shared/tests/reconnect.test.ts`, `packages/server/tests/loader.test.ts` (add one case)

**Interfaces:**
- Produces:
  - `ReconnectStep`, `CookieSessionConfig`, `CookieReconnectConfig`, `ReconnectCredentialSlot` types exported from `@a-workbench/shared` (verify the package name in `packages/shared/package.json`)
  - `validateCookieRecipe(auth: CookieConfig): string[]`. Empty means valid.
  - `credentialRefs(value: string): string[]`, which returns the keys referenced by `{{cred:key}}`
  - `CRED_REF_RE = /\{\{cred:([a-z0-9_]+)\}\}/g`

- [ ] **Step 1: Add the types** to `packages/shared/src/types.ts`, replacing `CookieConfig`:

```ts
export type ReconnectStep =
  | { goto: string }
  | { click: string; optional?: boolean; timeoutMs?: number }
  | { fill: string; value: string; timeoutMs?: number }
  | { press: string }
  | { waitFor: string; timeoutMs?: number }
  | { waitUrl: string; timeoutMs?: number };

export interface ReconnectCredentialSlot {
  key: string;
  label: string;
  secret?: boolean;
}

export interface CookieSessionConfig {
  /** GET path on targetDomain that proves the session is alive. */
  probe?: { path: string; alive: number[] };
  /** A ctx.http response matching this means the session is dead. */
  dead: { status: number[]; redirectTo?: string };
}

export interface CookieReconnectConfig {
  credentials?: ReconnectCredentialSlot[];
  /** Hosts outside cookieDomains the recipe may visit (the identity provider). */
  allowHosts?: string[];
  steps: ReconnectStep[];
  timeoutMs?: number;
}

export interface CookieConfig {
  type: "cookie";
  loginUrl: string;
  targetDomain: string;
  cookieDomains?: string[];
  session?: CookieSessionConfig;
  reconnect?: CookieReconnectConfig;
}
```

- [ ] **Step 2: Write the failing validator tests** at `packages/shared/tests/reconnect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateCookieRecipe, credentialRefs } from "../src/reconnect";
import type { CookieConfig } from "../src/types";

const base: CookieConfig = {
  type: "cookie",
  loginUrl: "https://app.example.com/login",
  targetDomain: "app.example.com",
  cookieDomains: ["app.example.com"],
};

describe("validateCookieRecipe", () => {
  it("accepts a cookie config without recipe blocks", () => {
    expect(validateCookieRecipe(base)).toEqual([]);
  });

  it("accepts an SSO recipe", () => {
    expect(validateCookieRecipe({
      ...base,
      session: { probe: { path: "/api/me", alive: [200] }, dead: { status: [401, 302] } },
      reconnect: {
        allowHosts: ["idp.example.net"],
        steps: [
          { goto: "loginUrl" },
          { click: "text=Sign in with SSO" },
          { click: "[data-email]", optional: true, timeoutMs: 3000 },
          { waitUrl: "https://app.example.com/home" },
        ],
      },
    })).toEqual([]);
  });

  it("accepts a password recipe", () => {
    expect(validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: {
        credentials: [{ key: "username", label: "Username" }, { key: "password", label: "Password", secret: true }],
        steps: [
          { goto: "loginUrl" },
          { fill: "#user", value: "{{cred:username}}" },
          { fill: "#pass", value: "{{cred:password}}" },
          { press: "Enter" },
          { waitUrl: "/" },
        ],
      },
    })).toEqual([]);
  });

  it("rejects reconnect without session.dead", () => {
    const errs = validateCookieRecipe({ ...base, reconnect: { steps: [{ goto: "loginUrl" }] } });
    expect(errs.join()).toMatch(/session\.dead/);
  });

  it("rejects an empty step list", () => {
    const errs = validateCookieRecipe({ ...base, session: { dead: { status: [401] } }, reconnect: { steps: [] } });
    expect(errs.join()).toMatch(/steps/);
  });

  it("rejects {{cred:x}} outside a fill value", () => {
    const errs = validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: { credentials: [{ key: "u", label: "U" }], steps: [{ goto: "/login?u={{cred:u}}" }] },
    });
    expect(errs.join()).toMatch(/only allowed in fill/);
  });

  it("rejects an undeclared credential key", () => {
    const errs = validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: { steps: [{ fill: "#p", value: "{{cred:password}}" }] },
    });
    expect(errs.join()).toMatch(/undeclared credential "password"/);
  });

  it("rejects goto to an undeclared host", () => {
    const errs = validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: { steps: [{ goto: "https://evil.example.org/login" }] },
    });
    expect(errs.join()).toMatch(/evil\.example\.org/);
  });

  it("rejects timeoutMs above 120000", () => {
    const errs = validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: { timeoutMs: 500_000, steps: [{ goto: "loginUrl" }] },
    });
    expect(errs.join()).toMatch(/timeoutMs/);
  });
});

describe("credentialRefs", () => {
  it("lists referenced keys", () => {
    expect(credentialRefs("{{cred:a}}-{{cred:b_2}}")).toEqual(["a", "b_2"]);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd packages/shared && npx vitest run tests/reconnect.test.ts`
Expected: FAIL. Cannot find module `../src/reconnect`.

- [ ] **Step 4: Implement** `packages/shared/src/reconnect.ts`:

```ts
import type { CookieConfig, ReconnectStep } from "./types";

export const CRED_REF_RE = /\{\{cred:([a-z0-9_]+)\}\}/g;
export const RECONNECT_MAX_TIMEOUT_MS = 120_000;

export function credentialRefs(value: string): string[] {
  return [...value.matchAll(CRED_REF_RE)].map((m) => m[1]);
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((d) => host === d || host.endsWith("." + d));
}

/** Every string-valued field of a step except fill.value. */
function nonFillStrings(step: ReconnectStep): string[] {
  return Object.entries(step)
    .filter(([k, v]) => typeof v === "string" && !("fill" in step && k === "value"))
    .map(([, v]) => v as string);
}

/**
 * Structural checks the type system cannot express. Returned messages are for
 * plugin authors (logged at load), so they name the step index.
 */
export function validateCookieRecipe(auth: CookieConfig): string[] {
  const errs: string[] = [];
  const r = auth.reconnect;
  if (!r) return errs;
  if (!auth.session?.dead) errs.push("reconnect requires session.dead");
  if (!Array.isArray(r.steps) || r.steps.length === 0) errs.push("reconnect.steps must be non-empty");
  if (r.timeoutMs !== undefined && (r.timeoutMs <= 0 || r.timeoutMs > RECONNECT_MAX_TIMEOUT_MS)) {
    errs.push(`reconnect.timeoutMs must be in (0, ${RECONNECT_MAX_TIMEOUT_MS}]`);
  }
  const declared = new Set((r.credentials ?? []).map((c) => c.key));
  const allowed = [auth.targetDomain, ...(auth.cookieDomains ?? []), ...(r.allowHosts ?? [])]
    .map((d) => d.replace(/^\./, "").toLowerCase());

  (r.steps ?? []).forEach((step, i) => {
    for (const s of nonFillStrings(step)) {
      if (credentialRefs(s).length) errs.push(`step ${i}: {{cred:…}} is only allowed in fill.value`);
    }
    if ("fill" in step) {
      for (const key of credentialRefs(step.value)) {
        if (!declared.has(key)) errs.push(`step ${i}: undeclared credential "${key}"`);
      }
    }
    const url = "goto" in step ? step.goto : "waitUrl" in step ? step.waitUrl : null;
    if (url && url !== "loginUrl" && /^https?:\/\//i.test(url)) {
      const host = hostOf(url);
      if (!host || !hostAllowed(host, allowed)) {
        errs.push(`step ${i}: host ${host ?? url} not in targetDomain/cookieDomains/allowHosts`);
      }
    }
  });
  return errs;
}
```

Export it from `packages/shared/src/index.ts`, following the existing re-export style.

- [ ] **Step 5: Extend the zod cookie branch** in `packages/shared/src/schemas.ts`. Replace the cookie `z.object` with:

```ts
    z.object({
      type: z.literal("cookie"),
      loginUrl: z.string().url(),
      targetDomain: z.string(),
      cookieDomains: z.array(z.string()).optional(),
      session: z.object({
        probe: z.object({ path: z.string().startsWith("/"), alive: z.array(z.number().int()).min(1) }).optional(),
        dead: z.object({ status: z.array(z.number().int()).min(1), redirectTo: z.string().optional() }),
      }).optional(),
      reconnect: z.object({
        credentials: z.array(z.object({
          key: z.string().regex(/^[a-z0-9_]+$/),
          label: z.string(),
          secret: z.boolean().optional(),
        })).optional(),
        allowHosts: z.array(z.string()).optional(),
        steps: z.array(z.union([
          z.object({ goto: z.string() }).strict(),
          z.object({ click: z.string(), optional: z.boolean().optional(), timeoutMs: z.number().int().positive().optional() }).strict(),
          z.object({ fill: z.string(), value: z.string(), timeoutMs: z.number().int().positive().optional() }).strict(),
          z.object({ press: z.string() }).strict(),
          z.object({ waitFor: z.string(), timeoutMs: z.number().int().positive().optional() }).strict(),
          z.object({ waitUrl: z.string(), timeoutMs: z.number().int().positive().optional() }).strict(),
        ])),
        timeoutMs: z.number().int().positive().optional(),
      }).optional(),
    }).superRefine((auth, ctx) => {
      for (const message of validateCookieRecipe(auth as CookieConfig)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["reconnect"] });
      }
    }),
```

Import `validateCookieRecipe` and the `CookieConfig` type at the top. `auth` is a `z.union`, not a `discriminatedUnion`, so the `ZodEffects` member is fine.

Append to `packages/shared/tests/schemas.test.ts`:

```ts
  it("rejects a cookie recipe with an undeclared credential", () => {
    const r = integrationSchema.safeParse({
      name: "acme", version: "1.0.0",
      auth: {
        type: "cookie", loginUrl: "https://app.example.com/login", targetDomain: "app.example.com",
        session: { dead: { status: [401] } },
        reconnect: { steps: [{ fill: "#p", value: "{{cred:password}}" }] },
      },
    });
    expect(r.success).toBe(false);
  });
```

- [ ] **Step 6: Run the shared tests**

Run: `cd packages/shared && npx vitest run`
Expected: PASS (all).

- [ ] **Step 7: Loader guard.** In `packages/server/src/plugins/loader.ts`, find where a loaded manifest is handed to the registry. Before that, add:

```ts
import { validateCookieRecipe } from "@a-workbench/shared"; // match the existing shared import path in this file

// Manifests are not schema-validated at load; a broken recipe would otherwise
// surface as a confusing failure on the first dead session. Drop it loudly and
// keep the integration (manual reconnect still works).
function stripInvalidRecipe(manifest: { name: string; auth: { type: string } }): void {
  if (manifest.auth.type !== "cookie") return;
  const auth = manifest.auth as import("@a-workbench/shared").CookieConfig;
  const errs = validateCookieRecipe(auth);
  if (errs.length) {
    console.warn(`[plugins] ${manifest.name}: reconnect recipe disabled — ${errs.join("; ")}`);
    delete auth.reconnect;
  }
}
```

Call `stripInvalidRecipe(manifest)` for every manifest, built-in and `PLUGINS_DIR`.

Add a test to `packages/server/tests/loader.test.ts`. Read the file first and follow its fixture style for a plugin with an in-memory or temp-dir manifest. The test asserts that a cookie manifest with `reconnect` but no `session` loads, and that the registered integration has `auth.reconnect === undefined`. If the loader has no seam for that, export `stripInvalidRecipe` and unit-test it directly:

```ts
it("strips an invalid reconnect recipe but keeps the integration", () => {
  const m = { name: "acme", auth: { type: "cookie", loginUrl: "https://app.example.com/l", targetDomain: "app.example.com", reconnect: { steps: [{ goto: "loginUrl" }] } } } as any;
  stripInvalidRecipe(m);
  expect(m.auth.reconnect).toBeUndefined();
  expect(m.auth.loginUrl).toBe("https://app.example.com/l");
});
```

- [ ] **Step 8: Build and run the server tests touched**

Run: `npm run build && cd packages/server && npx vitest run tests/loader.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/shared packages/server/src/plugins/loader.ts packages/server/tests/loader.test.ts
git commit -m "feat(shared): cookie auth session + reconnect recipe manifest contract"
```

---

### Task 2: Reconnect state in `connections.config`

**Files:**
- Create: `packages/server/src/auth/reconnect/state.ts`
- Modify: `packages/server/src/auth/cookie.ts` (`storeCookies`, `hasValidCookies`)
- Test: `packages/server/tests/reconnect-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ReconnectState {
    bindings?: Record<string, string>;
    deadAt?: number;   // epoch ms
    last?: { at: number; ok: boolean; error?: string };  // at = epoch ms
  }
  export async function getReconnectState(userId: string, integration: string): Promise<ReconnectState>;
  export async function updateReconnectState(userId: string, integration: string, patch: Partial<ReconnectState>): Promise<void>;  // shallow merge; a key set to undefined is removed
  ```
- `hasValidCookies` returns false when `deadAt` is set.
- `storeCookies` clears `deadAt` (keeps `bindings` and `last`).

- [ ] **Step 1: Write the failing tests** at `packages/server/tests/reconnect-state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { storeCookies, hasValidCookies } from "../src/auth/cookie";
import { getReconnectState, updateReconnectState } from "../src/auth/reconnect/state";
import { getConnectionConfig } from "../src/auth/tokens";

const U = "user-reconnect-state";
const I = "acme-cookie";
const cookies = {
  domain: "app.example.com",
  cookies: [{ name: "sid", value: "tok-abc", domain: "app.example.com", path: "/", expires: 9999999999 }],
  capturedAt: 1,
};

describe("reconnect state", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM connections WHERE user_id = ?", [U]);
  });

  it("is empty when there is no connection row", async () => {
    expect(await getReconnectState(U, I)).toEqual({});
  });

  it("merges patches and preserves other config keys", async () => {
    await storeCookies(U, I, cookies);
    await db.run("UPDATE connections SET config = ? WHERE user_id = ? AND integration = ?", [JSON.stringify({ instanceUrl: "x" }), U, I]);
    await updateReconnectState(U, I, { bindings: { password: "acme_pw" } });
    await updateReconnectState(U, I, { deadAt: 123 });
    expect(await getReconnectState(U, I)).toEqual({ bindings: { password: "acme_pw" }, deadAt: 123 });
    expect(JSON.parse((await getConnectionConfig(U, I))!).instanceUrl).toBe("x");
  });

  it("removes keys patched to undefined", async () => {
    await storeCookies(U, I, cookies);
    await updateReconnectState(U, I, { deadAt: 1 });
    await updateReconnectState(U, I, { deadAt: undefined });
    expect(await getReconnectState(U, I)).toEqual({});
  });

  it("hasValidCookies is false while deadAt is set", async () => {
    await storeCookies(U, I, cookies);
    expect(await hasValidCookies(U, I)).toBe(true);
    await updateReconnectState(U, I, { deadAt: Date.now() });
    expect(await hasValidCookies(U, I)).toBe(false);
  });

  it("storeCookies clears deadAt but keeps bindings", async () => {
    await storeCookies(U, I, cookies);
    await updateReconnectState(U, I, { deadAt: 1, bindings: { password: "acme_pw" } });
    await storeCookies(U, I, cookies);
    expect(await getReconnectState(U, I)).toEqual({ bindings: { password: "acme_pw" } });
  });

  it("tolerates a non-JSON config", async () => {
    await storeCookies(U, I, cookies);
    await db.run("UPDATE connections SET config = 'not json' WHERE user_id = ?", [U]);
    expect(await getReconnectState(U, I)).toEqual({});
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing)

Run: `cd packages/server && npx vitest run tests/reconnect-state.test.ts`

- [ ] **Step 3: Implement** `packages/server/src/auth/reconnect/state.ts`:

```ts
import { db } from "../../db";

// Auto-reconnect state rides in connections.config (JSON text) under the
// `reconnect` key, beside whatever per-connection config the plugin already
// keeps there. No DDL: see docs/superpowers/specs/2026-10-10-cookie-auto-reconnect-design.md.

export interface ReconnectState {
  /** credential slot key -> vault entry name (names, never values) */
  bindings?: Record<string, string>;
  /** epoch ms when the session was found dead and not recovered */
  deadAt?: number;
  last?: { at: number; ok: boolean; error?: string };
}

async function readConfig(userId: string, integration: string): Promise<Record<string, unknown> | null> {
  const row = await db.get<{ config: string | null }>(
    "SELECT config FROM connections WHERE user_id = ? AND integration = ?",
    [userId, integration]
  );
  if (!row) return null;
  if (!row.config) return {};
  try {
    const parsed = JSON.parse(row.config) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function getReconnectState(userId: string, integration: string): Promise<ReconnectState> {
  const cfg = await readConfig(userId, integration);
  const r = cfg?.reconnect;
  return r && typeof r === "object" ? (r as ReconnectState) : {};
}

/** Shallow-merge `patch` into the state. No-op when there is no connection row. */
export async function updateReconnectState(
  userId: string,
  integration: string,
  patch: Partial<ReconnectState>
): Promise<void> {
  const cfg = await readConfig(userId, integration);
  if (cfg === null) return;
  const next: Record<string, unknown> = { ...((cfg.reconnect as object) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const out = { ...cfg };
  if (Object.keys(next).length) out.reconnect = next;
  else delete out.reconnect;
  await db.run(
    "UPDATE connections SET config = ? WHERE user_id = ? AND integration = ?",
    [Object.keys(out).length ? JSON.stringify(out) : null, userId, integration]
  );
}
```

- [ ] **Step 4: Wire it into `cookie.ts`.** In `packages/server/src/auth/cookie.ts`:

```ts
import { getReconnectState, updateReconnectState } from "./reconnect/state";
```

At the end of `storeCookies`, after the upsert:

```ts
  // Fresh cookies (manual connect, import, or auto-reconnect) end a dead spell.
  await updateReconnectState(userId, integration, { deadAt: undefined });
```

Replace `hasValidCookies`:

```ts
export async function hasValidCookies(userId: string, integration: string): Promise<boolean> {
  const data = await getCookies(userId, integration);
  if (!data || isCookieExpired(data)) return false;
  return !(await getReconnectState(userId, integration)).deadAt;
}
```

- [ ] **Step 5: Run the new and existing cookie tests**

Run: `cd packages/server && npx vitest run tests/reconnect-state.test.ts tests/cookie.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth/reconnect/state.ts packages/server/src/auth/cookie.ts packages/server/tests/reconnect-state.test.ts
git commit -m "feat(cookie): per-connection reconnect state in connections.config"
```

---

### Task 3: Dead-response matcher

**Files:**
- Create: `packages/server/src/auth/reconnect/dead.ts`
- Test: `packages/server/tests/reconnect-dead.test.ts`

**Interfaces:**
- Produces: `export function matchesDead(res: Response, rule: CookieSessionConfig["dead"], requestUrl: string): boolean`

- [ ] **Step 1: Failing test** at `packages/server/tests/reconnect-dead.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchesDead } from "../src/auth/reconnect/dead";

const r = (status: number, location?: string) =>
  new Response(null, { status, headers: location ? { location } : {} });
const URL_ = "https://app.example.com/api/x";

describe("matchesDead", () => {
  it("matches a listed status", () => {
    expect(matchesDead(r(401), { status: [401] }, URL_)).toBe(true);
  });
  it("ignores an unlisted status", () => {
    expect(matchesDead(r(403), { status: [401] }, URL_)).toBe(false);
    expect(matchesDead(r(200), { status: [401] }, URL_)).toBe(false);
  });
  it("with redirectTo, a 3xx must point at that path", () => {
    const rule = { status: [302], redirectTo: "/login" };
    expect(matchesDead(r(302, "/login?next=/x"), rule, URL_)).toBe(true);
    expect(matchesDead(r(302, "https://app.example.com/login"), rule, URL_)).toBe(true);
    expect(matchesDead(r(302, "/dashboard"), rule, URL_)).toBe(false);
    expect(matchesDead(r(302), rule, URL_)).toBe(false);
  });
  it("redirectTo does not constrain non-3xx statuses", () => {
    expect(matchesDead(r(401), { status: [401, 302], redirectTo: "/login" }, URL_)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `cd packages/server && npx vitest run tests/reconnect-dead.test.ts`

- [ ] **Step 3: Implement** `packages/server/src/auth/reconnect/dead.ts`:

```ts
import type { CookieSessionConfig } from "@a-workbench/shared"; // match the server's existing shared import path

export function matchesDead(
  res: Response,
  rule: CookieSessionConfig["dead"],
  requestUrl: string
): boolean {
  if (!rule.status.includes(res.status)) return false;
  if (!rule.redirectTo || res.status < 300 || res.status >= 400) return true;
  const loc = res.headers.get("location");
  if (!loc) return false;
  try {
    return new URL(loc, requestUrl).pathname.startsWith(rule.redirectTo);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/reconnect/dead.ts packages/server/tests/reconnect-dead.test.ts
git commit -m "feat(cookie): dead-session response matcher"
```

---

### Task 4: Selector-based DOM layer

**Files:**
- Create: `packages/server/src/auth/reconnect/dom.ts`
- Test: `packages/server/tests/reconnect-dom.test.ts`

**Interfaces:**
- Consumes: `PageHandle`, `click(s, x, y)`, `typeText(s, text)` from `src/auth/browser-session.ts`
- Produces:
  ```ts
  export class StepError extends Error { constructor(public reason: ReconnectReason, message?: string) }
  export type ReconnectReason = "TIMEOUT" | "SELECTOR_NOT_FOUND" | "HOST_NOT_ALLOWED" | "CREDENTIAL_UNBOUND" | "NO_COOKIES" | "PROBE_FAILED" | "BROWSER_ERROR";
  export async function waitForSelector(page: PageHandle, selector: string, timeoutMs: number): Promise<{ x: number; y: number }>;  // throws StepError("SELECTOR_NOT_FOUND")
  export async function clickSelector(page: PageHandle, selector: string, timeoutMs: number): Promise<void>;
  export async function fillSelector(page: PageHandle, selector: string, value: string, timeoutMs: number): Promise<void>;
  export async function waitForUrl(page: PageHandle, prefix: string, timeoutMs: number): Promise<void>;  // throws StepError("TIMEOUT")
  export async function currentUrl(page: PageHandle): Promise<string>;
  export const POLL_MS = 150;
  ```

The selector is passed into page JS via `JSON.stringify`. The fill **value** is never passed into page JS; only `Input.insertText` receives it.

- [ ] **Step 1: Failing tests** at `packages/server/tests/reconnect-dom.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { PageHandle } from "../src/auth/browser-session";
import { waitForSelector, clickSelector, fillSelector, waitForUrl, StepError } from "../src/auth/reconnect/dom";

function page(send: (method: string, params?: any) => any): PageHandle {
  return { cdp: { send: vi.fn(async (m: string, p?: any) => send(m, p)) } } as unknown as PageHandle;
}

describe("reconnect dom", () => {
  it("polls until the element appears", async () => {
    let calls = 0;
    const p = page((m) => {
      if (m !== "Runtime.evaluate") return {};
      calls += 1;
      return { result: { value: calls < 3 ? null : { x: 10, y: 20 } } };
    });
    await expect(waitForSelector(p, "#user", 2000)).resolves.toEqual({ x: 10, y: 20 });
    expect(calls).toBe(3);
  });

  it("throws SELECTOR_NOT_FOUND after the timeout", async () => {
    const p = page(() => ({ result: { value: null } }));
    const err = await waitForSelector(p, "#nope", 200).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.reason).toBe("SELECTOR_NOT_FOUND");
  });

  it("clickSelector dispatches a mouse press at the element centre", async () => {
    const p = page((m) => (m === "Runtime.evaluate" ? { result: { value: { x: 5, y: 6 } } } : {}));
    await clickSelector(p, "text=Sign in", 500);
    expect(p.cdp.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.objectContaining({ type: "mousePressed", x: 5, y: 6 }));
  });

  it("fillSelector never puts the value into evaluated JS", async () => {
    const p = page((m) => (m === "Runtime.evaluate" ? { result: { value: { x: 1, y: 1 } } } : {}));
    await fillSelector(p, "#pass", "pw-abc", 500);
    const calls = (p.cdp.send as any).mock.calls as [string, any][];
    for (const [m, params] of calls) {
      if (m === "Runtime.evaluate") expect(params.expression).not.toContain("pw-abc");
    }
    expect(calls).toContainEqual(["Input.insertText", { text: "pw-abc" }]);
  });

  it("waitForUrl resolves on prefix match and times out otherwise", async () => {
    const p = page(() => ({ result: { value: "https://app.example.com/home?x=1" } }));
    await expect(waitForUrl(p, "https://app.example.com/home", 300)).resolves.toBeUndefined();
    const err = await waitForUrl(p, "https://app.example.com/other", 200).catch((e) => e);
    expect(err.reason).toBe("TIMEOUT");
  });

  it("waitForUrl accepts a path prefix", async () => {
    const p = page(() => ({ result: { value: "https://app.example.com/home" } }));
    await expect(waitForUrl(p, "/home", 300)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `cd packages/server && npx vitest run tests/reconnect-dom.test.ts`

- [ ] **Step 3: Implement** `packages/server/src/auth/reconnect/dom.ts`:

```ts
import { click, typeText, type PageHandle } from "../browser-session";

export type ReconnectReason =
  | "TIMEOUT" | "SELECTOR_NOT_FOUND" | "HOST_NOT_ALLOWED" | "CREDENTIAL_UNBOUND"
  | "NO_COOKIES" | "PROBE_FAILED" | "BROWSER_ERROR";

export class StepError extends Error {
  constructor(public reason: ReconnectReason, message?: string) {
    super(message ?? reason);
  }
}

export const POLL_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Locate a visible, enabled element and return its viewport centre, or null.
// `text=Label` matches clickable elements by case-insensitive visible text.
function locateExpr(selector: string): string {
  return `(() => {
    const sel = ${JSON.stringify(selector)};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.disabled;
    };
    let el = null;
    if (sel.startsWith("text=")) {
      const want = sel.slice(5).trim().toLowerCase();
      const cands = document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]');
      el = [...cands].find((c) => visible(c) && ((c.innerText || c.value || "").trim().toLowerCase().includes(want))) || null;
    } else {
      el = [...document.querySelectorAll(sel)].find(visible) || null;
    }
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}

async function evalValue(page: PageHandle, expression: string): Promise<unknown> {
  const r = (await page.cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as {
    result?: { value?: unknown };
  };
  return r.result?.value;
}

export async function waitForSelector(page: PageHandle, selector: string, timeoutMs: number): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A navigation mid-poll destroys the execution context; treat as "not yet".
    const v = await evalValue(page, locateExpr(selector)).catch(() => null);
    if (v && typeof v === "object") return v as { x: number; y: number };
    if (Date.now() >= deadline) throw new StepError("SELECTOR_NOT_FOUND");
    await sleep(POLL_MS);
  }
}

export async function clickSelector(page: PageHandle, selector: string, timeoutMs: number): Promise<void> {
  const { x, y } = await waitForSelector(page, selector, timeoutMs);
  await click(page, x, y);
}

export async function fillSelector(page: PageHandle, selector: string, value: string, timeoutMs: number): Promise<void> {
  const { x, y } = await waitForSelector(page, selector, timeoutMs);
  await click(page, x, y);
  // Clear without touching the value: select the field's content, then insert.
  await evalValue(page, `(() => { const el = document.activeElement; if (el && "select" in el) el.select(); })()`);
  await typeText(page, value);
}

export async function currentUrl(page: PageHandle): Promise<string> {
  const v = await evalValue(page, "location.href").catch(() => "");
  return typeof v === "string" ? v : "";
}

export async function waitForUrl(page: PageHandle, prefix: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const href = await currentUrl(page);
    if (href) {
      if (/^https?:\/\//i.test(prefix) ? href.startsWith(prefix) : safePath(href).startsWith(prefix)) return;
    }
    if (Date.now() >= deadline) throw new StepError("TIMEOUT");
    await sleep(POLL_MS);
  }
}

function safePath(href: string): string {
  try { return new URL(href).pathname; } catch { return ""; }
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/reconnect/dom.ts packages/server/tests/reconnect-dom.test.ts
git commit -m "feat(cookie): selector-based CDP helpers for reconnect recipes"
```

---

### Task 5: Reconnect runner

**Files:**
- Create: `packages/server/src/auth/reconnect/affinity.ts` (only the ALS part; Task 7 adds `needsBrowserAffinity`)
- Create: `packages/server/src/auth/reconnect/runner.ts`
- Modify: `packages/server/src/vault/store.ts` (header comment: add the runner as a third caller of `readSecretValue`)
- Test: `packages/server/tests/reconnect-runner.test.ts`

**Interfaces:**
- Consumes: Task 2 state, Task 4 DOM, `openTab`/`closeTab`/`getTab`/`captureLiveCookies`/`getWarmSession` from `browser-session.ts`, `activeProfiles` from `profile-chromium.ts`, `storeCookies`/`filterCookies` from `cookie.ts`, `readSecretValue`/`touchUsed` from `vault/store.ts`, `auditLogger` from `audit/logger.ts`, `registry` from `plugins/registry.ts`, `config.INTERNAL_MCP_URL`.
- Produces:
  ```ts
  // affinity.ts
  export function runWithBrowserAffinity<T>(fn: () => T): T;
  export function mayOwnBrowser(): boolean;  // true when !config.INTERNAL_MCP_URL, or inside runWithBrowserAffinity
  // runner.ts
  export const RECONNECT_COOLDOWN_MS = 600_000;
  export type ReconnectOutcome = { ok: true } | { ok: false; reason: ReconnectReason | "COOLDOWN" | "BUSY" | "NOT_OWNER" | "NO_RECIPE"; step?: number };
  export async function reconnectSession(userId: string, integration: string): Promise<ReconnectOutcome>;
  export function canAttemptReconnect(state: ReconnectState, now?: number): boolean;  // false inside cooldown
  // test seam
  export const __deps: { probe: (url: string, cookieHeader: string) => Promise<number> };
  ```

Runner algorithm (the spec's §4, exact):
1. `auth = registry.getIntegration(integration)?.auth`. If it is not a cookie auth with `reconnect`, return `NO_RECIPE`.
2. If `!mayOwnBrowser()`, then `updateReconnectState(deadAt: Date.now())` and return `NOT_OWNER`. This branch writes no `last` and no audit row.
3. Single flight: `locks: Map<string, Promise<ReconnectOutcome>>` keyed `${userId}:${integration}`. Concurrent callers await the same promise. `void p.finally(() => locks.delete(key)).catch(() => {})`.
4. Inside the flight, in order:
   - Cooldown: if `!canAttemptReconnect(state)`, return `COOLDOWN`. No state change.
   - Busy: if `activeProfiles.has(userId)`, return `BUSY`. No state change.
5. Fast path, only when `session.probe` exists and a warm session exists (`getWarmSession(userId)`): capture cookies, build the header, and probe. If the probe is alive, commit (step 8).
6. Steps: `openTab(userId)`, then run each step under the overall deadline (`timeoutMs ?? 30000`). A step's timeout is `min(step.timeoutMs ?? 10000, remaining)`. Before each step, and again before the `insertText` of a fill, the `currentUrl` host must be allowlisted. `about:blank` is allowed before the first `goto`. `goto`: `"loginUrl"` maps to `auth.loginUrl`, a path resolves against `https://${targetDomain}`, and navigation uses `cdp.send("Page.navigate", {url})` followed by a 500 ms settle. `press`: `pressKey`. An optional click that hits `SELECTOR_NOT_FOUND` is skipped. Any non-`StepError` exception becomes `BROWSER_ERROR`.
7. Verify: capture cookies; if there are none, `NO_COOKIES`. If there is a probe, it must return a status in `alive`, else `PROBE_FAILED`. Without a probe, the current URL must not start with `loginUrl`, else `PROBE_FAILED`.
8. Commit: `storeCookies(...)` (clears `deadAt`), then `updateReconnectState({ last: { at: now, ok: true } })`, then an audit `REFRESH` row with success true.
9. Failure: `updateReconnectState({ deadAt: now, last: { at: now, ok: false, error: \`step ${i}: ${reason}\` } })` plus an audit `REFRESH` row with success false and `error: reason`. Steps 7 and 8 errors use `step` = `-1`, written as `verify: REASON`.
10. `finally`: `closeTab(userId, tab.id)` if a tab was opened.

- [ ] **Step 1: Failing tests** at `packages/server/tests/reconnect-runner.test.ts`. Mock modules with `vi.mock` so no chromium runs:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const pageState = { url: "about:blank", redirect: undefined as string | undefined, elements: new Set<string>(), afterLogin: () => {} };
const sent: [string, any][] = [];
const fakeTab = {
  id: "tab-1",
  cdp: {
    send: vi.fn(async (m: string, p?: any) => {
      sent.push([m, p]);
      if (m === "Page.navigate") { pageState.url = pageState.redirect ?? p.url; return {}; }
      if (m === "Runtime.evaluate") {
        const expr: string = p.expression;
        if (expr === "location.href") return { result: { value: pageState.url } };
        const sel = /const sel = ("(?:[^"\\]|\\.)*");/.exec(expr)?.[1];
        if (sel) return { result: { value: pageState.elements.has(JSON.parse(sel)) ? { x: 1, y: 1 } : null } };
        return { result: {} };
      }
      if (m === "Input.dispatchKeyEvent" && p.type === "rawKeyDown") pageState.afterLogin();
      return {};
    }),
  },
};

const live = { cookies: [] as any[] };
vi.mock("../src/auth/browser-session", async (orig) => ({
  ...(await orig<typeof import("../src/auth/browser-session")>()),
  openTab: vi.fn(async () => ({ ok: true, tab: fakeTab })),
  closeTab: vi.fn(async () => true),
  getWarmSession: vi.fn(() => ({})),
  captureLiveCookies: vi.fn(async (_u: string, d: string) => ({ domain: d, cookies: live.cookies, capturedAt: 1 })),
}));
const vault: Record<string, string> = {};
vi.mock("../src/vault/store", async (orig) => ({
  ...(await orig<typeof import("../src/vault/store")>()),
  readSecretValue: vi.fn(async (_u: string, n: string) => vault[n] ?? null),
  touchUsed: vi.fn(async () => {}),
}));
const auditLog = vi.fn(async () => {});
vi.mock("../src/audit/logger", () => ({ auditLogger: { log: auditLog } }));

import { db } from "../src/db";
import { registry } from "../src/plugins/registry";
import { activeProfiles } from "../src/auth/profile-chromium";
import { storeCookies } from "../src/auth/cookie";
import { getReconnectState, updateReconnectState } from "../src/auth/reconnect/state";
import { reconnectSession, __deps, RECONNECT_COOLDOWN_MS } from "../src/auth/reconnect/runner";

const U = "user-runner";
const I = "acme-cookie";
const auth = {
  type: "cookie" as const,
  loginUrl: "https://app.example.com/login",
  targetDomain: "app.example.com",
  cookieDomains: ["app.example.com"],
  session: { probe: { path: "/api/me", alive: [200] }, dead: { status: [401] } },
  reconnect: {
    credentials: [{ key: "username", label: "U" }, { key: "password", label: "P", secret: true }],
    steps: [
      { goto: "loginUrl" },
      { fill: "#user", value: "{{cred:username}}" },
      { fill: "#pass", value: "{{cred:password}}" },
      { press: "Enter" },
    ],
    timeoutMs: 3000,
  },
};
const goodCookie = { name: "sid", value: "tok-new", domain: "app.example.com", path: "/", expires: 9999999999 };

beforeEach(async () => {
  sent.length = 0;
  auditLog.mockClear();
  pageState.url = "about:blank";
  pageState.redirect = undefined;
  pageState.elements = new Set(["#user", "#pass"]);
  pageState.afterLogin = () => { live.cookies = [goodCookie]; probeStatus = 200; };
  live.cookies = [];
  let probeStatus = 401;
  __deps.probe = vi.fn(async () => probeStatus);
  Object.assign(vault, { acme_user: "dev@example.com", acme_pw: "pw-abc" });
  activeProfiles.clear?.();
  vi.spyOn(registry, "getIntegration").mockReturnValue({ name: I, version: "1", auth } as any);
  await db.run("DELETE FROM connections WHERE user_id = ?", [U]);
  await storeCookies(U, I, { domain: "app.example.com", cookies: [{ ...goodCookie, value: "tok-old" }], capturedAt: 1 });
  await updateReconnectState(U, I, { bindings: { username: "acme_user", password: "acme_pw" } });
});

describe("reconnectSession", () => {
  it("runs the recipe, stores new cookies and records success", async () => {
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    expect(sent).toContainEqual(["Input.insertText", { text: "pw-abc" }]);
    const st = await getReconnectState(U, I);
    expect(st.deadAt).toBeUndefined();
    expect(st.last?.ok).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "REFRESH", success: true, integration: I }));
  });

  it("fast path: a live profile session skips the steps", async () => {
    live.cookies = [goodCookie];
    (__deps.probe as any).mockResolvedValue(200);
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    expect(sent.find(([m]) => m === "Page.navigate")).toBeUndefined();
  });

  it("single flight: concurrent calls share one run", async () => {
    const [a, b, c] = await Promise.all([reconnectSession(U, I), reconnectSession(U, I), reconnectSession(U, I)]);
    expect([a, b, c]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(sent.filter(([m, p]) => m === "Input.insertText" && p.text === "pw-abc")).toHaveLength(1);
  });

  it("wrong password: records failure and then honours the cooldown", async () => {
    pageState.afterLogin = () => {}; // login does nothing
    const first = await reconnectSession(U, I);
    expect(first).toMatchObject({ ok: false, reason: "NO_COOKIES" });
    const st = await getReconnectState(U, I);
    expect(st.deadAt).toBeTypeOf("number");
    expect(st.last).toMatchObject({ ok: false });
    sent.length = 0;
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(sent).toHaveLength(0);
  });

  it("retries after the cooldown elapses", async () => {
    await updateReconnectState(U, I, { last: { at: Date.now() - RECONNECT_COOLDOWN_MS - 1, ok: false } });
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
  });

  it("busy profile: no run, nothing recorded", async () => {
    activeProfiles.add(U);
    try {
      expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "BUSY" });
      expect((await getReconnectState(U, I)).last).toBeUndefined();
    } finally {
      activeProfiles.delete(U);
    }
  });

  it("host guard: aborts before fill when the page left the allowlist", async () => {
    pageState.redirect = "https://evil.example.org/login"; // login page bounces off-allowlist
    const out = await reconnectSession(U, I);
    expect(out).toMatchObject({ ok: false, reason: "HOST_NOT_ALLOWED" });
    expect(sent.find(([m]) => m === "Input.insertText")).toBeUndefined();
  });

  it("unbound credential fails with CREDENTIAL_UNBOUND and leaks nothing", async () => {
    await updateReconnectState(U, I, { bindings: { username: "acme_user" } });
    const out = await reconnectSession(U, I);
    expect(out).toMatchObject({ ok: false, reason: "CREDENTIAL_UNBOUND", step: 2 });
    const st = await getReconnectState(U, I);
    expect(JSON.stringify(st)).not.toContain("pw-abc");
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain("pw-abc");
  });

  it("optional click is skipped when absent", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: I, version: "1",
      auth: { ...auth, reconnect: { ...auth.reconnect, steps: [
        { goto: "loginUrl" },
        { click: "#account-picker", optional: true, timeoutMs: 200 },
        ...auth.reconnect.steps.slice(1),
      ] } },
    } as any);
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
  });

  it("returns NO_RECIPE for an integration without reconnect", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue({ name: I, version: "1", auth: { ...auth, reconnect: undefined } } as any);
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "NO_RECIPE" });
  });
});
```

If `activeProfiles` is a `Set`, the `.clear?.()` call is unnecessary. Remove it if the type is a `Map`, and adjust `add`/`delete` to `set`/`delete`. Read `profile-chromium.ts:12` first.

- [ ] **Step 2: Run, expect FAIL.** `cd packages/server && npx vitest run tests/reconnect-runner.test.ts`

- [ ] **Step 3: Implement** `packages/server/src/auth/reconnect/affinity.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../../config";

// A user's chromium is process-local (docs/findings/2026-09-10-browser-session-pod-affinity.md).
// A reconnect may only drive it from the process that owns it: the request
// reached us through the affinity hop (verified X-Browser-Session), or there
// is no cluster to be wrong about.
const owner = new AsyncLocalStorage<true>();

export function runWithBrowserAffinity<T>(fn: () => T): T {
  return owner.run(true, fn);
}

export function mayOwnBrowser(): boolean {
  return !config.INTERNAL_MCP_URL || owner.getStore() === true;
}
```

- [ ] **Step 4: Implement** `packages/server/src/auth/reconnect/runner.ts`:

```ts
import type { CookieConfig, ReconnectStep } from "@a-workbench/shared"; // match server import path
import { registry } from "../../plugins/registry";
import { auditLogger } from "../../audit/logger";
import { readSecretValue, touchUsed } from "../../vault/store";
import { activeProfiles } from "../profile-chromium";
import { openTab, closeTab, getWarmSession, captureLiveCookies, pressKey, type PageHandle } from "../browser-session";
import { storeCookies } from "../cookie";
import { getReconnectState, updateReconnectState, type ReconnectState } from "./state";
import { clickSelector, fillSelector, waitForSelector, waitForUrl, currentUrl, StepError, type ReconnectReason } from "./dom";
import { mayOwnBrowser } from "./affinity";

export const RECONNECT_COOLDOWN_MS = 600_000;
const DEFAULT_RUN_MS = 30_000;
const DEFAULT_STEP_MS = 10_000;
const CRED_RE = /\{\{cred:([a-z0-9_]+)\}\}/g;

export type ReconnectOutcome =
  | { ok: true }
  | { ok: false; reason: ReconnectReason | "COOLDOWN" | "BUSY" | "NOT_OWNER" | "NO_RECIPE"; step?: number };

type RecipeAuth = CookieConfig & Required<Pick<CookieConfig, "session" | "reconnect">>;

export const __deps = {
  async probe(url: string, cookieHeader: string): Promise<number> {
    const res = await fetch(url, { headers: { Cookie: cookieHeader }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return res.status;
  },
};

export function canAttemptReconnect(state: ReconnectState, now = Date.now()): boolean {
  return !(state.last && !state.last.ok && now - state.last.at < RECONNECT_COOLDOWN_MS);
}

const locks = new Map<string, Promise<ReconnectOutcome>>();

export async function reconnectSession(userId: string, integration: string): Promise<ReconnectOutcome> {
  const auth = registry.getIntegration(integration)?.auth;
  if (!auth || auth.type !== "cookie" || !auth.reconnect || !auth.session) return { ok: false, reason: "NO_RECIPE" };
  if (!mayOwnBrowser()) {
    await updateReconnectState(userId, integration, { deadAt: Date.now() });
    return { ok: false, reason: "NOT_OWNER" };
  }
  const key = `${userId}:${integration}`;
  let p = locks.get(key);
  if (!p) {
    p = attempt(userId, integration, auth as RecipeAuth);
    locks.set(key, p);
    // .finally() chains a second promise; swallow its rejection or a failed
    // run becomes an unhandled rejection.
    void p.finally(() => locks.delete(key)).catch(() => {});
  }
  return p;
}

function allowedHosts(auth: RecipeAuth): string[] {
  return [auth.targetDomain, ...(auth.cookieDomains ?? []), ...(auth.reconnect.allowHosts ?? [])]
    .map((d) => d.replace(/^\./, "").toLowerCase());
}

function hostOk(href: string, allowed: string[]): boolean {
  if (href === "about:blank" || href === "") return true;
  try {
    const h = new URL(href).hostname.toLowerCase();
    return allowed.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

function cookieHeaderFor(cookies: { name: string; value: string }[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function probeAlive(auth: RecipeAuth, cookies: { name: string; value: string }[]): Promise<boolean> {
  const probe = auth.session.probe!;
  const status = await __deps.probe(`https://${auth.targetDomain}${probe.path}`, cookieHeaderFor(cookies));
  return probe.alive.includes(status);
}

async function attempt(userId: string, integration: string, auth: RecipeAuth): Promise<ReconnectOutcome> {
  const state = await getReconnectState(userId, integration);
  if (!canAttemptReconnect(state)) return { ok: false, reason: "COOLDOWN" };
  if (activeProfiles.has(userId)) return { ok: false, reason: "BUSY" };

  const started = Date.now();
  const capture = () => captureLiveCookies(userId, auth.targetDomain, auth.cookieDomains);

  // Fast path: the profile may already hold a live app session.
  if (auth.session.probe && getWarmSession(userId)) {
    try {
      const data = await capture();
      if (data.cookies.length && (await probeAlive(auth, data.cookies))) {
        return commit(userId, integration, data, started);
      }
    } catch { /* fall through to the recipe */ }
  }

  let tabId: string | null = null;
  let stepIndex = -1;
  try {
    const opened = await openTab(userId);
    if (!opened.ok) throw new StepError("BROWSER_ERROR");
    tabId = opened.tab.id;
    const page: PageHandle = opened.tab;
    const deadline = started + (auth.reconnect.timeoutMs ?? DEFAULT_RUN_MS);
    const allowed = allowedHosts(auth);
    const bindings = state.bindings ?? {};
    const usedNames: string[] = [];

    const guardHost = async () => {
      if (!hostOk(await currentUrl(page), allowed)) throw new StepError("HOST_NOT_ALLOWED");
    };

    for (const [i, step] of auth.reconnect.steps.entries()) {
      stepIndex = i;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new StepError("TIMEOUT");
      await guardHost();
      await runStep(page, step, auth, Math.min(stepTimeout(step), remaining), {
        guardHost,
        resolveValue: async (v) => {
          let out = v;
          for (const [, k] of [...v.matchAll(CRED_RE)]) {
            const name = bindings[k];
            const secret = name ? await readSecretValue(userId, name) : null;
            if (secret === null) throw new StepError("CREDENTIAL_UNBOUND");
            usedNames.push(name!);
            out = out.split(`{{cred:${k}}}`).join(secret);
          }
          return out;
        },
      });
    }

    stepIndex = -1;
    const data = await capture();
    if (!data.cookies.length) throw new StepError("NO_COOKIES");
    if (auth.session.probe) {
      if (!(await probeAlive(auth, data.cookies))) throw new StepError("PROBE_FAILED");
    } else if ((await currentUrl(page)).startsWith(auth.loginUrl)) {
      throw new StepError("PROBE_FAILED");
    }
    if (usedNames.length) await touchUsed(userId, usedNames).catch(() => {});
    return await commit(userId, integration, data, started);
  } catch (e) {
    const reason: ReconnectReason = e instanceof StepError ? e.reason : "BROWSER_ERROR";
    const now = Date.now();
    const where = stepIndex >= 0 ? `step ${stepIndex}` : "verify";
    await updateReconnectState(userId, integration, { deadAt: now, last: { at: now, ok: false, error: `${where}: ${reason}` } });
    await auditLogger.log({
      user_id: userId, integration, action: "REFRESH", success: false, error: reason, duration_ms: now - started,
    });
    return { ok: false, reason, ...(stepIndex >= 0 ? { step: stepIndex } : {}) };
  } finally {
    if (tabId) await closeTab(userId, tabId).catch(() => false);
  }
}

function stepTimeout(step: ReconnectStep): number {
  return ("timeoutMs" in step && step.timeoutMs) || DEFAULT_STEP_MS;
}

async function commit(
  userId: string, integration: string, data: Awaited<ReturnType<typeof captureLiveCookies>>, started: number
): Promise<ReconnectOutcome> {
  await storeCookies(userId, integration, data);
  await updateReconnectState(userId, integration, { last: { at: Date.now(), ok: true } });
  await auditLogger.log({ user_id: userId, integration, action: "REFRESH", success: true, duration_ms: Date.now() - started });
  return { ok: true };
}

interface StepHooks {
  guardHost: () => Promise<void>;
  resolveValue: (v: string) => Promise<string>;
}

async function runStep(page: PageHandle, step: ReconnectStep, auth: RecipeAuth, timeoutMs: number, hooks: StepHooks): Promise<void> {
  if ("goto" in step) {
    const url = step.goto === "loginUrl" ? auth.loginUrl
      : /^https?:\/\//i.test(step.goto) ? step.goto
      : `https://${auth.targetDomain}${step.goto}`;
    await page.cdp.send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 500));
    return;
  }
  if ("click" in step) {
    try {
      await clickSelector(page, step.click, timeoutMs);
    } catch (e) {
      if (step.optional && e instanceof StepError && e.reason === "SELECTOR_NOT_FOUND") return;
      throw e;
    }
    return;
  }
  if ("fill" in step) {
    await waitForSelector(page, step.fill, timeoutMs);
    const value = await hooks.resolveValue(step.value);
    await hooks.guardHost(); // re-check: a redirect may have landed between wait and fill
    await fillSelector(page, step.fill, value, timeoutMs);
    return;
  }
  if ("press" in step) { await pressKey(page, step.press); return; }
  if ("waitFor" in step) { await waitForSelector(page, step.waitFor, timeoutMs); return; }
  if ("waitUrl" in step) { await waitForUrl(page, step.waitUrl, timeoutMs); return; }
}
```

In `packages/server/src/vault/store.ts`, change the header comment's caller list to read: "Its callers are the interpolator (mcp/meta-tools.ts via vault/interpolate.ts), the one-time-link redeemer (vault/routes.ts), and the cookie auto-reconnect runner (auth/reconnect/runner.ts), which hands the value only to `Input.insertText`."

- [ ] **Step 5: Run, expect PASS.** `cd packages/server && npx vitest run tests/reconnect-runner.test.ts`. If a test hits a real timing edge (the single-flight test), fix the implementation, not the assertion.

- [ ] **Step 6: Typecheck**

Run: `cd packages/server && npx tsc --noEmit -p . && npm run typecheck:tests`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/auth/reconnect packages/server/src/vault/store.ts packages/server/tests/reconnect-runner.test.ts
git commit -m "feat(cookie): single-flight reconnect runner with cooldown and host guard"
```

---

### Task 6: `ctx.http` detection + retry, and `execute_tools` pre-check

**Files:**
- Modify: `packages/server/src/plugins/context.ts` (cookie branch, ~lines 142-174)
- Modify: `packages/server/src/mcp/meta-tools.ts` (connected check, ~line 317)
- Modify: `packages/server/src/api/rest-routes.ts` (`isConnected`, ~line 66)
- Test: `packages/server/tests/reconnect-context.test.ts`

**Interfaces:**
- Consumes: `matchesDead` (Task 3), `reconnectSession`, `canAttemptReconnect` (Task 5), `getReconnectState`, `updateReconnectState` (Task 2)
- Produces: `export async function ensureCookieSession(userId: string, integration: string): Promise<boolean>` in `runner.ts`. It returns `hasValidCookies` after a reconnect attempt when the state is dead, a recipe exists and the cooldown has passed. It is used by `execute_tools` and the REST `isConnected`.

- [ ] **Step 1: Failing tests** at `packages/server/tests/reconnect-context.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reconnect = vi.fn();
vi.mock("../src/auth/reconnect/runner", async (orig) => ({
  ...(await orig<typeof import("../src/auth/reconnect/runner")>()),
  reconnectSession: (...a: unknown[]) => reconnect(...a),
}));

import { db } from "../src/db";
import { registry } from "../src/plugins/registry";
import { storeCookies } from "../src/auth/cookie";
import { getReconnectState } from "../src/auth/reconnect/state";
import { createContext } from "../src/plugins/context";

const U = "user-ctx-reconnect";
const I = "acme-cookie";
const baseAuth = {
  type: "cookie" as const, loginUrl: "https://app.example.com/login",
  targetDomain: "app.example.com", cookieDomains: ["app.example.com"],
};
const cookie = (v: string) => ({ domain: "app.example.com", cookies: [{ name: "sid", value: v, domain: "app.example.com", path: "/", expires: 9999999999 }], capturedAt: 1 });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  reconnect.mockReset();
  await db.run("DELETE FROM connections WHERE user_id = ?", [U]);
  await storeCookies(U, I, cookie("tok-old"));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const withAuth = (auth: object) => vi.spyOn(registry, "getIntegration").mockReturnValue({ name: I, version: "1", auth } as any);

describe("ctx.http cookie reconnect", () => {
  it("without a session block, a 401 passes through untouched", async () => {
    withAuth(baseAuth);
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    const ctx = await createContext(U, I);
    expect((await ctx.http("https://app.example.com/api/x")).status).toBe(401);
    expect(reconnect).not.toHaveBeenCalled();
    expect((await getReconnectState(U, I)).deadAt).toBeUndefined();
  });

  it("session without reconnect: marks dead and passes the response through", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } } });
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    const ctx = await createContext(U, I);
    expect((await ctx.http("https://app.example.com/api/x")).status).toBe(401);
    expect((await getReconnectState(U, I)).deadAt).toBeTypeOf("number");
  });

  it("dead -> reconnect -> one retry with the new cookies", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } });
    fetchMock
      .mockResolvedValueOnce(new Response("no", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    reconnect.mockImplementation(async () => { await storeCookies(U, I, cookie("tok-new")); return { ok: true }; });
    const ctx = await createContext(U, I);
    const res = await ctx.http("https://app.example.com/api/x", { method: "POST", body: "{\"a\":1}" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(retryHeaders.get("cookie")).toBe("sid=tok-new");
    expect(fetchMock.mock.calls[1][1].body).toBe("{\"a\":1}");
  });

  it("retry that is still dead is returned, no second reconnect", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } });
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    reconnect.mockResolvedValue({ ok: true });
    const ctx = await createContext(U, I);
    expect((await ctx.http("https://app.example.com/api/x")).status).toBe(401);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("reconnect failure returns the original response", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } });
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    reconnect.mockResolvedValue({ ok: false, reason: "PROBE_FAILED" });
    const ctx = await createContext(U, I);
    expect((await ctx.http("https://app.example.com/api/x")).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streamed body: reconnects but does not retry", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } });
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    reconnect.mockResolvedValue({ ok: true });
    const ctx = await createContext(U, I);
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } });
    expect((await ctx.http("https://app.example.com/api/x", { method: "POST", body, duplex: "half" } as RequestInit)).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `cd packages/server && npx vitest run tests/reconnect-context.test.ts`

- [ ] **Step 3: Implement** in `packages/server/src/plugins/context.ts`. Add these imports:

```ts
import { matchesDead } from "../auth/reconnect/dead";
import { reconnectSession } from "../auth/reconnect/runner";
import { updateReconnectState } from "../auth/reconnect/state";
```

Refactor the cookie branch so that building the `Cookie` header is a local function, and change its tail from `return fetch(url, { ...init, headers, redirect: "manual" });` to:

```ts
        const send = () => {
          headers.set("Cookie", buildCookieHeader(cookieData!, targetHost));
          return fetch(url, { ...init, headers, redirect: "manual" });
        };
        const res = await send();
        const session = integrationConfig.auth.session;
        if (!session || !matchesDead(res, session.dead, url)) return res;
        if (!integrationConfig.auth.reconnect) {
          await updateReconnectState(userId, integration, { deadAt: Date.now() });
          return res;
        }
        const outcome = await reconnectSession(userId, integration);
        if (!outcome.ok || !isReplayableBody(init?.body)) return res;
        const fresh = await getCookies(userId, integration);
        if (!fresh) return res;
        cookieData = fresh;
        return send();
```

At module scope:

```ts
function buildCookieHeader(data: CookieData, targetHost: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return data.cookies
    .filter((c) => !c.expires || c.expires >= nowSec)
    .filter((c) => {
      const cd = c.domain.replace(/^\./, "").toLowerCase();
      return targetHost === cd || targetHost.endsWith("." + cd);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

// A login bounce means the upstream never processed the request, so it is
// safe to re-send — but only a body we still hold. A stream is spent.
function isReplayableBody(body: RequestInit["body"]): boolean {
  return body == null || typeof body === "string" || body instanceof URLSearchParams ||
    body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}
```

- [ ] **Step 4: Run, expect PASS.** Also run `npx vitest run tests/context.test.ts` to confirm there are no regressions.

- [ ] **Step 5: Add `ensureCookieSession`** to `runner.ts`:

```ts
import { hasValidCookies } from "../cookie";

/**
 * Connected-check for cookie integrations that also revives a session found
 * dead earlier (e.g. overnight), so the first call of the day works instead of
 * answering NOT_CONNECTED.
 */
export async function ensureCookieSession(userId: string, integration: string): Promise<boolean> {
  if (await hasValidCookies(userId, integration)) return true;
  const state = await getReconnectState(userId, integration);
  if (!state.deadAt || !canAttemptReconnect(state)) return false;
  const outcome = await reconnectSession(userId, integration);
  return outcome.ok;
}
```

Test, appended to `reconnect-runner.test.ts`:

```ts
import { ensureCookieSession } from "../src/auth/reconnect/runner";
it("ensureCookieSession revives a dead session", async () => {
  await updateReconnectState(U, I, { deadAt: Date.now() });
  expect(await ensureCookieSession(U, I)).toBe(true);
  expect((await getReconnectState(U, I)).deadAt).toBeUndefined();
});
```

- [ ] **Step 6: Use it** in `meta-tools.ts` at about line 322 and in `rest-routes.ts` `isConnected`. Replace `hasValidCookies(userId, targetTool.integration)` with `ensureCookieSession(userId, targetTool.integration)` in the `execute_tools` path only. Leave the listing call sites (`list_integrations` ~line 831/900, `GET /api/connections`) on `hasValidCookies`: listing must not trigger logins. In `rest-routes.ts`, change only the POST execute path's connected check. If `isConnected` is shared with GET discovery, add `isConnectedForExecute` that uses `ensureCookieSession` and keep `isConnected` for discovery.

- [ ] **Step 7: Run the affected suites**

Run: `cd packages/server && npx vitest run tests/reconnect-context.test.ts tests/reconnect-runner.test.ts tests/meta-tools.test.ts tests/rest-routes.test.ts tests/context.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/plugins/context.ts packages/server/src/auth/reconnect/runner.ts packages/server/src/mcp/meta-tools.ts packages/server/src/api/rest-routes.ts packages/server/tests/reconnect-context.test.ts packages/server/tests/reconnect-runner.test.ts
git commit -m "feat(cookie): reconnect and retry on a dead-session response"
```

---

### Task 7: Cluster routing for recipe integrations

**Files:**
- Modify: `packages/server/src/auth/reconnect/affinity.ts` (add `needsBrowserAffinity`)
- Modify: `packages/server/src/index.ts` (~line 126-145, the `/mcp` forward + handle)
- Modify: `packages/server/src/api/rest-routes.ts` (~line 179, the browser-only forward)
- Test: `packages/server/tests/reconnect-affinity.test.ts`

**Interfaces:**
- Consumes: `touchesBrowser` from `auth/affinity-forward.ts`, `verifySessionKey`/`SESSION_HEADER` from `auth/cdp-bridge.ts`, `registry.getTool(name)` returning `{ integration }`.
- Produces: `export function needsBrowserAffinity(executions: unknown, directTool?: unknown): boolean` and `export function hasRecipe(integration: string): boolean`.

- [ ] **Step 1: Failing tests** at `packages/server/tests/reconnect-affinity.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { registry } from "../src/plugins/registry";
import { config } from "../src/config";
import { needsBrowserAffinity, runWithBrowserAffinity, mayOwnBrowser } from "../src/auth/reconnect/affinity";

afterEach(() => vi.restoreAllMocks());

function stubRegistry() {
  vi.spyOn(registry, "getTool").mockImplementation((n: string) =>
    n === "acme_list" ? ({ integration: "acme" } as any) : n === "other_list" ? ({ integration: "other" } as any) : undefined);
  vi.spyOn(registry, "getIntegration").mockImplementation((n: string) =>
    n === "acme"
      ? ({ name: "acme", auth: { type: "cookie", session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } } } as any)
      : ({ name: n, auth: { type: "cookie" } } as any));
}

describe("needsBrowserAffinity", () => {
  it("is true for browser_* tools", () => {
    expect(needsBrowserAffinity(undefined, "browser_click")).toBe(true);
  });
  it("is true when an execution targets a recipe integration", () => {
    stubRegistry();
    expect(needsBrowserAffinity([{ tool: "other_list" }, { tool: "acme_list" }])).toBe(true);
  });
  it("is false for integrations without a recipe", () => {
    stubRegistry();
    expect(needsBrowserAffinity([{ tool: "other_list" }])).toBe(false);
  });
});

describe("mayOwnBrowser", () => {
  it("is true in single-process mode", () => {
    vi.spyOn(config, "INTERNAL_MCP_URL", "get").mockReturnValue(undefined as any);
    expect(mayOwnBrowser()).toBe(true);
  });
  it("in a cluster, only inside runWithBrowserAffinity", () => {
    vi.spyOn(config, "INTERNAL_MCP_URL", "get").mockReturnValue("http://internal:3000/mcp" as any);
    expect(mayOwnBrowser()).toBe(false);
    expect(runWithBrowserAffinity(() => mayOwnBrowser())).toBe(true);
  });
});
```

If `config` is a plain object rather than getters, replace `vi.spyOn(config, ..., "get")` with direct assignment, restoring the old value in `afterEach`. Check `src/config.ts` first.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** in `affinity.ts`:

```ts
import { registry } from "../../plugins/registry";
import { touchesBrowser } from "../affinity-forward";

export function hasRecipe(integration: string): boolean {
  const auth = registry.getIntegration(integration)?.auth;
  return auth?.type === "cookie" && !!auth.reconnect;
}

/**
 * True when this call must run on the replica that owns the user's chromium:
 * a browser_* tool, or a tool of a cookie integration that can auto-reconnect
 * (its recipe drives that chromium).
 */
export function needsBrowserAffinity(executions: unknown, directTool?: unknown): boolean {
  if (touchesBrowser(executions, directTool)) return true;
  const names: unknown[] = [directTool];
  if (Array.isArray(executions)) {
    for (const e of executions) if (e && typeof e === "object") names.push((e as { tool?: unknown }).tool);
  }
  return names.some((n) => {
    if (typeof n !== "string") return false;
    const integ = registry.getTool(n)?.integration;
    return !!integ && hasRecipe(integ);
  });
}
```

- [ ] **Step 4: Wire `/mcp`** in `packages/server/src/index.ts`:
- Replace `touchesBrowser(params?.arguments?.executions, params?.name)` with `needsBrowserAffinity(params?.arguments?.executions, params?.name)`. Note that `params.name` is the meta-tool name (`execute_tools`), so the executions carry the real tool names. Keep both.
- Then wrap the local handling. `verifySessionKey(inbound, userId)` true means this replica is the owner:

```ts
    const inboundKey = request.headers[SESSION_HEADER];
    const isOwner = verifySessionKey(Array.isArray(inboundKey) ? inboundKey[0] : inboundKey, userId);
    const run = () => runWithVia(parseVia(via), () => handleMcpRequest(body, userId));
    const result = await (isOwner ? runWithBrowserAffinity(run) : run());
```

Import `SESSION_HEADER`, `verifySessionKey` from `./auth/cdp-bridge`, and `needsBrowserAffinity`, `runWithBrowserAffinity` from `./auth/reconnect/affinity`. Drop the now-unused `touchesBrowser` import.

- [ ] **Step 5: Wire REST** in `rest-routes.ts`. Change the forward condition from `integration === "browser"` to `(integration === "browser" || hasRecipe(integration))`. Change the target to `new URL(\`/rest/${integration}\`, config.INTERNAL_MCP_URL)`. Then wrap the rest of the handler body the same way (compute `isOwner` from the inbound header and run the execute path inside `runWithBrowserAffinity` when true). Keep the existing `rest-browser-proxy.test.ts` passing.

- [ ] **Step 6: Add a REST forwarding test** to `tests/rest-browser-proxy.test.ts`, mirroring its existing browser case. With `INTERNAL_MCP_URL` set and a registry stub giving `acme` a recipe, `POST /rest/acme` without the session header forwards to `/rest/acme` with `x-browser-session` set. Read that file and copy its harness exactly.

- [ ] **Step 7: Run**

Run: `cd packages/server && npx vitest run tests/reconnect-affinity.test.ts tests/rest-browser-proxy.test.ts tests/mcp-browser-proxy.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/auth/reconnect/affinity.ts packages/server/src/index.ts packages/server/src/api/rest-routes.ts packages/server/tests/reconnect-affinity.test.ts packages/server/tests/rest-browser-proxy.test.ts
git commit -m "feat(cookie): route recipe integrations to the chromium-owning replica"
```

---

### Task 8: API: bindings endpoint, status, recipe metadata

**Files:**
- Modify: `packages/server/src/api/routes.ts` (`GET /api/integrations` ~line 304, integration detail ~line 381, `GET /api/connections` ~line 839, new `PUT`)
- Test: `packages/server/tests/reconnect-routes.test.ts`

**Interfaces:**
- Produces (HTTP):
  - `GET /api/integrations/:name` gains `autoReconnect?: { credentials: {key,label,secret?}[] }` for cookie integrations with a recipe.
  - `GET /api/connections`: each cookie row with a recipe gains `autoReconnect: { bindings: Record<string,string>; missing: string[]; last?: {at:number; ok:boolean; error?:string}; dead: boolean }`.
  - `PUT /api/connections/:integration/reconnect` with body `{ bindings: Record<string,string> }`:
    - 200 → `{ success: true }`
    - 400 → undeclared key, or a vault name that does not exist for this user
    - 404 → no recipe
    - 409 → no connection row yet
    - portal session only: use the same `authenticate(request)` as the neighbouring `/api/connections` routes
  - An empty-string value removes that binding.

- [ ] **Step 1: Failing tests** at `packages/server/tests/reconnect-routes.test.ts`. Read `tests/routes.test.ts` first and reuse its app-building and auth helper (how it obtains a portal session token). Use the same helpers here. Cases:

```ts
// shape — adapt `buildApp` / `authHeader` to the helpers routes.test.ts uses
it("PUT bindings stores names and GET /api/connections reports them", async () => {
  await putSecret(USER, "acme_pw", "pw-abc");
  await storeCookies(USER, "acme", cookieData);
  const put = await app.inject({ method: "PUT", url: "/api/connections/acme/reconnect", headers: auth, payload: { bindings: { password: "acme_pw" } } });
  expect(put.statusCode).toBe(200);
  const list = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
  const row = list.json().connections.find((c: any) => c.name === "acme");
  expect(row.autoReconnect).toMatchObject({ bindings: { password: "acme_pw" }, missing: ["username"], dead: false });
  expect(list.body).not.toContain("pw-abc");
});
it("rejects an undeclared key", async () => { /* 400 */ });
it("rejects a vault name the user does not have", async () => { /* 400 */ });
it("404 for an integration without a recipe", async () => { /* 404 */ });
it("409 before the integration is connected", async () => { /* 409 */ });
it("empty string unbinds", async () => { /* bindings no longer has the key */ });
it("integration detail exposes credential slots", async () => {
  const r = await app.inject({ method: "GET", url: "/api/integrations/acme", headers: auth });
  expect(r.json().autoReconnect.credentials.map((c: any) => c.key)).toEqual(["username", "password"]);
});
```

Write each `/* … */` case out in full in the test file, following the first case's pattern. Register the `acme` integration through `vi.spyOn(registry, "getIntegration")` and `listIntegrations`, with the password-recipe `auth` from Task 5's test.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** in `routes.ts`:

```ts
import { getReconnectState, updateReconnectState } from "../auth/reconnect/state";
import { listSecrets } from "../vault/store";

function recipeOf(name: string) {
  const a = registry.getIntegration(name)?.auth;
  return a?.type === "cookie" && a.reconnect ? a.reconnect : null;
}

async function autoReconnectStatus(userId: string, name: string) {
  const r = recipeOf(name);
  if (!r) return undefined;
  const st = await getReconnectState(userId, name);
  const bindings = st.bindings ?? {};
  return {
    bindings,
    missing: (r.credentials ?? []).map((c) => c.key).filter((k) => !bindings[k]),
    last: st.last,
    dead: !!st.deadAt,
  };
}
```

- In `GET /api/connections`, add `autoReconnect: i.auth.type === "cookie" ? await autoReconnectStatus(user.userId, i.name) : undefined` to each native row.
- In the integration detail handler, add `autoReconnect: recipeOf(integ.name) ? { credentials: recipeOf(integ.name)!.credentials ?? [] } : undefined`.
- The new route:

```ts
  app.put<{ Params: { integration: string }; Body: { bindings?: unknown } }>(
    "/api/connections/:integration/reconnect",
    async (request, reply) => {
      const user = await authenticate(request);
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { integration } = request.params;
      const r = recipeOf(integration);
      if (!r) return reply.status(404).send({ error: "Integration has no auto-reconnect recipe" });
      const raw = request.body?.bindings;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return reply.status(400).send({ error: "bindings must be an object" });
      }
      const declared = new Set((r.credentials ?? []).map((c) => c.key));
      const owned = new Set((await listSecrets(user.userId)).map((s) => s.name));
      const current = (await getReconnectState(user.userId, integration)).bindings ?? {};
      const next: Record<string, string> = { ...current };
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!declared.has(k)) return reply.status(400).send({ error: `Unknown credential: ${k}` });
        if (v === "") { delete next[k]; continue; }
        if (typeof v !== "string" || !owned.has(v)) return reply.status(400).send({ error: `No vault entry named ${String(v)}` });
        next[k] = v;
      }
      if (!(await getCookies(user.userId, integration))) {
        return reply.status(409).send({ error: "Connect the integration first" });
      }
      await updateReconnectState(user.userId, integration, { bindings: next });
      return { success: true };
    }
  );
```

Make sure `getCookies` is imported in `routes.ts`; it already imports from `../auth/cookie`.

- [ ] **Step 4: Run, expect PASS.** Also run `tests/routes.test.ts` to check for regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/routes.ts packages/server/tests/reconnect-routes.test.ts
git commit -m "feat(api): auto-reconnect credential bindings and status"
```

---

### Task 9: Portal: Auto-reconnect panel on AppDetail

**Files:**
- Modify: `packages/portal/src/api.ts` (types plus `saveReconnectBindings`; `fetchVault` already exists for `Vault.tsx`, so reuse its function)
- Create: `packages/portal/src/components/AutoReconnectPanel.tsx`
- Modify: `packages/portal/src/pages/AppDetail.tsx` (render the panel for cookie apps, next to `<SessionTransfer>` at ~line 168)
- Test: `packages/portal/src/components/AutoReconnectPanel.test.tsx`

**Interfaces:**
- Consumes: Task 8 HTTP shapes
- Produces: `saveReconnectBindings(integration: string, bindings: Record<string,string>): Promise<{success: boolean}>`, and `IntegrationDetail.autoReconnect?: { credentials: {key:string;label:string;secret?:boolean}[] }`

Behaviour:
- **Render guard.** Render only when `detail.autoReconnect` exists.
- **Status line** from the connection row's `autoReconnect`:
  - `last.ok` → "Auto-reconnected <relative time>"
  - `last.ok === false` → "Auto-reconnect failed (<error>) — reconnect manually"
  - `dead` with no `last` → "Session expired"
  - otherwise → "Auto-reconnect ready", or "Bind credentials to enable" when `missing.length`.
- **Credentials.** If there are none (SSO recipe), show only the status line plus "Signs in again with your existing SSO session".
- **Pickers.** Otherwise, one `<select>` per slot listing vault entry names, with an empty option ("— none —"). Also show a "Add a vault entry" link to `/vault`.
- **Saving.** Save calls `saveReconnectBindings`, then invalidates `["connections"]`.
- **Not connected.** If the user is not connected, the pickers are disabled with the hint "Connect first".

Find the relative-time helper in `format.ts` and reuse it.

- [ ] **Step 1: Failing test.** Read `pages/AppDetail.test.tsx` and `test-utils.tsx` for the render/mock-fetch helpers, then write:

```tsx
it("shows a picker per credential slot and saves bindings", async () => {
  mockFetch({
    "/api/vault": { entries: [{ name: "acme_pw" }, { name: "acme_user" }] },
    "PUT /api/connections/acme/reconnect": { success: true },
  });
  renderWithProviders(
    <AutoReconnectPanel
      integration="acme"
      credentials={[{ key: "username", label: "Username" }, { key: "password", label: "Password", secret: true }]}
      status={{ bindings: {}, missing: ["username", "password"], dead: false }}
      connected
    />
  );
  await userEvent.selectOptions(await screen.findByLabelText("Password"), "acme_pw");
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
  expect(lastRequest("PUT /api/connections/acme/reconnect").body).toEqual({ bindings: { password: "acme_pw" } });
});
it("SSO recipe shows no pickers", () => { /* credentials=[] → no combobox, text mentions SSO */ });
it("renders the failure status", () => { /* status.last={ok:false,error:"step 2: PROBE_FAILED"} → text contains it */ });
```

Adapt `mockFetch`/`lastRequest`/`renderWithProviders` to what `test-utils.tsx` actually provides, and write the two remaining cases in full. Check the real `/api/vault` response key in `api.ts` and use it.

- [ ] **Step 2: Run, expect FAIL.** `cd packages/portal && npx vitest run src/components/AutoReconnectPanel.test.tsx`

- [ ] **Step 3: Implement** the component with existing UI primitives (`Box`, `BoxRow`, `Button`, `Badge` from `components/ui`). Only the changed-from-initial bindings are sent: start state = `status.bindings`, send the full map of slots whose value differs, empty string for a cleared one. Add to `api.ts`:

```ts
export async function saveReconnectBindings(integration: string, bindings: Record<string, string>): Promise<{ success: boolean }> {
  const res = await fetch(`/api/connections/${encodeURIComponent(integration)}/reconnect`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ bindings }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Save failed (${res.status})`);
  return res.json();
}
```

Wire it in `AppDetail.tsx`. Find this integration's connection row (`connectionsData.connections.find(c => c.name === name)`) and render `<AutoReconnectPanel integration={data.name} credentials={data.autoReconnect.credentials} status={row?.autoReconnect} connected={connected} />` when `data.authType === "cookie" && data.autoReconnect`.

- [ ] **Step 4: Run, expect PASS.** Also run `npx vitest run src/pages/AppDetail.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add packages/portal/src
git commit -m "feat(portal): auto-reconnect credential bindings and status on app detail"
```

---

### Task 10: Chromium end-to-end test

**Files:**
- Create: `packages/server/tests/reconnect.chromium.test.ts`

Follow `tests/cdp-bridge.chromium.test.ts` for the skip guard: these tests run only where chromium is available, and they skip otherwise. Copy that guard exactly.

Fixture: a Fastify app on `127.0.0.1:<random>` that serves:
- `GET /login`: a form `#user`/`#pass` posting to `/session`, plus a `button` "Sign in with SSO" linking to `/sso`
- `POST /session`: when `pw-abc`, it sets cookie `sid=ok` and 302s to `/home`; otherwise it re-renders `/login`
- `GET /sso`: sets `sid=ok` and 302s to `/home`
- `GET /api/me`: 200 when the cookie is `sid=ok`, else 401
- `GET /mfa`: a page with an input that never completes

Recipes use `targetDomain: "127.0.0.1"` and `loginUrl: http://127.0.0.1:<port>/login`. The runner builds `https://${targetDomain}` for the probe and for path gotos, so for this test either:
- (a) set `__deps.probe` to hit the fixture over http, and use absolute `http://` URLs in `goto`; or
- (b) add an optional `origin` override.

Prefer (a). Do not change production URL building for a test.

Cases:
- password recipe → `{ok:true}`, stored cookie `sid=ok`
- SSO recipe (`click: "text=Sign in with SSO"`) → `{ok:true}`
- wrong password bound → `{ok:false, reason:"PROBE_FAILED" | "NO_COOKIES"}` and `deadAt` set
- MFA recipe whose `waitUrl: "/home"` never happens → `{ok:false, reason:"TIMEOUT"}` within `timeoutMs + 2s`

- [ ] **Step 1: Write the test** (complete code, modelled on the guard and harness in `cdp-bridge.chromium.test.ts`).
- [ ] **Step 2: Run** `cd packages/server && npx vitest run tests/reconnect.chromium.test.ts`. It passes locally if chromium is present. Report "skipped" honestly if it is not.
- [ ] **Step 3: Commit**

```bash
git add packages/server/tests/reconnect.chromium.test.ts
git commit -m "test(cookie): chromium end-to-end for reconnect recipes"
```

---

### Task 11: Docs, finding, full verification

**Files:**
- Modify: the docs page covering cookie auth / plugin manifests under `docs/site/_content/` (find it with `grep -rl "cookieDomains" docs/site/_content`)
- Create: `docs/findings/2026-10-10-cookie-auto-reconnect.md`
- Modify: `CLAUDE.md` (Findings Index: one line)
- Modify: `docs/superpowers/specs/2026-10-10-cookie-auto-reconnect-design.md` §6. The binding UI lives on AppDetail only, not in the connect modal, because bindings require an existing connection.

- [ ] **Step 1: Plugin-author docs.** Add an "Auto-reconnect" section covering:
  - the `session` and `reconnect` blocks, with the SSO and password examples from the spec, using generic hosts
  - step semantics and selector syntax (`text=`)
  - the host allowlist
  - cooldown
  - how users bind vault entries
  - that a plugin can delete its hand-rolled "session expired" throw once `session.dead` is declared

- [ ] **Step 2: Finding doc.** Record the non-obvious things learned while implementing it:
  - manifests are not schema-validated at load, hence the loader guard
  - reconnect state rides in `connections.config` with no DDL, and `storeCookies` clears `deadAt`
  - cluster routing moves the call, not the reconnect
  - the credential only ever reaches `Input.insertText`
  - plus anything surprising found during Tasks 1–10, including the chromium test result

- [ ] **Step 3: Build the docs site.** `node docs/site/build.mjs`. Expected: no broken-link errors.

- [ ] **Step 4: Full verification**

Run: `npm run build && npm run test && (cd packages/server && npm run typecheck:tests)`
Expected: all green. Report counts.

- [ ] **Step 5: Hygiene scrub**

Run the pre-commit scrub from CLAUDE.md (Public Repo Hygiene) over `git diff main`, using the deployment's own company, internal-project and real-name patterns.
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs: cookie auto-reconnect — plugin guide and finding"
```
