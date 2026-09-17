# User Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-user encrypted secrets store the agent can reference (`{{vault:name}}`) and hand off via one-time URL, but never read.

**Architecture:** New `user_vaults` table encrypted with the existing AES-256-GCM helper. A pure interpolate/scrub module hooked at the top of `executeSingle` so every tool path (MCP, batch, REST) is covered by one call. One-time URLs ride `pending_auth` under a `__vault_otl__` sentinel with DELETE-arbitrated single use, mirroring `workspace/presign.ts`. Internal plugin `vault` exposes `vault_list`/`vault_presign`; portal page `/vault` is write-only.

**Tech Stack:** TypeScript, Fastify, zod, better-sqlite3 / pg via `DbAdapter`, vitest, React + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-09-16-user-vault-design.md`

## Global Constraints

- Repo is public: no PII, no real names/emails, no secrets in fixtures. Fixtures use `u1`, `hunter2`, `tok-abc`.
- No `Co-Authored-By:` / "Generated with" trailers on commits.
- Every SQL statement written once in `?` style; runs on SQLite and PostgreSQL. `BLOB` in SQLite DDL, `BYTEA` in Postgres DDL. Pass real booleans.
- Name grammar: `^[a-z0-9][a-z0-9_.-]{0,63}$`.
- Value cap: 8192 bytes UTF-8, empty rejected.
- OTL: default TTL 120 s, max 600 s, token 32 hex, sentinel `__vault_otl__`.
- Reference syntax: `{{vault:NAME}}`.
- `vault_*` tools exempt from interpolation.
- `packages/server/src/reap/cli.ts` must stay free of `../config` and `../db` imports — so the OTL sweep is an **in-process interval** (`startVaultReaper`, like `jots/pending.ts`), NOT a reap subcommand. This amends the spec's "Reaper" section.
- Run server tests with `npx vitest run <file> -w @a-workbench/server` from repo root (or `cd packages/server && npx vitest run <file>`). Portal: `cd packages/portal && npx vitest run <file>`.
- Commit after every task. Scrub check before each commit: `git diff --cached | grep -inIE '@(icloud|gmail)\.com'` must print nothing.

---

## File map

| File | Responsibility |
|---|---|
| `packages/server/src/db.ts` | `user_vaults` DDL, both dialects |
| `packages/server/src/migrate/plan.ts` | add `user_vaults` to `TABLES` |
| `packages/server/src/vault/store.ts` | CRUD; only place that decrypts |
| `packages/server/src/vault/otl.ts` | one-time-link mint/consume/revoke/reap + `startVaultReaper` |
| `packages/server/src/vault/interpolate.ts` | pure `findVaultRefs`, `substituteVaultRefs`, `scrubVaultValues` + `resolveVaultRefs` (store-backed) |
| `packages/server/src/mcp/meta-tools.ts` | hook in `executeSingle` |
| `packages/server/src/plugins/internal/vault.ts` | `vault_list`, `vault_presign` |
| `packages/server/src/plugins/loader.ts` | register plugin |
| `packages/server/src/vault/routes.ts` | `/api/vault*` |
| `packages/server/src/index.ts` | register routes, start reaper |
| `packages/portal/src/api.ts`, `pages/Vault.tsx`, `App.tsx`, `components/shell/Sidebar.tsx` | portal |
| `docs/site/_content/integrations/vault.md`, `docs/site/nav.json`, `docs/releases/v0.29.0.md` | docs |

---

### Task 1: Schema

**Files:**
- Modify: `packages/server/src/db.ts` (append to `SQLITE_SCHEMA` before closing backtick ~line 90; append to `POSTGRES_SCHEMA` ~line 163)
- Modify: `packages/server/src/migrate/plan.ts:18-26`
- Test: `packages/server/tests/migrate-plan.test.ts:176-190`, new `packages/server/tests/vault-schema.test.ts`

**Interfaces:**
- Produces: table `user_vaults(id, user_id, name, value_enc, description, created_at, updated_at, last_used_at)` with `UNIQUE(user_id, name)`.

- [ ] **Step 1: Write failing tests**

Edit `packages/server/tests/migrate-plan.test.ts` TABLES expectation to include `"user_vaults"`:

```ts
      [
        "audit_log",
        "connections",
        "oauth_auth_codes",
        "oauth_clients",
        "oauth_refresh_tokens",
        "pending_auth",
        "user_vaults",
        "users",
      ].sort()
```

Create `packages/server/tests/vault-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { db } from "../src/db";

describe("user_vaults schema", () => {
  it("exists with a unique (user_id, name)", async () => {
    await db.run("DELETE FROM user_vaults");
    await db.run(
      "INSERT INTO user_vaults (id, user_id, name, value_enc) VALUES (?, ?, ?, ?)",
      ["a", "u1", "pw", Buffer.from("x")]
    );
    await expect(
      db.run("INSERT INTO user_vaults (id, user_id, name, value_enc) VALUES (?, ?, ?, ?)", [
        "b",
        "u1",
        "pw",
        Buffer.from("y"),
      ])
    ).rejects.toThrow();
    const row = await db.get<{ created_at: number; last_used_at: number | null }>(
      "SELECT created_at, last_used_at FROM user_vaults WHERE id = ?",
      ["a"]
    );
    expect(typeof row?.created_at).toBe("number");
    expect(row?.last_used_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect fail** — `cd packages/server && npx vitest run tests/vault-schema.test.ts tests/migrate-plan.test.ts` → `no such table: user_vaults` and TABLES mismatch.

- [ ] **Step 3: Implement**

In `SQLITE_SCHEMA` (after `oauth_refresh_tokens` block, before the closing backtick):

```sql
  CREATE TABLE IF NOT EXISTS user_vaults (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value_enc BLOB NOT NULL,
    description TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    last_used_at INTEGER,
    UNIQUE(user_id, name)
  );
```

In `POSTGRES_SCHEMA` (same position):

```sql
  CREATE TABLE IF NOT EXISTS user_vaults (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value_enc BYTEA NOT NULL,
    description TEXT,
    created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
    updated_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
    last_used_at INTEGER,
    UNIQUE(user_id, name)
  );
```

In `migrate/plan.ts` `TABLES` add `"user_vaults",` after `"pending_auth",`.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(vault): user_vaults table on both dialects"`

---

### Task 2: Store

**Files:**
- Create: `packages/server/src/vault/store.ts`
- Test: `packages/server/tests/vault-store.test.ts`

**Interfaces (produces):**

```ts
export class VaultError extends Error { code: "INVALID_NAME" | "NOT_FOUND" | "TOO_LARGE" | "EMPTY_VALUE" }
export const VAULT_NAME_RE: RegExp;                    // ^[a-z0-9][a-z0-9_.-]{0,63}$
export const VAULT_MAX_VALUE_BYTES = 8192;
export interface VaultEntry { name: string; description: string | null; created_at: number; updated_at: number; last_used_at: number | null }
export function isValidVaultName(name: unknown): name is string;
export async function putSecret(userId, name, value, description?): Promise<{ created: boolean }>;
export async function deleteSecret(userId, name): Promise<boolean>;
export async function listSecrets(userId): Promise<VaultEntry[]>;
export async function readSecretValue(userId, name): Promise<string | null>;  // ONLY decrypt path
export async function touchUsed(userId, names: string[]): Promise<void>;
```

- [ ] **Step 1: Write failing tests** `packages/server/tests/vault-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import {
  putSecret,
  deleteSecret,
  listSecrets,
  readSecretValue,
  touchUsed,
  isValidVaultName,
  VaultError,
  VAULT_MAX_VALUE_BYTES,
} from "../src/vault/store";

beforeEach(async () => {
  await db.run("DELETE FROM user_vaults");
});

describe("vault store", () => {
  it("round-trips a value through encryption", async () => {
    await putSecret("u1", "site_pw", "hunter2", "login for example.com");
    const row = await db.get<{ value_enc: Buffer }>(
      "SELECT value_enc FROM user_vaults WHERE user_id = ? AND name = ?",
      ["u1", "site_pw"]
    );
    expect(Buffer.from(row!.value_enc).toString("utf8")).not.toContain("hunter2");
    expect(await readSecretValue("u1", "site_pw")).toBe("hunter2");
  });

  it("scopes reads to the owner", async () => {
    await putSecret("u1", "site_pw", "hunter2");
    expect(await readSecretValue("u2", "site_pw")).toBeNull();
    expect(await listSecrets("u2")).toEqual([]);
  });

  it("list never includes the value", async () => {
    await putSecret("u1", "site_pw", "hunter2", "d");
    const [e] = await listSecrets("u1");
    expect(Object.keys(e).sort()).toEqual(
      ["created_at", "description", "last_used_at", "name", "updated_at"].sort()
    );
    expect(JSON.stringify(e)).not.toContain("hunter2");
  });

  it("overwrite reports created=false, keeps created_at, bumps updated_at", async () => {
    const first = await putSecret("u1", "k", "a");
    expect(first.created).toBe(true);
    await db.run("UPDATE user_vaults SET created_at = 100, updated_at = 100 WHERE name = ?", ["k"]);
    const second = await putSecret("u1", "k", "b", "new desc");
    expect(second.created).toBe(false);
    const [e] = await listSecrets("u1");
    expect(e.created_at).toBe(100);
    expect(e.updated_at).toBeGreaterThan(100);
    expect(e.description).toBe("new desc");
    expect(await readSecretValue("u1", "k")).toBe("b");
  });

  it("validates names", async () => {
    expect(isValidVaultName("a")).toBe(true);
    expect(isValidVaultName("site_pw.v2-x")).toBe(true);
    expect(isValidVaultName("Site")).toBe(false);
    expect(isValidVaultName("_x")).toBe(false);
    expect(isValidVaultName("a b")).toBe(false);
    expect(isValidVaultName("a".repeat(65))).toBe(false);
    expect(isValidVaultName("")).toBe(false);
    expect(isValidVaultName(42)).toBe(false);
    await expect(putSecret("u1", "Bad", "x")).rejects.toMatchObject({ code: "INVALID_NAME" });
    expect(await readSecretValue("u1", "Bad")).toBeNull();
  });

  it("rejects empty and oversize values", async () => {
    await expect(putSecret("u1", "k", "")).rejects.toMatchObject({ code: "EMPTY_VALUE" });
    await expect(putSecret("u1", "k", "x".repeat(VAULT_MAX_VALUE_BYTES + 1))).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
    // multibyte counts bytes, not chars
    await expect(putSecret("u1", "k", "é".repeat(VAULT_MAX_VALUE_BYTES))).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
    expect(await putSecret("u1", "k", "x".repeat(VAULT_MAX_VALUE_BYTES))).toEqual({ created: true });
  });

  it("delete returns whether a row went", async () => {
    await putSecret("u1", "k", "a");
    expect(await deleteSecret("u1", "k")).toBe(true);
    expect(await deleteSecret("u1", "k")).toBe(false);
    expect(await readSecretValue("u1", "k")).toBeNull();
  });

  it("touchUsed stamps last_used_at only for the given names", async () => {
    await putSecret("u1", "a", "1");
    await putSecret("u1", "b", "2");
    await touchUsed("u1", ["a", "nope"]);
    const rows = await listSecrets("u1");
    expect(rows.find((r) => r.name === "a")!.last_used_at).not.toBeNull();
    expect(rows.find((r) => r.name === "b")!.last_used_at).toBeNull();
    await touchUsed("u1", []); // no-op, no throw
  });

  it("VaultError carries its code as message", () => {
    const e = new VaultError("TOO_LARGE");
    expect(e.message).toBe("TOO_LARGE");
  });
});
```

- [ ] **Step 2: Run, expect fail** (module not found).

- [ ] **Step 3: Implement** `packages/server/src/vault/store.ts`:

```ts
import crypto from "node:crypto";
import { db } from "../db";
import { encrypt, decrypt } from "../auth/encryption";

// Per-user secrets the agent can USE but never READ.
//
// `readSecretValue` is the only function in the server that decrypts a vault
// row. Its two callers are the interpolator (mcp/meta-tools.ts via
// vault/interpolate.ts) and the one-time-link redeemer (vault/routes.ts). No
// list, no portal route, no tool returns the plaintext.
//
// Same envelope as OAuth tokens: AES-256-GCM under ENCRYPTION_KEY
// (auth/encryption.ts). No key versioning — nothing else has it either.

export type VaultErrorCode = "INVALID_NAME" | "NOT_FOUND" | "TOO_LARGE" | "EMPTY_VALUE";

export class VaultError extends Error {
  constructor(public readonly code: VaultErrorCode) {
    super(code);
    this.name = "VaultError";
  }
}

// Lowercase, no whitespace: a reference `{{vault:NAME}}` never needs quoting.
export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const VAULT_MAX_VALUE_BYTES = 8192;

export interface VaultEntry {
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export function isValidVaultName(name: unknown): name is string {
  return typeof name === "string" && VAULT_NAME_RE.test(name);
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export async function putSecret(
  userId: string,
  name: string,
  value: string,
  description?: string | null
): Promise<{ created: boolean }> {
  if (!isValidVaultName(name)) throw new VaultError("INVALID_NAME");
  if (value === "") throw new VaultError("EMPTY_VALUE");
  if (Buffer.byteLength(value, "utf8") > VAULT_MAX_VALUE_BYTES) throw new VaultError("TOO_LARGE");
  const enc = encrypt(value);
  const desc = description ?? null;
  const { changes } = await db.run(
    "UPDATE user_vaults SET value_enc = ?, description = ?, updated_at = ? WHERE user_id = ? AND name = ?",
    [enc, desc, nowSec(), userId, name]
  );
  if (changes === 1) return { created: false };
  await db.run(
    "INSERT INTO user_vaults (id, user_id, name, value_enc, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), userId, name, enc, desc, nowSec(), nowSec()]
  );
  return { created: true };
}

export async function deleteSecret(userId: string, name: string): Promise<boolean> {
  if (!isValidVaultName(name)) return false;
  const { changes } = await db.run("DELETE FROM user_vaults WHERE user_id = ? AND name = ?", [
    userId,
    name,
  ]);
  return changes === 1;
}

export async function listSecrets(userId: string): Promise<VaultEntry[]> {
  return db.all<VaultEntry>(
    "SELECT name, description, created_at, updated_at, last_used_at FROM user_vaults WHERE user_id = ? ORDER BY name",
    [userId]
  );
}

/** The one decrypt path. Returns null for a bad name or a missing row. */
export async function readSecretValue(userId: string, name: string): Promise<string | null> {
  if (!isValidVaultName(name)) return null;
  const row = await db.get<{ value_enc: Buffer | Uint8Array }>(
    "SELECT value_enc FROM user_vaults WHERE user_id = ? AND name = ?",
    [userId, name]
  );
  if (!row) return null;
  return decrypt(Buffer.from(row.value_enc));
}

/** Stamp last_used_at. Unknown names are ignored. */
export async function touchUsed(userId: string, names: string[]): Promise<void> {
  const ts = nowSec();
  for (const name of new Set(names)) {
    if (!isValidVaultName(name)) continue;
    await db.run("UPDATE user_vaults SET last_used_at = ? WHERE user_id = ? AND name = ?", [
      ts,
      userId,
      name,
    ]);
  }
}
```

Check `db.all` / `db.get` / `db.run` signatures in `packages/server/src/db-adapter.ts` (`run` returns `{ changes }`); adjust generics if they differ.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(vault): encrypted per-user secret store"`

---

### Task 3: One-time links + reaper

**Files:**
- Create: `packages/server/src/vault/otl.ts`
- Test: `packages/server/tests/vault-otl.test.ts`

**Interfaces:**
- Consumes: `readSecretValue`, `touchUsed` from Task 2.
- Produces:

```ts
export const OTL_SENTINEL = "__vault_otl__";
export const OTL_DEFAULT_TTL_SECONDS = 120;
export const OTL_MAX_TTL_SECONDS = 600;
export interface MintedOtl { token: string; url: string; expiresAt: number /* ms */ }
export function _setNowForTest(fn: () => number): void;
export function otlUrl(token: string): string;                       // `${SERVER_PUBLIC_URL}/api/vault/otl/${token}`
export async function mintOtl(userId, name, ttlSeconds?): Promise<MintedOtl>;   // throws VaultError NOT_FOUND if secret absent
export async function consumeOtl(token): Promise<{ userId: string; name: string } | null>;  // single use
export async function revokeFor(userId, name): Promise<void>;
export async function reapExpiredOtl(): Promise<void>;
export function startVaultReaper(intervalMs?: number): void;
export function stopVaultReaper(): void;
```

- [ ] **Step 1: Write failing tests** `packages/server/tests/vault-otl.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../src/db";
import { putSecret } from "../src/vault/store";
import {
  mintOtl,
  consumeOtl,
  revokeFor,
  reapExpiredOtl,
  otlUrl,
  _setNowForTest,
  OTL_SENTINEL,
  OTL_DEFAULT_TTL_SECONDS,
  OTL_MAX_TTL_SECONDS,
} from "../src/vault/otl";

beforeEach(async () => {
  _setNowForTest(() => Date.now());
  await db.run("DELETE FROM pending_auth");
  await db.run("DELETE FROM user_vaults");
  await putSecret("u1", "pw", "hunter2");
});
afterEach(() => _setNowForTest(() => Date.now()));

describe("vault one-time links", () => {
  it("mints a 32-hex token under the vault sentinel and never stores the value", async () => {
    const m = await mintOtl("u1", "pw");
    expect(m.token).toMatch(/^[0-9a-f]{32}$/);
    expect(m.url).toBe(otlUrl(m.token));
    expect(m.url).toContain("/api/vault/otl/");
    expect(m.expiresAt).toBeGreaterThan(Date.now() + (OTL_DEFAULT_TTL_SECONDS - 5) * 1000);
    const row = await db.get<{ integration: string; session_data: string; user_id: string }>(
      "SELECT integration, session_data, user_id FROM pending_auth WHERE state = ?",
      [m.token]
    );
    expect(row?.integration).toBe(OTL_SENTINEL);
    expect(row?.user_id).toBe("u1");
    expect(row?.session_data).not.toContain("hunter2");
  });

  it("refuses to mint for a secret that does not exist", async () => {
    await expect(mintOtl("u1", "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mintOtl("u2", "pw")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("clamps ttl to the max", async () => {
    const m = await mintOtl("u1", "pw", OTL_MAX_TTL_SECONDS * 10);
    expect(m.expiresAt).toBeLessThanOrEqual(Date.now() + OTL_MAX_TTL_SECONDS * 1000 + 1000);
  });

  it("is consumed exactly once", async () => {
    const m = await mintOtl("u1", "pw");
    expect(await consumeOtl(m.token)).toEqual({ userId: "u1", name: "pw" });
    expect(await consumeOtl(m.token)).toBeNull();
  });

  it("gives exactly one winner to concurrent redeems", async () => {
    const m = await mintOtl("u1", "pw");
    const results = await Promise.all([consumeOtl(m.token), consumeOtl(m.token), consumeOtl(m.token)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("expires", async () => {
    const t0 = Date.now();
    _setNowForTest(() => t0);
    const m = await mintOtl("u1", "pw", 60);
    _setNowForTest(() => t0 + 61_000);
    expect(await consumeOtl(m.token)).toBeNull();
  });

  it("rejects junk tokens", async () => {
    expect(await consumeOtl("")).toBeNull();
    expect(await consumeOtl("zz")).toBeNull();
  });

  it("revokeFor drops every link for one secret and nothing else", async () => {
    await putSecret("u1", "other", "x");
    const a = await mintOtl("u1", "pw");
    const b = await mintOtl("u1", "pw");
    const c = await mintOtl("u1", "other");
    await revokeFor("u1", "pw");
    expect(await consumeOtl(a.token)).toBeNull();
    expect(await consumeOtl(b.token)).toBeNull();
    expect(await consumeOtl(c.token)).not.toBeNull();
  });

  it("reap is scoped to the vault sentinel", async () => {
    const t0 = Date.now();
    _setNowForTest(() => t0);
    const m = await mintOtl("u1", "pw", 60);
    await db.run(
      "INSERT INTO pending_auth (state, user_id, integration, expires_at) VALUES (?, ?, ?, ?)",
      ["foreign", "u1", "__file_ul__", Math.floor(t0 / 1000) - 10]
    );
    _setNowForTest(() => t0 + 120_000);
    await reapExpiredOtl();
    expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", [m.token])).toBeUndefined();
    expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", ["foreign"])).toBeTruthy();
  });
});
```

If `db.get` returns `null` rather than `undefined` for no row, use `toBeFalsy()`.

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** `packages/server/src/vault/otl.ts`:

```ts
import crypto from "node:crypto";
import { db } from "../db";
import { config } from "../config";
import { isValidVaultName, VaultError } from "./store";

// One-time links for vault values, on `pending_auth` under a sentinel —
// the same pattern as workspace/presign.ts and jots/pending.ts
// (docs/findings/2026-09-13-stateless-jot-upload-token.md).
//
// The row holds the secret's NAME, never its value. The value is decrypted at
// redeem time by the route, from the row's own user_id — nothing off the
// request decides whose secret is read.
//
// Single use is arbitrated by the DELETE (`changes === 1`), not the SELECT:
// concurrent redeems all read the row, the database serialises the deletes,
// exactly one wins. Atomic on both backends, no transaction.

export const OTL_SENTINEL = "__vault_otl__";
export const OTL_DEFAULT_TTL_SECONDS = 120;
export const OTL_MAX_TTL_SECONDS = 600;

export interface MintedOtl {
  token: string;
  url: string;
  expiresAt: number;
}

let now: () => number = () => Date.now();
export function _setNowForTest(fn: () => number): void {
  now = fn;
}

export function otlUrl(token: string): string {
  return `${config.SERVER_PUBLIC_URL}/api/vault/otl/${token}`;
}

export async function mintOtl(
  userId: string,
  name: string,
  ttlSeconds: number = OTL_DEFAULT_TTL_SECONDS
): Promise<MintedOtl> {
  if (!isValidVaultName(name)) throw new VaultError("INVALID_NAME");
  const exists = await db.get("SELECT 1 AS one FROM user_vaults WHERE user_id = ? AND name = ?", [
    userId,
    name,
  ]);
  if (!exists) throw new VaultError("NOT_FOUND");
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), OTL_MAX_TTL_SECONDS);
  const token = crypto.randomBytes(16).toString("hex");
  const expiresAt = now() + ttl * 1000;
  await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
    [token, userId, OTL_SENTINEL, Math.ceil(expiresAt / 1000), JSON.stringify({ name })]
  );
  return { token, url: otlUrl(token), expiresAt };
}

export async function consumeOtl(token: string): Promise<{ userId: string; name: string } | null> {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
  const row = await db.get<{ user_id: string; session_data: string | null }>(
    "SELECT user_id, session_data FROM pending_auth WHERE state = ? AND integration = ? AND expires_at > ?",
    [token, OTL_SENTINEL, Math.floor(now() / 1000)]
  );
  if (!row) return null;
  let name: unknown;
  try {
    name = (JSON.parse(row.session_data ?? "") as { name?: unknown }).name;
  } catch {
    return null;
  }
  if (!isValidVaultName(name)) return null;
  const { changes } = await db.run("DELETE FROM pending_auth WHERE state = ? AND integration = ?", [
    token,
    OTL_SENTINEL,
  ]);
  if (changes !== 1) return null;
  return { userId: row.user_id, name };
}

export async function revokeFor(userId: string, name: string): Promise<void> {
  await db.run(
    "DELETE FROM pending_auth WHERE user_id = ? AND integration = ? AND session_data = ?",
    [userId, OTL_SENTINEL, JSON.stringify({ name })]
  );
}

export async function reapExpiredOtl(): Promise<void> {
  await db.run("DELETE FROM pending_auth WHERE integration = ? AND expires_at < ?", [
    OTL_SENTINEL,
    Math.floor(now() / 1000),
  ]);
}

// In-process, like jots' upload reaper: these are DB rows, not a shared disk,
// so N pods sweeping is harmless, and the reap CLI must stay free of ../config.
let timer: NodeJS.Timeout | null = null;
export function startVaultReaper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void reapExpiredOtl().catch((e) => console.warn("[vault] otl reaper failed:", e));
  }, intervalMs);
  timer.unref?.();
}
export function stopVaultReaper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(vault): one-time links on pending_auth, DELETE-arbitrated"`

---

### Task 4: Interpolate + scrub (pure)

**Files:**
- Create: `packages/server/src/vault/interpolate.ts`
- Test: `packages/server/tests/vault-interpolate.test.ts`

**Interfaces (produces):**

```ts
export const VAULT_REF_RE: RegExp;   // /\{\{vault:([a-z0-9][a-z0-9_.-]{0,63})\}\}/g
export function findVaultRefs(args: unknown): string[];                       // distinct names, sorted
export function substituteVaultRefs<T>(args: T, values: Map<string, string>): T;  // deep copy, no mutation
export function scrubVaultValues<T>(value: T, substituted: Map<string, string>): T;
export function scrubString(s: string, substituted: Map<string, string>): string;
export class VaultRefError extends Error { code: "VAULT_SECRET_NOT_FOUND"; name_: string }
export async function resolveVaultRefs(userId: string, args: Record<string, unknown>):
  Promise<{ args: Record<string, unknown>; substituted: Map<string, string> }>;   // throws VaultRefError
```

- [ ] **Step 1: Write failing tests** `packages/server/tests/vault-interpolate.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { putSecret } from "../src/vault/store";
import {
  findVaultRefs,
  substituteVaultRefs,
  scrubVaultValues,
  scrubString,
  resolveVaultRefs,
} from "../src/vault/interpolate";

describe("findVaultRefs", () => {
  it("collects distinct names from nested strings only", () => {
    const args = {
      a: "{{vault:pw}}",
      b: ["x", "Bearer {{vault:tok}} and {{vault:pw}}"],
      c: { d: { e: "{{vault:third.v2-x}}" }, n: 1, t: true, z: null },
      "{{vault:key_is_not_scanned}}": "v",
      bad: "{{vault:Upper}} {{vault:}} {{vault:a b}}",
    };
    expect(findVaultRefs(args)).toEqual(["pw", "third.v2-x", "tok"]);
  });
  it("handles non-object input", () => {
    expect(findVaultRefs(undefined)).toEqual([]);
    expect(findVaultRefs("{{vault:x}}")).toEqual(["x"]);
  });
});

describe("substituteVaultRefs", () => {
  const values = new Map([
    ["pw", "hunter2"],
    ["tok", "tok-abc"],
  ]);
  it("replaces whole, embedded and repeated refs", () => {
    const out = substituteVaultRefs(
      { a: "{{vault:pw}}", b: "Bearer {{vault:tok}}/{{vault:tok}}", c: [{ d: "{{vault:pw}}!" }] },
      values
    );
    expect(out).toEqual({ a: "hunter2", b: "Bearer tok-abc/tok-abc", c: [{ d: "hunter2!" }] });
  });
  it("does not mutate its input", () => {
    const input = { a: "{{vault:pw}}", nested: { b: ["{{vault:pw}}"] } };
    const snapshot = JSON.parse(JSON.stringify(input));
    substituteVaultRefs(input, values);
    expect(input).toEqual(snapshot);
  });
  it("leaves unknown refs and non-strings alone", () => {
    const out = substituteVaultRefs({ a: "{{vault:missing}}", n: 5, b: false }, values);
    expect(out).toEqual({ a: "{{vault:missing}}", n: 5, b: false });
  });
});

describe("scrub", () => {
  const sub = new Map([
    ["pw", "hunter2"],
    ["long", "hunter2-extended"],
  ]);
  it("replaces plaintext in strings, longest value first", () => {
    expect(scrubString("x hunter2-extended y hunter2", sub)).toBe("x {{vault:long}} y {{vault:pw}}");
  });
  it("walks JSON-shaped results", () => {
    const out = scrubVaultValues(
      { text: "pw is hunter2", arr: ["hunter2", 1, null], deep: { v: "hunter2-extended" } },
      sub
    );
    expect(out).toEqual({
      text: "pw is {{vault:pw}}",
      arr: ["{{vault:pw}}", 1, null],
      deep: { v: "{{vault:long}}" },
    });
  });
  it("is a no-op with nothing substituted", () => {
    const r = { a: "hunter2" };
    expect(scrubVaultValues(r, new Map())).toBe(r);
  });
  it("passes non-JSON values through", () => {
    const fn = () => 1;
    expect(scrubVaultValues(fn, sub)).toBe(fn);
    expect(scrubVaultValues(undefined, sub)).toBeUndefined();
  });
  it("scrubs error messages", () => {
    expect(scrubString("401 for token hunter2", sub)).toBe("401 for token {{vault:pw}}");
  });
});

describe("resolveVaultRefs", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM user_vaults");
    await putSecret("u1", "pw", "hunter2");
  });
  it("resolves from the store and reports what it substituted", async () => {
    const r = await resolveVaultRefs("u1", { text: "{{vault:pw}}" });
    expect(r.args).toEqual({ text: "hunter2" });
    expect([...r.substituted]).toEqual([["pw", "hunter2"]]);
  });
  it("returns the same args and empty map when there are no refs", async () => {
    const args = { text: "plain" };
    const r = await resolveVaultRefs("u1", args);
    expect(r.args).toBe(args);
    expect(r.substituted.size).toBe(0);
  });
  it("throws VAULT_SECRET_NOT_FOUND for an unknown name", async () => {
    await expect(resolveVaultRefs("u1", { text: "{{vault:nope}}" })).rejects.toMatchObject({
      code: "VAULT_SECRET_NOT_FOUND",
      secretName: "nope",
    });
  });
  it("does not resolve another user's secret", async () => {
    await expect(resolveVaultRefs("u2", { text: "{{vault:pw}}" })).rejects.toMatchObject({
      code: "VAULT_SECRET_NOT_FOUND",
    });
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** `packages/server/src/vault/interpolate.ts`:

```ts
import { readSecretValue } from "./store";

// `{{vault:NAME}}` in tool args → the secret's value, applied at the top of
// executeSingle (mcp/meta-tools.ts) so MCP, batch and REST all go through it.
// The model composes references; the server sees values; the model never does.
//
// The grammar inside the braces is the store's name grammar. Anything that does
// not match is not a reference and is left for the tool's own schema to reject.

export const VAULT_REF_RE = /\{\{vault:([a-z0-9][a-z0-9_.-]{0,63})\}\}/g;

export class VaultRefError extends Error {
  readonly code = "VAULT_SECRET_NOT_FOUND" as const;
  constructor(public readonly secretName: string) {
    super(`No secret named '${secretName}'. Call vault_list to see what exists.`);
    this.name = "VaultRefError";
  }
}

function walkStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkStrings(v, fn);
    return out;
  }
  return value;
}

export function findVaultRefs(args: unknown): string[] {
  const names = new Set<string>();
  walkStrings(args, (s) => {
    for (const m of s.matchAll(VAULT_REF_RE)) names.add(m[1]);
    return s;
  });
  return [...names].sort();
}

export function substituteVaultRefs<T>(args: T, values: Map<string, string>): T {
  return walkStrings(args, (s) =>
    s.replace(VAULT_REF_RE, (whole, name: string) => values.get(name) ?? whole)
  ) as T;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrubString(s: string, substituted: Map<string, string>): string {
  if (substituted.size === 0) return s;
  // Longest value first so a value that contains another is replaced whole.
  const entries = [...substituted].sort((a, b) => b[1].length - a[1].length);
  let out = s;
  for (const [name, value] of entries) {
    if (value === "") continue;
    out = out.replace(new RegExp(escapeRe(value), "g"), `{{vault:${name}}}`);
  }
  return out;
}

/**
 * Put the references back into a tool result before it re-enters the model.
 *
 * Only what THIS call substituted is scrubbed. Scanning every result for every
 * secret the user owns would decrypt the whole vault on each call, and a short
 * value would collide with unrelated output. Best-effort against encodings: a
 * base64'd or URL-encoded echo is not caught.
 */
export function scrubVaultValues<T>(value: T, substituted: Map<string, string>): T {
  if (substituted.size === 0) return value;
  if (value === undefined || typeof value === "function") return value;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    return JSON.parse(scrubString(json, substituted)) as T;
  } catch {
    return value;
  }
}

export async function resolveVaultRefs(
  userId: string,
  args: Record<string, unknown>
): Promise<{ args: Record<string, unknown>; substituted: Map<string, string> }> {
  const names = findVaultRefs(args);
  const substituted = new Map<string, string>();
  if (names.length === 0) return { args, substituted };
  for (const name of names) {
    const value = await readSecretValue(userId, name);
    if (value === null) throw new VaultRefError(name);
    substituted.set(name, value);
  }
  return { args: substituteVaultRefs(args, substituted), substituted };
}
```

Note on `scrubString` over JSON text: the value is regex-escaped but the haystack is the JSON-encoded string, so a value containing `"` or `\` is encoded as `\"`/`\\` in the haystack and will not match the raw value. Handle it: in `scrubVaultValues` build the needle as `JSON.stringify(value).slice(1, -1)` (the JSON-escaped form) rather than the raw value. Implement by passing a transformed map:

```ts
    const jsonNeedles = new Map([...substituted].map(([n, v]) => [n, JSON.stringify(v).slice(1, -1)]));
    return JSON.parse(scrubString(json, jsonNeedles)) as T;
```

Add a test for it in the scrub block:

```ts
  it("catches values with JSON-escaped characters", () => {
    const m = new Map([["q", 'say "hi"\\now']]);
    expect(scrubVaultValues({ t: 'x say "hi"\\now y' }, m)).toEqual({ t: "x {{vault:q}} y" });
  });
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(vault): reference interpolation and result scrub"`

---

### Task 5: Hook into executeSingle

**Files:**
- Modify: `packages/server/src/mcp/meta-tools.ts:69-215` (`executeSingle`)
- Test: `packages/server/tests/meta-tools.test.ts` (new describe block)

**Interfaces:**
- Consumes: `resolveVaultRefs`, `scrubVaultValues`, `scrubString`, `VaultRefError` (Task 4), `touchUsed` (Task 2).

- [ ] **Step 1: Write failing tests.** Add to the top-of-file mocks in `packages/server/tests/meta-tools.test.ts`:

```ts
vi.mock("../src/vault/store", () => ({
  readSecretValue: vi.fn(async (_u: string, name: string) =>
    name === "pw" ? "hunter2" : name === "port" ? "5432" : null
  ),
  touchUsed: vi.fn(async () => undefined),
}));
```

Add a describe block after `execute_tools (single execution)`:

```ts
  describe("vault interpolation in executeSingle", () => {
    const runOne = (tool: any, exec: { tool: string; args: Record<string, unknown> }) =>
      tool.handler({ userId: "user-1" }, { executions: [exec] }).then((r: any) => r.results[0]);

    beforeEach(async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);
    });

    it("substitutes before the handler and scrubs the result", async () => {
      const { z } = await import("zod");
      const echo = {
        name: "echo",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { text: string }) => ({ echoed: `got ${a.text}` })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(echo as any);
      const result = await runOne(findTool("execute_tools"), {
        tool: "echo",
        args: { text: "pw={{vault:pw}}" },
      });
      expect(echo.handler).toHaveBeenCalledWith(expect.anything(), { text: "pw=hunter2" });
      expect(result.result).toEqual({ echoed: "got pw={{vault:pw}}" });
      const { touchUsed } = await import("../src/vault/store");
      expect(touchUsed).toHaveBeenCalledWith("user-1", ["pw"]);
    });

    it("runs before zod so coercion applies to the substituted value", async () => {
      const { z } = await import("zod");
      const t = {
        name: "num",
        integration: "test-integ",
        inputSchema: z.object({ port: z.coerce.number() }),
        handler: vi.fn(async (_c: unknown, a: { port: number }) => ({ port: a.port })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      const result = await runOne(findTool("execute_tools"), { tool: "num", args: { port: "{{vault:port}}" } });
      expect(t.handler).toHaveBeenCalledWith(expect.anything(), { port: 5432 });
      expect(result.result).toEqual({ port: "{{vault:port}}" });
    });

    it("fails closed on an unknown secret and never calls the handler", async () => {
      const t = { ...mockTool, handler: vi.fn() };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      const result = await runOne(findTool("execute_tools"), { tool: "test_tool", args: { x: "{{vault:nope}}" } });
      expect(result.error).toBe("VAULT_SECRET_NOT_FOUND");
      expect(result.message).toContain("nope");
      expect(t.handler).not.toHaveBeenCalled();
      const { auditLogger } = await import("../src/audit/logger");
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: "VAULT_SECRET_NOT_FOUND" })
      );
    });

    it("scrubs a thrown error message", async () => {
      const { z } = await import("zod");
      const t = {
        name: "boom",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { text: string }) => {
          throw new Error(`upstream rejected ${a.text}`);
        }),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      const result = await runOne(findTool("execute_tools"), { tool: "boom", args: { text: "{{vault:pw}}" } });
      expect(result.error).toBe("upstream rejected {{vault:pw}}");
      const { auditLogger } = await import("../src/audit/logger");
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: "upstream rejected {{vault:pw}}" })
      );
    });

    it("leaves vault_* tool args untouched", async () => {
      const { z } = await import("zod");
      const t = {
        name: "vault_presign",
        integration: "vault",
        inputSchema: z.object({ name: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { name: string }) => ({ got: a.name })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      vi.spyOn(registry, "getIntegration").mockReturnValue({ name: "vault", version: "1", auth: { type: "none" } } as any);
      const result = await runOne(findTool("execute_tools"), { tool: "vault_presign", args: { name: "{{vault:pw}}" } });
      expect(t.handler).toHaveBeenCalledWith(expect.anything(), { name: "{{vault:pw}}" });
      expect(result.result).toEqual({ got: "{{vault:pw}}" });
    });
  });
```

`mockTool.inputSchema` is `{ type: "object" }` (no `safeParse`) — in the "unknown secret" test the vault error returns before parsing, so that is fine.

- [ ] **Step 2: Run, expect fail** — `npx vitest run tests/meta-tools.test.ts`.

- [ ] **Step 3: Implement.** In `meta-tools.ts` add imports:

```ts
import { resolveVaultRefs, scrubVaultValues, scrubString, VaultRefError } from "../vault/interpolate";
import { touchUsed } from "../vault/store";
```

Inside `executeSingle`, right after the `NOT_CONNECTED` block and before the `// Validate args …` comment, insert:

```ts
      // Vault references: `{{vault:name}}` → value, before validation so the
      // tool's own zod coercion still applies. The vault's own tools take names
      // as arguments, so a reference there is literal, not a lookup.
      let effectiveArgs: Record<string, unknown> = rawArgs ?? {};
      let substituted = new Map<string, string>();
      if (!toolName.startsWith("vault_")) {
        try {
          const resolved = await resolveVaultRefs(userId, effectiveArgs);
          effectiveArgs = resolved.args;
          substituted = resolved.substituted;
        } catch (e) {
          if (e instanceof VaultRefError) {
            await auditLogger.log({
              user_id: userId,
              integration: targetTool.integration,
              tool: toolName,
              action: "EXECUTE",
              success: false,
              error: e.code,
              duration_ms: Date.now() - start,
            });
            return { error: e.code, message: e.message };
          }
          throw e;
        }
        if (substituted.size > 0) {
          void touchUsed(userId, [...substituted.keys()]).catch(() => undefined);
        }
      }
```

Then change `let parsedArgs: unknown = rawArgs;` → `let parsedArgs: unknown = effectiveArgs;` and `safeParse(rawArgs ?? {})` → `safeParse(effectiveArgs)`.

In the success path, change `const result = await targetTool.handler(...)` to:

```ts
        const result = scrubVaultValues(
          await targetTool.handler(toolCtx, parsedArgs as Record<string, unknown>),
          substituted
        );
```

In the catch path, change `const err = e instanceof Error ? e.message : String(e);` to:

```ts
        const err = scrubString(e instanceof Error ? e.message : String(e), substituted);
```

- [ ] **Step 4: Run, expect pass.** Also run the whole server suite: `npx vitest run` in `packages/server` — no regressions.
- [ ] **Step 5: Commit** — `git commit -m "feat(vault): resolve {{vault:*}} refs in executeSingle, scrub results"`

---

### Task 6: Internal plugin `vault`

**Files:**
- Create: `packages/server/src/plugins/internal/vault.ts`
- Modify: `packages/server/src/plugins/loader.ts:6-8, 158-162`
- Test: `packages/server/tests/vault-tools.test.ts`

**Interfaces:**
- Consumes: `listSecrets` (Task 2), `mintOtl`, `OTL_MAX_TTL_SECONDS` (Task 3).
- Produces: `vaultPlugin: Plugin`, `VAULT_INTEGRATION_NAME = "vault"`, tools `vault_list`, `vault_presign`.

- [ ] **Step 1: Write failing tests** `packages/server/tests/vault-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { putSecret } from "../src/vault/store";
import { consumeOtl } from "../src/vault/otl";
import { vaultPlugin, VAULT_INTEGRATION_NAME } from "../src/plugins/internal/vault";

const tool = (name: string) => {
  const t = vaultPlugin.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const run = (name: string, userId: string, args: Record<string, unknown> = {}) => {
  const t = tool(name);
  return t.handler({ userId } as never, t.inputSchema.parse(args) as never) as Promise<any>;
};

beforeEach(async () => {
  await db.run("DELETE FROM user_vaults");
  await db.run("DELETE FROM pending_auth");
  await putSecret("u1", "pw", "hunter2", "login");
});

describe("vault plugin", () => {
  it("registers the two tools under the vault integration with no auth", () => {
    expect(vaultPlugin.integration.name).toBe(VAULT_INTEGRATION_NAME);
    expect(vaultPlugin.integration.auth).toEqual({ type: "none" });
    expect(vaultPlugin.tools.map((t) => t.name).sort()).toEqual(["vault_list", "vault_presign"]);
  });

  it("every tool name is vault_-prefixed so executeSingle exempts it", () => {
    for (const t of vaultPlugin.tools) expect(t.name.startsWith("vault_")).toBe(true);
  });

  it("vault_list returns metadata and never the value", async () => {
    const r = await run("vault_list", "u1");
    expect(r.secrets).toEqual([
      expect.objectContaining({ name: "pw", description: "login", last_used_at: null }),
    ]);
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(r.secrets[0].reference).toBe("{{vault:pw}}");
  });

  it("vault_presign mints a single-use url", async () => {
    const r = await run("vault_presign", "u1", { name: "pw" });
    expect(r.url).toMatch(/\/api\/vault\/otl\/[0-9a-f]{32}$/);
    expect(typeof r.expires_at).toBe("string");
    const token = r.url.split("/").pop();
    expect(await consumeOtl(token)).toEqual({ userId: "u1", name: "pw" });
  });

  it("vault_presign reports NOT_FOUND and INVALID_NAME", async () => {
    expect(await run("vault_presign", "u1", { name: "nope" })).toEqual({ error: "NOT_FOUND" });
    expect(await run("vault_presign", "u1", { name: "Bad" })).toEqual({ error: "INVALID_NAME" });
  });

  it("vault_presign schema caps ttl", () => {
    expect(() => tool("vault_presign").inputSchema.parse({ name: "pw", ttl_seconds: 601 })).toThrow();
    expect(() => tool("vault_presign").inputSchema.parse({ name: "pw", ttl_seconds: 0 })).toThrow();
  });

  it("tool descriptions tell the agent never to echo the value", () => {
    const d = tool("vault_presign").description.toLowerCase();
    expect(d).toContain("once");
    expect(d).toContain("curl");
    expect(tool("vault_list").description).toContain("{{vault:");
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** `packages/server/src/plugins/internal/vault.ts`:

```ts
// The user vault as an internal registry plugin. Server source, not
// PLUGINS_DIR: the handlers reach into the vault store, and this is the one
// integration whose whole point is that the model never sees a value.
import { z } from "zod";
import { Plugin, PluginTool } from "../registry";
import { listSecrets, VaultError } from "../../vault/store";
import { mintOtl, OTL_DEFAULT_TTL_SECONDS, OTL_MAX_TTL_SECONDS } from "../../vault/otl";

export const VAULT_INTEGRATION_NAME = "vault";

const HOW_TO_REFERENCE =
  "To use a secret, write {{vault:NAME}} anywhere inside another tool's arguments (whole value or embedded, e.g. \"Bearer {{vault:api_token}}\"). The server swaps in the real value after your arguments leave the model and before the tool runs, and swaps it back out of the result. You never see the value, and you must never ask for it.";

function fail(e: unknown): { error: string } {
  if (e instanceof VaultError) return { error: e.code };
  throw e;
}

const tools: PluginTool[] = [
  {
    name: "vault_list",
    description: `List the secrets in the user's vault: names and descriptions only, never values. Secrets are added by the user in the portal; you cannot create or read them. ${HOW_TO_REFERENCE}`,
    integration: VAULT_INTEGRATION_NAME,
    inputSchema: z.object({}),
    handler: async (ctx: any) => {
      const secrets = await listSecrets(ctx.userId);
      return {
        secrets: secrets.map((s) => ({ ...s, reference: `{{vault:${s.name}}}` })),
      };
    },
  },
  {
    name: "vault_presign",
    description: `Mint a one-time URL for a secret's value, for when the value is needed OUTSIDE workbench — a local script, an .env file, a CI job. Fetch it from where the value is needed and write it straight to a file or a variable, never to your output: curl -fsS "$URL" -o ./secret.txt   or   TOKEN=$(curl -fsS "$URL"). The URL works exactly once and expires after ttl_seconds (default ${OTL_DEFAULT_TTL_SECONDS}, max ${OTL_MAX_TTL_SECONDS}); if the fetch fails, mint another. Do not fetch it yourself and do not print what it returns. For use inside another workbench tool, do not presign — write {{vault:NAME}} in that tool's arguments instead.`,
    integration: VAULT_INTEGRATION_NAME,
    inputSchema: z.object({
      name: z.string(),
      ttl_seconds: z.number().int().positive().max(OTL_MAX_TTL_SECONDS).optional(),
    }),
    handler: async (ctx: any, args: any) => {
      try {
        const m = await mintOtl(ctx.userId, args.name, args.ttl_seconds);
        return { url: m.url, expires_at: new Date(m.expiresAt).toISOString() };
      } catch (e) {
        return fail(e);
      }
    },
  },
];

export const vaultPlugin: Plugin = {
  integration: {
    name: VAULT_INTEGRATION_NAME,
    version: "1.0.0",
    auth: { type: "none" },
    displayName: "Vault",
    description:
      "Per-user encrypted secrets the agent can use but never read. Reference a secret as {{vault:NAME}} inside any tool's arguments, or mint a one-time URL to hand the value to a script.",
    categories: ["security"],
  },
  tools,
};
```

In `loader.ts`: `import { vaultPlugin } from "./internal/vault";` and `registry.register(vaultPlugin);` inside `registerInternalPlugins`. Check `categories` accepted values in `packages/shared` — if it is an enum without `"security"`, use an existing one (`"files"` or `"utility"`).

- [ ] **Step 4: Run, expect pass.** Also `npx vitest run tests/loader*.test.ts` if one exists (it may assert the internal plugin list).
- [ ] **Step 5: Commit** — `git commit -m "feat(vault): vault_list and vault_presign internal tools"`

---

### Task 7: HTTP routes

**Files:**
- Create: `packages/server/src/vault/routes.ts`
- Modify: `packages/server/src/index.ts` (import; `await registerVaultRoutes(app);` after `registerWorkspaceRoutes`; `startVaultReaper();` after `startUploadReaper();`)
- Test: `packages/server/tests/vault-routes.test.ts`

**Interfaces:**
- Consumes: store (Task 2), otl (Task 3).
- Produces: `registerVaultRoutes(app: FastifyInstance): Promise<void>`.

- [ ] **Step 1: Write failing tests** `packages/server/tests/vault-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) =>
    headers.authorization === "Bearer u1-token" ? "u1" : headers.authorization === "Bearer u2-token" ? "u2" : null
  ),
}));

import { registerVaultRoutes } from "../src/vault/routes";
import { putSecret, readSecretValue } from "../src/vault/store";
import { mintOtl, _setNowForTest } from "../src/vault/otl";
import { db } from "../src/db";

const U1 = { authorization: "Bearer u1-token" };
const U2 = { authorization: "Bearer u2-token" };
let app: FastifyInstance;
let logged: string[];

beforeEach(async () => {
  await db.run("DELETE FROM user_vaults");
  await db.run("DELETE FROM pending_auth");
  logged = [];
  app = Fastify({
    logger: {
      level: "info",
      stream: { write: (s: string) => { logged.push(s); } } as any,
    },
  });
  await registerVaultRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  _setNowForTest(() => Date.now());
});

describe("vault routes", () => {
  it("requires a bearer on list/put/delete", async () => {
    expect((await app.inject({ method: "GET", url: "/api/vault" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", payload: { value: "x" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw" })).statusCode).toBe(401);
  });

  it("PUT creates then overwrites; GET lists without the value", async () => {
    const c = await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "hunter2", description: "d" } });
    expect(c.statusCode).toBe(201);
    const o = await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "hunter3" } });
    expect(o.statusCode).toBe(200);
    expect(await readSecretValue("u1", "pw")).toBe("hunter3");
    const l = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(l.statusCode).toBe(200);
    expect(l.json().secrets).toEqual([expect.objectContaining({ name: "pw" })]);
    expect(l.body).not.toContain("hunter");
    expect((await app.inject({ method: "GET", url: "/api/vault", headers: U2 })).json().secrets).toEqual([]);
  });

  it("PUT validates", async () => {
    expect((await app.inject({ method: "PUT", url: "/api/vault/Bad", headers: U1, payload: { value: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "x".repeat(9000) } })).statusCode).toBe(413);
  });

  it("DELETE removes the secret and its outstanding links", async () => {
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw");
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: U1 })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: U1 })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` })).statusCode).toBe(404);
  });

  it("a user cannot delete another user's secret", async () => {
    await putSecret("u1", "pw", "hunter2");
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: U2 })).statusCode).toBe(404);
    expect(await readSecretValue("u1", "pw")).toBe("hunter2");
  });

  it("OTL redeems once as text/plain with no-store, then 404s", async () => {
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw");
    const r = await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("hunter2");
    expect(r.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-disposition"]).toContain("attachment");
    const again = await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` });
    expect(again.statusCode).toBe(404);
    expect(again.body).toBe("");
  });

  it("OTL 404s empty for junk, expired, and unknown alike", async () => {
    const t0 = Date.now();
    _setNowForTest(() => t0);
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw", 30);
    _setNowForTest(() => t0 + 31_000);
    for (const url of [`/api/vault/otl/${m.token}`, "/api/vault/otl/zz", `/api/vault/otl/${"0".repeat(32)}`]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe("");
    }
  });

  it("OTL route never reaches the request log", async () => {
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw");
    await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` });
    await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    const joined = logged.join("\n");
    expect(joined).not.toContain(m.token);
    expect(joined).toContain("/api/vault");
  });

  it("OTL redeem stamps last_used_at", async () => {
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw");
    await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` });
    const l = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(l.json().secrets[0].last_used_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** `packages/server/src/vault/routes.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { resolveMcpUser } from "../auth/oauth-server/resolve";
import {
  deleteSecret,
  listSecrets,
  putSecret,
  readSecretValue,
  touchUsed,
  VaultError,
} from "./store";
import { consumeOtl, revokeFor } from "./otl";

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = await resolveMcpUser(request.headers as Record<string, string>);
  if (userId) return userId;
  const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  reply.header("WWW-Authenticate", `Bearer realm="a-workbench", resource_metadata="${prm}"`);
  reply.status(401).send({ error: "Unauthorized", resource_metadata: prm });
  return null;
}

function statusFor(code: VaultError["code"]): number {
  switch (code) {
    case "INVALID_NAME":
    case "EMPTY_VALUE":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "TOO_LARGE":
      return 413;
  }
}

export async function registerVaultRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vault", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (!userId) return reply;
    return reply.send({ secrets: await listSecrets(userId) });
  });

  // The only route that ever carries a plaintext value, and only the portal
  // calls it. Fastify does not log bodies.
  app.put<{ Params: { name: string }; Body: unknown }>("/api/vault/:name", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (!userId) return reply;
    const body = (request.body ?? {}) as { value?: unknown; description?: unknown };
    if (typeof body.value !== "string") return reply.code(400).send({ error: "INVALID_VALUE" });
    if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
      return reply.code(400).send({ error: "INVALID_DESCRIPTION" });
    }
    try {
      const { created } = await putSecret(userId, request.params.name, body.value, body.description ?? null);
      return reply.code(created ? 201 : 200).send({ ok: true, created });
    } catch (e) {
      if (e instanceof VaultError) return reply.code(statusFor(e.code)).send({ error: e.code });
      throw e;
    }
  });

  app.delete<{ Params: { name: string } }>("/api/vault/:name", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (!userId) return reply;
    const gone = await deleteSecret(userId, request.params.name);
    if (!gone) return reply.code(404).send({ error: "NOT_FOUND" });
    await revokeFor(userId, request.params.name);
    return reply.code(204).send();
  });

  // One-time redeem. No bearer: the token is the authorization, single-use,
  // minutes of TTL. The user whose value is read comes from the row. Silent in
  // the request log because the token is the URL.
  app.get<{ Params: { token: string } }>(
    "/api/vault/otl/:token",
    { logLevel: "silent" },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-disposition", 'attachment; filename="secret.txt"');
      const grant = await consumeOtl(request.params.token);
      if (!grant) return reply.code(404).send();
      const value = await readSecretValue(grant.userId, grant.name);
      if (value === null) return reply.code(404).send();
      void touchUsed(grant.userId, [grant.name]).catch(() => undefined);
      return reply.type("text/plain; charset=utf-8").send(value);
    }
  );
}
```

In `index.ts`:

```ts
import { registerVaultRoutes } from "./vault/routes";
import { startVaultReaper } from "./vault/otl";
…
  await registerWorkspaceRoutes(app);
  await registerVaultRoutes(app);
…
  startUploadReaper();
  startVaultReaper();
```

If Fastify's `logLevel: "silent"` on a route option is rejected by the type, use the `config: {}` form `{ logLevel: "silent" as const }` — Fastify supports per-route `logLevel`. Verify with the "never reaches the request log" test.

- [ ] **Step 4: Run, expect pass.** Then full server suite.
- [ ] **Step 5: Commit** — `git commit -m "feat(vault): /api/vault routes and one-time redeem"`

---

### Task 8: Portal

**Files:**
- Modify: `packages/portal/src/api.ts` (append after workspace section)
- Create: `packages/portal/src/pages/Vault.tsx`, `packages/portal/src/pages/Vault.test.tsx`
- Modify: `packages/portal/src/App.tsx:14,75`, `packages/portal/src/components/shell/Sidebar.tsx:66`

**Interfaces (produces):**

```ts
export interface VaultSecret { name: string; description: string | null; created_at: number; updated_at: number; last_used_at: number | null }
export async function fetchVaultSecrets(): Promise<VaultSecret[]>;
export async function putVaultSecret(input: { name: string; value: string; description?: string }): Promise<void>;
export async function deleteVaultSecret(name: string): Promise<void>;
```

- [ ] **Step 1: Write failing test** `packages/portal/src/pages/Vault.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Vault, { relativeTime } from "./Vault";

vi.mock("../api", () => ({
  fetchVaultSecrets: vi.fn(),
  putVaultSecret: vi.fn(async () => undefined),
  deleteVaultSecret: vi.fn(async () => undefined),
}));

import { fetchVaultSecrets, putVaultSecret, deleteVaultSecret } from "../api";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Vault />
    </QueryClientProvider>
  );
}

const nowSec = Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchVaultSecrets).mockResolvedValue([
    { name: "site_pw", description: "login", created_at: nowSec - 3600, updated_at: nowSec - 3600, last_used_at: nowSec - 60 },
    { name: "api_key", description: null, created_at: nowSec, updated_at: nowSec, last_used_at: null },
  ]);
});

describe("relativeTime", () => {
  it("phrases seconds ago", () => {
    expect(relativeTime(nowSec - 30, nowSec)).toBe("just now");
    expect(relativeTime(nowSec - 120, nowSec)).toBe("2m ago");
    expect(relativeTime(nowSec - 7200, nowSec)).toBe("2h ago");
    expect(relativeTime(nowSec - 3 * 86400, nowSec)).toBe("3d ago");
    expect(relativeTime(null, nowSec)).toBe("never");
  });
});

describe("Vault page", () => {
  it("lists secrets with their reference and never a value column", async () => {
    renderPage();
    expect(await screen.findByText("site_pw")).toBeInTheDocument();
    expect(screen.getByText("{{vault:site_pw}}")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
    expect(screen.queryByText(/reveal|show value|copy value/i)).not.toBeInTheDocument();
  });

  it("adds a secret and clears the value field afterwards", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getByRole("button", { name: /add secret/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "db_url" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "prod" } });
    const valueInput = screen.getByLabelText(/^value/i) as HTMLInputElement;
    expect(valueInput.type).toBe("password");
    fireEvent.change(valueInput, { target: { value: "postgres://x" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(putVaultSecret).toHaveBeenCalledWith({ name: "db_url", value: "postgres://x", description: "prod" })
    );
    await waitFor(() => expect(screen.queryByLabelText(/^value/i)).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain("postgres://x");
  });

  it("rejects an invalid name client-side", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getByRole("button", { name: /add secret/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "Bad Name" } });
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/lowercase/i)).toBeInTheDocument();
    expect(putVaultSecret).not.toHaveBeenCalled();
  });

  it("overwrite locks the name", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getAllByRole("button", { name: /replace/i })[0]);
    const name = screen.getByLabelText(/^name/i) as HTMLInputElement;
    expect(name.value).toBe("site_pw");
    expect(name.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(putVaultSecret).toHaveBeenCalledWith({ name: "site_pw", value: "new", description: "login" })
    );
  });

  it("deletes after confirmation", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getAllByRole("button", { name: /^delete$/i })[0]);
    expect(await screen.findByText(/delete this secret/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /^delete$/i }).at(-1)!);
    await waitFor(() => expect(deleteVaultSecret).toHaveBeenCalledWith("site_pw"));
  });
});
```

- [ ] **Step 2: Run, expect fail** — `cd packages/portal && npx vitest run src/pages/Vault.test.tsx`.

- [ ] **Step 3: Implement.**

`api.ts` append:

```ts
// ─── Vault ────────────────────────────────────────────────────────────────
// Write-only from every surface: the list never carries a value and there is
// no read endpoint. To rotate, overwrite.

export interface VaultSecret {
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export async function fetchVaultSecrets(): Promise<VaultSecret[]> {
  const res = await fetch(`${API_URL}/api/vault`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load vault");
  return (await res.json()).secrets;
}

export async function putVaultSecret(input: {
  name: string;
  value: string;
  description?: string;
}): Promise<void> {
  const res = await fetch(`${API_URL}/api/vault/${encodeURIComponent(input.name)}`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ value: input.value, description: input.description ?? null }),
  });
  if (!res.ok) {
    const code = (await res.json().catch(() => ({}))).error;
    throw new Error(
      code === "INVALID_NAME"
        ? "Names are lowercase letters, digits, and _ . - (max 64)."
        : code === "TOO_LARGE"
          ? "Value is too large (8 KB max)."
          : code === "EMPTY_VALUE"
            ? "Value cannot be empty."
            : "Save failed"
    );
  }
}

export async function deleteVaultSecret(name: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/vault/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Delete failed");
}
```

`pages/Vault.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchVaultSecrets, putVaultSecret, deleteVaultSecret, type VaultSecret } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { DataTable } from "../components/ui/DataTable";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const NAME_HELP = "Lowercase letters, digits, and _ . - only (max 64).";

export function relativeTime(sec: number | null, nowSec: number = Math.floor(Date.now() / 1000)): string {
  if (sec === null || sec === undefined) return "never";
  const d = Math.max(0, nowSec - sec);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

type Editing = { mode: "add" } | { mode: "replace"; secret: VaultSecret };

export default function Vault() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<VaultSecret | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({ queryKey: ["vault"], queryFn: fetchVaultSecrets });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["vault"] });

  function openAdd() {
    setEditing({ mode: "add" });
    setName("");
    setDescription("");
    setValue("");
    setShowValue(false);
    setFormError(null);
  }
  function openReplace(secret: VaultSecret) {
    setEditing({ mode: "replace", secret });
    setName(secret.name);
    setDescription(secret.description ?? "");
    setValue("");
    setShowValue(false);
    setFormError(null);
  }
  // The value never outlives the dialog: cleared on close, success or cancel.
  function closeEditor() {
    if (save.isPending) return;
    setEditing(null);
    setValue("");
    setShowValue(false);
  }

  const save = useMutation({
    mutationFn: putVaultSecret,
    onSuccess: () => {
      setEditing(null);
      setValue("");
      void invalidate();
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const remove = useMutation({
    mutationFn: deleteVaultSecret,
    onSuccess: () => {
      setPendingDelete(null);
      void invalidate();
    },
    onError: (e: Error) => setDeleteError(e.message),
  });

  function submit() {
    if (!NAME_RE.test(name)) return setFormError(NAME_HELP);
    if (value === "") return setFormError("Value cannot be empty.");
    setFormError(null);
    save.mutate({ name, value, description: description || undefined });
  }

  const secrets = data ?? [];

  return (
    <>
      <PageHeader title="Vault" actions={<Button onClick={openAdd}>Add secret</Button>} />

      <Box
        title="Secrets"
        action={
          <span className="ui-stat-note">
            Encrypted at rest. Agents can use a secret but never read it — values are write-only here too.
          </span>
        }
      >
        {isLoading && <div className="ui-loading">Loading…</div>}
        {isError && <div className="ui-form-error">Couldn't load your vault.</div>}

        {!isLoading && !isError && secrets.length === 0 && (
          <EmptyState message="No secrets yet. Add a password or API key here, then tell your agent to use {{vault:NAME}} where the value goes." />
        )}

        {secrets.length > 0 && (
          <DataTable
            caption="Secrets in your vault"
            head={
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Reference</th>
                <th scope="col">Description</th>
                <th scope="col">Updated</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="ui-sr-only">Actions</span>
                </th>
              </tr>
            }
          >
            {secrets.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td>
                  <code>{`{{vault:${s.name}}}`}</code>
                </td>
                <td>{s.description ?? ""}</td>
                <td>{relativeTime(s.updated_at)}</td>
                <td>{relativeTime(s.last_used_at)}</td>
                <td>
                  <Button variant="ghost" onClick={() => openReplace(s)}>
                    Replace
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDeleteError(null);
                      setPendingDelete(s);
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Box>

      <Modal
        open={editing !== null}
        onClose={closeEditor}
        title={editing?.mode === "replace" ? "Replace value" : "Add secret"}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={closeEditor} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          autoComplete="off"
        >
          <label className="ui-field">
            <span>Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={editing?.mode === "replace"}
              placeholder="site_password"
              autoComplete="off"
            />
          </label>
          <label className="ui-field">
            <span>Description</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
          </label>
          <label className="ui-field">
            <span>Value</span>
            <Input
              type={showValue ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <Button type="button" variant="ghost" onClick={() => setShowValue((v) => !v)}>
            {showValue ? "Hide" : "Show"} while typing
          </Button>
          <p className="ui-stat-note">{NAME_HELP} The value is never shown again after saving.</p>
          {formError && <div className="ui-form-error">{formError}</div>}
        </form>
      </Modal>

      <Modal
        open={pendingDelete !== null}
        onClose={() => {
          if (!remove.isPending) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        title="Delete this secret?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => pendingDelete && remove.mutate(pendingDelete.name)}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        <p>
          <strong>{pendingDelete?.name}</strong> will be removed immediately. Any agent referencing
          it will fail on its next use. This cannot be undone.
        </p>
        {deleteError && <div className="ui-form-error">{deleteError}</div>}
      </Modal>
    </>
  );
}
```

If `<label>` wrapping `<Input>` does not give `getByLabelText` a match (the `Input` component spreads props onto `<input>`, so it should), add `id`/`htmlFor` pairs. Check `Files.tsx` or `Apps` pages for the existing `ui-field` class name; if it does not exist, use whatever label class the `ApiKeyAuthModal` uses.

`App.tsx`: `import Vault from "./pages/Vault";` and `<Route path="/vault" element={<Vault />} />` after the files route.

`Sidebar.tsx`: second nav group becomes

```ts
  [
    { to: "/files", label: "Files", end: false, Glyph: FilesIcon },
    { to: "/vault", label: "Vault", end: false, Glyph: VaultIcon },
  ],
```

Add a `VaultIcon` next to `FilesIcon` in the same file (copy `FilesIcon`'s SVG wrapper; use a simple padlock path: `<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`).

- [ ] **Step 4: Run, expect pass.** Then `cd packages/portal && npx vitest run` and `npx tsc --noEmit -p .` (or the package's typecheck script).
- [ ] **Step 5: Commit** — `git commit -m "feat(portal): write-only vault page"`

---

### Task 9: Docs, release notes, spec amendment

**Files:**
- Create: `docs/site/_content/integrations/vault.md`
- Modify: `docs/site/nav.json` (Built in → after Files)
- Create: `docs/releases/v0.29.0.md`
- Modify: `docs/superpowers/specs/2026-09-16-user-vault-design.md` (Reaper section)
- Modify: `.env.example`? — no new config; skip.

- [ ] **Step 1: Write `docs/site/_content/integrations/vault.md`**

```markdown
---
title: Vault
description: Per-user encrypted secrets an agent can use but never read — referenced as {{vault:NAME}} inside any tool call, or handed to a script through a one-time URL.
---

`vault` is where a password lives when there is no OAuth for it.

Workbench already keeps OAuth tokens, cookie jars and API keys encrypted and injects them into requests without the model seeing them. That stops at the integration boundary. A login for a site with no API, an SSH passphrase, a token for a service no plugin knows about — before the vault, the only way to give those to an agent was to paste them into chat, where they land in the transcript, the model provider's logs, and every later turn.

Like `browser` and `files`, it is an internal plugin: `auth: { type: "none" }`, always connected, no setup.

## The rule

> **The agent can use a secret. It cannot read one.**

There is no `vault_get`. `vault_list` returns names and descriptions. The portal is write-only too: once saved, a value is never displayed again — to rotate, replace it.

## Adding a secret

Portal → **Vault** → **Add secret**. Names are lowercase letters, digits, `_ . -`, up to 64 characters. Values up to 8 KB. Stored AES-256-GCM under the server's `ENCRYPTION_KEY`, same as OAuth tokens.

## Using a secret inside a tool call

Write `{{vault:NAME}}` anywhere in another tool's arguments:

```json
{ "tool": "browser_type", "args": { "session_id": "…", "text": "{{vault:site_password}}" } }
{ "tool": "github_create_webhook", "args": { "secret": "{{vault:webhook_secret}}" } }
{ "tool": "curl", "args": { "headers": { "Authorization": "Bearer {{vault:api_token}}" } } }
```

The server resolves the reference after the arguments leave the model and before the tool's own validation runs, so the value gets the tool's normal coercion. It works for every tool — plugins, `browser_*`, `files_*`, the REST endpoint — because it happens in the one place all of them execute.

An unknown name fails the call with `VAULT_SECRET_NOT_FOUND` before the tool runs.

### What comes back is scrubbed

Any occurrence of a value the call substituted is replaced with its reference in the result and in any error message before the model sees it. So `browser_evaluate` returning an input's `.value` after you typed a password into it shows `{{vault:site_password}}`, not the password.

**The limit:** only values substituted *in that call* are scrubbed. If a page still displays the password and a *later* `browser_read_text` reads it, nothing is substituted in that later call and nothing is scrubbed. After a login, navigate away before reading the page. Values that come back encoded (base64, URL-escaped, split across DOM nodes) are not caught either. This is containment for the common case, not a guarantee.

## Handing a value to something outside workbench

When the value is needed by a script, an `.env` file, a CI job — anything that is not a workbench tool — the agent mints a one-time URL:

```json
{ "tool": "vault_presign", "args": { "name": "db_url" } }
→ { "url": "https://wb.example.com/api/vault/otl/9f3c…", "expires_at": "…" }
```

The agent then has the *host* fetch it, straight to where it is needed:

```bash
curl -fsS "$URL" -o ./.env.secret     # to a file
DB_URL=$(curl -fsS "$URL")            # to a variable
```

The URL works exactly once — the first `GET` spends it; a second returns 404 — and expires after `ttl_seconds` (default 120, max 600). If a fetch fails, mint another. The token is opaque, unauthenticated by design (it *is* the authorization), and the route is excluded from the request log.

The tool's description tells the agent not to fetch the URL itself and not to print the response. That is a behavioural guard rail, not a technical one: an agent that `curl`s the URL and echoes the output has put the value in its context. Pipe to a file.

## Tools

| Tool | Does |
|---|---|
| `vault_list` | Names, descriptions, timestamps, and each secret's `{{vault:…}}` reference. Never values. |
| `vault_presign` | One-time URL for a value. `{ name, ttl_seconds? }` → `{ url, expires_at }`. |

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/vault` | list (bearer) |
| `PUT` | `/api/vault/:name` | `{ value, description? }` → 201 created / 200 replaced (bearer) |
| `DELETE` | `/api/vault/:name` | 204; revokes outstanding one-time URLs (bearer) |
| `GET` | `/api/vault/otl/:token` | redeem once → `text/plain` body; 404 otherwise. No auth. |

## Threat model

The adversary is accidental exposure: the value ending up in the model's context, the session transcript, or a provider's request log. The agent is the user's own, working against the user's own vault, and is trusted to use any secret in any tool — there is no per-secret allowlist. A hostile or prompt-injected agent can still send a value somewhere via a tool that makes outbound requests. Scope what you put in the vault accordingly.
```

- [ ] **Step 2: `docs/site/nav.json`** — after the Files item in "Built in":

```json
            {
              "path": "integrations/vault",
              "label": "Vault",
              "layout": "wide"
            },
```

Run `node docs/site/build.mjs` — must exit 0 (checks internal links).

- [ ] **Step 3: `docs/releases/v0.29.0.md`**

```markdown
## v0.29.0 — User vault

_2026-09-16_

A per-user encrypted secrets store that the agent can **use but never read**.

Until now a password for a site with no OAuth, or a token for a service no plugin knows about, had one route into an agent: pasted into chat, where it stays in the transcript and every later prompt. The vault gives it a place to live and a way to be used without ever entering the model's context.

### New

- **Vault.** Portal → Vault. Add a named secret; it is stored AES-256-GCM under `ENCRYPTION_KEY`, same as OAuth tokens. Write-only from every surface — the list never carries a value, and there is no reveal. To rotate, replace.
- **`{{vault:NAME}}` in any tool call.** The reference is resolved in `executeSingle`, after the arguments leave the model and before the tool's zod schema runs, so it covers every plugin tool, `browser_*`, `files_*`, batch execution and the REST endpoint alike. Unknown name → `VAULT_SECRET_NOT_FOUND`, handler never runs.
- **Result scrubbing.** Any value substituted in a call is replaced with its reference in that call's result and error message before the model sees it. Only that call's values, best-effort against encodings — see the docs for the limits.
- **`vault_presign` one-time URLs.** For handing a value to a script or `.env` outside workbench: a `GET` that works exactly once (DELETE-arbitrated, atomic on both backends), 120 s default TTL, `text/plain` body, route silenced in the request log.
- **`vault_list`.** Names, descriptions, last-used, and each secret's reference.

### Schema

New table `user_vaults` on both dialects, created on boot. Added to the SQLite→PostgreSQL migration table list.

### Upgrade notes

None required. Additive table, no new configuration.

### Release candidate

Schema change → ships as `v0.29.0-rc.1` first.

```
docker pull ghcr.io/amarthaid/workbench:v0.29.0-rc.1
```

**Full diff:** https://github.com/amarthaid/workbench/compare/v0.28.0...v0.29.0
```

- [ ] **Step 4: Spec amendment.** In `docs/superpowers/specs/2026-09-16-user-vault-design.md` replace the "### Reaper" section body with:

```markdown
`reapExpiredOtl` runs on an in-process interval (`startVaultReaper`, started
from `index.ts` next to jots' `startUploadReaper`), not as a `npm run reap`
subcommand: the reap CLI must stay free of `../config` and `../db` so a
directory-sweeping CronJob never carries `ENCRYPTION_KEY`. These are database
rows, not a shared disk, so N pods sweeping concurrently is harmless. Every
read already filters on `expires_at`; the sweep is hygiene, not correctness.
```

- [ ] **Step 5: Commit** — `git commit -m "docs(vault): integration page, v0.29.0 notes, reaper amendment"`

---

### Task 10: Full verification

- [ ] `npm run typecheck:tests -w @a-workbench/server`
- [ ] `npm run test` from root — zero failures.
- [ ] `npm run build` from root.
- [ ] `node docs/site/build.mjs`.
- [ ] Manual smoke against dev server (`npm run dev`): add a secret in the portal; via MCP `execute_tools` call `files_write({name:"t.txt", content:"{{vault:NAME}}"})`, then `files_read` → content shows the *reference* only in the write result? No — `files_read` is a separate call with nothing substituted, so it returns the real value. That is the documented limit and the expected behaviour; the smoke here is: `files_write` result does not contain the value, the file on disk does. Then `vault_presign` + `curl` twice → 200 then 404.
- [ ] Bump nothing: version bump happens at release-prep, not in this PR.

---

## Self-review

- Spec coverage: storage (T1,T2), portal (T8), tools (T6), OTL (T3,T7), interpolation (T4,T5), scrub (T4,T5), audit/log (T5 scrubs error; T7 silences OTL route), reaper (T3, amended), docs/release (T9), tests per section (each task). Config: none. ✔
- Placeholders: none. The "categories" enum and `ui-field` class are verify-and-adjust notes with concrete fallbacks. ✔
- Type consistency: `readSecretValue/touchUsed/listSecrets/putSecret/deleteSecret/VaultError` (T2) used in T3–T7; `mintOtl/consumeOtl/revokeFor/_setNowForTest/OTL_*` (T3) used in T6, T7; `resolveVaultRefs/scrubVaultValues/scrubString/VaultRefError` (T4) used in T5; `VaultRefError.secretName` matched in T4 test. ✔
