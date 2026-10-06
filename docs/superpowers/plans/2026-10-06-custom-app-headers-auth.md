# Custom App Header Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user register a custom MCP app with static request headers (API key etc.) instead of OAuth.

**Architecture:** A nullable encrypted `headers_enc` column on `custom_apps` holds `[{name,value}]`; an app with headers is a "headers app", otherwise OAuth (unchanged). A single `resolveAuthHeaders(userId, app)` returns the header record for either mode; `client.ts` takes that record instead of a bearer token and keys its session cache on a fingerprint of it. Create/update verify with a live `tools/list` before persisting. Portal gets an auth toggle plus a shared header-row editor.

**Tech Stack:** TypeScript, Fastify, MCP TypeScript SDK, SQLite/PostgreSQL (`db` adapter), React + TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-custom-app-headers-auth-design.md`

## Global Constraints

- Header name: RFC 7230 token `^[!#$%&'*+.^_`|~0-9A-Za-z-]+$`, case-insensitively unique within an app.
- Header value: non-empty, no CR/LF/NUL, at most 4096 bytes. At most 10 headers per app.
- Deny-list (case-insensitive): `host`, `content-length`, `content-type`, `accept`, `mcp-session-id`, `x-workbench-via`, `connection`, `transfer-encoding`, `upgrade`, `keep-alive`, `te`, `trailer`, `proxy-authorization`, `proxy-connection`.
- Values are encrypted at rest (`encrypt()` from `auth/encryption`), never returned by any API, never logged, never in error text. APIs expose header **names only**.
- OAuth custom apps (no `headers_enc`) behave exactly as before; legacy rows need no backfill.
- SSRF (`normalizeBaseUrl`/`safeFetch`), loop-guard and `customAppsAllowedFor` apply to header apps unchanged.
- Public repo: test fixtures use synthetic values only (`X-Api-Key`, `tok-abc`, `example.com`). No company/internal names.
- Commits: no `Co-Authored-By` / "Generated with" trailers (the `.githooks/commit-msg` hook rejects them).
- Run server tests from `packages/server` (`npx vitest run <file>`), portal tests from `packages/portal`.

## Review Focus

- Legacy `custom_apps` row (no `headers_enc`, no `metadata.authType`) must still load and resolve as OAuth. Pinned in Task 1.
- A header value containing CR/LF (header injection) must be rejected at create and update. Pinned in Task 2.
- Upstream failure at create must persist nothing and must not leak any header value in the error. Pinned in Task 4.
- Update with a blank value for an existing name must keep the stored value; blank for a *new* name must 400. Pinned in Task 2/4.
- Rotating a key must replace the cached MCP session (old key must stop being sent). Pinned in Task 3.
- A headers app must show `connected: true` in `/api/connections` and `list_integrations`, and never be flagged "needs reconnect". Pinned in Task 5.

---

### Task 1: Storage — `headers_enc` column and store support

**Files:**
- Modify: `packages/server/src/db.ts` (SQLite ALTER list ~line 233-245; PostgreSQL ALTER block ~line 270-282)
- Modify: `packages/server/src/custom-apps/store.ts`
- Test: `packages/server/tests/custom-apps.test.ts`

**Interfaces:**
- Produces (`store.ts`):
  - `export interface CustomAppHeader { name: string; value: string }`
  - `CustomAppMetadata.authType?: "oauth" | "headers"`
  - `CustomApp.headers?: CustomAppHeader[]` (decrypted, memory only)
  - `export function isHeadersApp(app: CustomApp): boolean`
  - `createCustomApp` args gain `headers?: CustomAppHeader[]`
  - `export async function setCustomAppHeaders(userId: string, id: string, headers: CustomAppHeader[]): Promise<CustomApp | null>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/tests/custom-apps.test.ts` (add `isHeadersApp`, `setCustomAppHeaders` to the existing `../src/custom-apps/store` import):

```ts
describe("app store: header auth", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM custom_apps");
  });

  it("round-trips encrypted headers and flags the app as a headers app", async () => {
    const c = await createCustomApp({
      userId: "u1",
      name: "keyed",
      baseUrl: "https://mcp.example.com/mcp",
      metadata: { authType: "headers" },
      headers: [{ name: "X-Api-Key", value: "tok-abc" }],
    });
    expect(isHeadersApp(c)).toBe(true);
    expect(c.headers).toEqual([{ name: "X-Api-Key", value: "tok-abc" }]);

    // value is not stored in plaintext
    const raw = await db.get<{ headers_enc: Buffer }>("SELECT headers_enc FROM custom_apps WHERE id = ?", [c.id]);
    expect(Buffer.from(raw!.headers_enc).toString("utf8")).not.toContain("tok-abc");
  });

  it("loads a legacy row (no headers_enc, no authType) as an OAuth app", async () => {
    const c = await createCustomApp({
      userId: "u1",
      name: "legacy",
      baseUrl: "https://mcp.example.com/mcp",
      metadata: { tokenEndpoint: "https://mcp.example.com/token" },
      clientId: "cid",
      clientSecret: "csecret",
    });
    expect(isHeadersApp(c)).toBe(false);
    expect(c.headers).toBeUndefined();
  });

  it("replaces headers with setCustomAppHeaders and scopes by user", async () => {
    const c = await createCustomApp({
      userId: "u1",
      name: "keyed",
      baseUrl: "https://mcp.example.com/mcp",
      metadata: { authType: "headers" },
      headers: [{ name: "X-Api-Key", value: "tok-abc" }],
    });
    expect(await setCustomAppHeaders("u2", c.id, [{ name: "X-Api-Key", value: "evil" }])).toBeNull();
    const updated = await setCustomAppHeaders("u1", c.id, [{ name: "X-Api-Key", value: "tok-new" }]);
    expect(updated?.headers).toEqual([{ name: "X-Api-Key", value: "tok-new" }]);
  });

  it("degrades to no headers when the ciphertext is corrupt instead of throwing", async () => {
    const c = await createCustomApp({
      userId: "u1",
      name: "keyed",
      baseUrl: "https://mcp.example.com/mcp",
      metadata: { authType: "headers" },
      headers: [{ name: "X-Api-Key", value: "tok-abc" }],
    });
    await db.run("UPDATE custom_apps SET headers_enc = ? WHERE id = ?", [Buffer.from("garbage"), c.id]);
    const again = await getCustomApp("u1", c.id);
    expect(again).not.toBeNull();
    expect(again!.headers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/server && npx vitest run tests/custom-apps.test.ts`
Expected: FAIL (`isHeadersApp` / `headers` not defined, no `headers_enc` column).

- [ ] **Step 3: Add the column to both backends**

In `db.ts` SQLite list add, after `"ALTER TABLE users ADD COLUMN disabled_at INTEGER",`:

```ts
    "ALTER TABLE custom_apps ADD COLUMN headers_enc BLOB",
```

In the PostgreSQL ALTER block add, after `ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at INTEGER;`:

```sql
    ALTER TABLE custom_apps ADD COLUMN IF NOT EXISTS headers_enc BYTEA;
```

- [ ] **Step 4: Implement store support**

In `store.ts`:

```ts
export interface CustomAppHeader {
  name: string;
  value: string;
}
```

Add `authType?: "oauth" | "headers";` to `CustomAppMetadata` (doc: absent means oauth). Add `headers?: CustomAppHeader[];` to `CustomApp` with comment `/** Decrypted static headers — memory only, never serialized or logged. */`. Add `headers_enc: Buffer | null;` to `Row`.

In `toCustomApp`, before the return:

```ts
  let headers: CustomAppHeader[] | undefined;
  if (row.headers_enc) {
    try {
      const parsed = JSON.parse(decrypt(row.headers_enc)) as CustomAppHeader[];
      headers = Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupt/undecryptable headers degrade to "no headers" (the app
      // yields no tools) rather than throwing out of discovery.
      headers = [];
    }
  }
```

and include `headers,` in the returned object. Add:

```ts
export function isHeadersApp(app: CustomApp): boolean {
  return app.headers !== undefined;
}
```

Extend `createCustomApp` args with `headers?: CustomAppHeader[]`, add `headers_enc` to the INSERT (`... client_secret_enc, headers_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`) with value `args.headers ? encrypt(JSON.stringify(args.headers)) : null`. Add:

```ts
export async function setCustomAppHeaders(
  userId: string,
  id: string,
  headers: CustomAppHeader[]
): Promise<CustomApp | null> {
  await db.run(
    "UPDATE custom_apps SET headers_enc = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    [encrypt(JSON.stringify(headers)), Math.floor(Date.now() / 1000), id, userId]
  );
  return getCustomApp(userId, id);
}
```

Note `encrypt` returns a `Buffer` (it is used for `client_secret_enc` the same way); `decrypt` takes one.

- [ ] **Step 5: Run to verify pass**

Run: `cd packages/server && npx vitest run tests/custom-apps.test.ts tests/db-params.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/custom-apps/store.ts packages/server/tests/custom-apps.test.ts
git commit -m "feat(custom-apps): encrypted headers_enc column and store support"
```

---

### Task 2: Header validation and merge

**Files:**
- Create: `packages/server/src/custom-apps/headers.ts`
- Test: `packages/server/tests/custom-app-headers.test.ts`

**Interfaces:**
- Consumes: `CustomAppHeader` from `./store`.
- Produces:
  - `export const MAX_HEADERS = 10; export const MAX_HEADER_VALUE_BYTES = 4096;`
  - `export type HeaderInput = { name: string; value?: string }`
  - `export function validateHeaders(input: unknown, existing?: CustomAppHeader[]): { ok: true; headers: CustomAppHeader[] } | { ok: false; error: string }` — `existing` enables keep-on-blank (update); with no `existing`, a blank value is an error (create).
  - `export function headersToRecord(headers: CustomAppHeader[]): Record<string, string>`
  - `export function fingerprint(headers: Record<string, string>): string` (hex SHA-256 over sorted entries)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { validateHeaders, headersToRecord, fingerprint, MAX_HEADERS } from "../src/custom-apps/headers";

describe("validateHeaders", () => {
  it("accepts a well-formed header", () => {
    expect(validateHeaders([{ name: "X-Api-Key", value: "tok-abc" }])).toEqual({
      ok: true,
      headers: [{ name: "X-Api-Key", value: "tok-abc" }],
    });
  });

  it("rejects non-array, empty list, and too many headers", () => {
    expect(validateHeaders("x").ok).toBe(false);
    expect(validateHeaders([]).ok).toBe(false);
    const many = Array.from({ length: MAX_HEADERS + 1 }, (_, i) => ({ name: `X-H${i}`, value: "v" }));
    expect(validateHeaders(many).ok).toBe(false);
  });

  it("rejects invalid names", () => {
    for (const name of ["", "Bad Name", "X:Y", "X-Ä", "a\r\nb"]) {
      expect(validateHeaders([{ name, value: "v" }]).ok, name).toBe(false);
    }
  });

  it("rejects deny-listed names case-insensitively", () => {
    for (const name of ["Host", "content-length", "Content-Type", "ACCEPT", "Mcp-Session-Id", "x-workbench-via", "Transfer-Encoding"]) {
      expect(validateHeaders([{ name, value: "v" }]).ok, name).toBe(false);
    }
  });

  it("rejects header injection and oversized values", () => {
    expect(validateHeaders([{ name: "X-Api-Key", value: "a\r\nX-Evil: 1" }]).ok).toBe(false);
    expect(validateHeaders([{ name: "X-Api-Key", value: "a\nb" }]).ok).toBe(false);
    expect(validateHeaders([{ name: "X-Api-Key", value: "a\0b" }]).ok).toBe(false);
    expect(validateHeaders([{ name: "X-Api-Key", value: "x".repeat(4097) }]).ok).toBe(false);
  });

  it("rejects duplicate names case-insensitively", () => {
    expect(validateHeaders([{ name: "X-Api-Key", value: "a" }, { name: "x-api-key", value: "b" }]).ok).toBe(false);
  });

  it("requires a value on create", () => {
    expect(validateHeaders([{ name: "X-Api-Key", value: "" }]).ok).toBe(false);
    expect(validateHeaders([{ name: "X-Api-Key" }]).ok).toBe(false);
  });

  it("keeps the stored value on update when the value is blank, drops absent names", () => {
    const existing = [
      { name: "X-Api-Key", value: "tok-abc" },
      { name: "X-Tenant", value: "acme" },
    ];
    const r = validateHeaders([{ name: "x-api-key" }], existing);
    expect(r).toEqual({ ok: true, headers: [{ name: "X-Api-Key", value: "tok-abc" }] });
  });

  it("errors on update when a NEW name has no value", () => {
    const r = validateHeaders([{ name: "X-New" }], [{ name: "X-Api-Key", value: "tok-abc" }]);
    expect(r.ok).toBe(false);
  });

  it("never echoes a value in its error text", () => {
    const r = validateHeaders([{ name: "Host", value: "tok-secret-123" }]);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("tok-secret-123");
  });
});

describe("headersToRecord / fingerprint", () => {
  it("builds a record and fingerprints order-independently", () => {
    const a = headersToRecord([{ name: "X-A", value: "1" }, { name: "X-B", value: "2" }]);
    const b = headersToRecord([{ name: "X-B", value: "2" }, { name: "X-A", value: "1" }]);
    expect(a).toEqual({ "X-A": "1", "X-B": "2" });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a value changes and does not contain the plaintext", () => {
    const f1 = fingerprint({ "X-A": "tok-abc" });
    const f2 = fingerprint({ "X-A": "tok-new" });
    expect(f1).not.toBe(f2);
    expect(f1).not.toContain("tok-abc");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/server && npx vitest run tests/custom-app-headers.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `headers.ts`**

```ts
import { createHash } from "node:crypto";
import type { CustomAppHeader } from "./store";

export const MAX_HEADERS = 10;
export const MAX_HEADER_VALUE_BYTES = 4096;

export type HeaderInput = { name: string; value?: string };
type Result = { ok: true; headers: CustomAppHeader[] } | { ok: false; error: string };

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Headers workbench owns, or that would break the MCP transport.
const DENY = new Set([
  "host", "content-length", "content-type", "accept", "mcp-session-id", "x-workbench-via",
  "connection", "transfer-encoding", "upgrade", "keep-alive", "te", "trailer",
  "proxy-authorization", "proxy-connection",
]);

// Errors name the header, never the value.
export function validateHeaders(input: unknown, existing?: CustomAppHeader[]): Result {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "headers must be a non-empty list" };
  }
  if (input.length > MAX_HEADERS) {
    return { ok: false, error: `at most ${MAX_HEADERS} headers are allowed` };
  }
  const kept = new Map((existing ?? []).map((h) => [h.name.toLowerCase(), h]));
  const seen = new Set<string>();
  const out: CustomAppHeader[] = [];
  for (const raw of input as HeaderInput[]) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name || !TOKEN.test(name)) return { ok: false, error: `invalid header name "${name.slice(0, 64)}"` };
    const lower = name.toLowerCase();
    if (DENY.has(lower)) return { ok: false, error: `header "${name}" is not allowed` };
    if (seen.has(lower)) return { ok: false, error: `duplicate header "${name}"` };
    seen.add(lower);

    let value = typeof raw.value === "string" ? raw.value : "";
    if (value === "") {
      const prior = kept.get(lower);
      if (!prior) return { ok: false, error: `header "${name}" needs a value` };
      out.push({ name: prior.name, value: prior.value });
      continue;
    }
    if (/[\r\n\0]/.test(value)) return { ok: false, error: `header "${name}" has an invalid value` };
    if (Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_BYTES) {
      return { ok: false, error: `header "${name}" value is too long` };
    }
    out.push({ name, value });
  }
  return { ok: true, headers: out };
}

export function headersToRecord(headers: CustomAppHeader[]): Record<string, string> {
  return Object.fromEntries(headers.map((h) => [h.name, h.value]));
}

/** Stable digest used as a session-cache key — the plaintext never leaves memory. */
export function fingerprint(headers: Record<string, string>): string {
  const h = createHash("sha256");
  for (const k of Object.keys(headers).sort()) h.update(`${k.toLowerCase()}\0${headers[k]}\0`);
  return h.digest("hex");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/server && npx vitest run tests/custom-app-headers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/custom-apps/headers.ts packages/server/tests/custom-app-headers.test.ts
git commit -m "feat(custom-apps): header validation, merge and fingerprint"
```

---

### Task 3: Auth resolution and client takes a header record

**Files:**
- Create: `packages/server/src/custom-apps/auth.ts`
- Modify: `packages/server/src/custom-apps/client.ts`
- Modify: `packages/server/src/custom-apps/index.ts:2,82-83`
- Modify: `packages/server/src/mcp/meta-tools.ts:10,583-600,634,~676`
- Test: `packages/server/tests/custom-app-auth.test.ts`

**Interfaces:**
- Consumes: `isHeadersApp`, `CustomApp` (Task 1); `headersToRecord`, `fingerprint` (Task 2); `ensureCustomAppToken` (existing, `oauth.ts`).
- Produces:
  - `auth.ts`: `export async function resolveAuthHeaders(userId: string, app: CustomApp): Promise<Record<string, string>>`; `export function upstreamAuthHint(app: CustomApp, e: unknown): string | null`
  - `client.ts`: `discoverTools(userId, baseUrl, headers: Record<string,string>)`, `callRemoteTool(userId, baseUrl, headers, remoteName, args)` (the `token: string` parameter becomes `headers`).

- [ ] **Step 1: Write the failing tests**

`tests/custom-app-auth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    SERVER_PUBLIC_URL: "https://wb.example.com",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
    ENCRYPTION_KEY: "0".repeat(64),
    PORT: "3000",
  },
}));

const connects: Array<{ headers: Record<string, string>; kind: string }> = [];
const closes: string[] = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    closed = false;
    async connect(t: { headers: Record<string, string>; kind: string }) { connects.push({ headers: t.headers, kind: t.kind }); }
    async close() { closes.push("closed"); }
    async listTools() { return { tools: [{ name: "ping", inputSchema: {} }] }; }
    async callTool() { return { content: [{ type: "text", text: "ok" }] }; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPError: class extends Error { constructor(public code: number, m: string) { super(m); } },
  StreamableHTTPClientTransport: class {
    kind = "streamable";
    headers: Record<string, string>;
    constructor(_u: URL, o: { requestInit: { headers: Record<string, string> } }) { this.headers = o.requestInit.headers; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    kind = "sse";
    headers: Record<string, string>;
    constructor(_u: URL, o: { requestInit: { headers: Record<string, string> } }) { this.headers = o.requestInit.headers; }
  },
}));

import { discoverTools, evictSession } from "../src/custom-apps/client";
import { resolveAuthHeaders, upstreamAuthHint } from "../src/custom-apps/auth";
import type { CustomApp } from "../src/custom-apps/store";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = { id: "a1", userId: "u1", name: "k", baseUrl: "https://mcp.example.com/mcp", metadata: {}, createdAt: 0, updatedAt: 0 };

beforeEach(async () => {
  evictSession("u1", "https://mcp.example.com/mcp");
  await Promise.resolve(); // let the evicted client's async close() settle before counting
  connects.length = 0;
  closes.length = 0;
});

describe("resolveAuthHeaders", () => {
  it("returns the static headers for a headers app, with no OAuth lookup", async () => {
    const app: CustomApp = { ...base, metadata: { authType: "headers" }, headers: [{ name: "X-Api-Key", value: "tok-abc" }] };
    expect(await resolveAuthHeaders("u1", app)).toEqual({ "X-Api-Key": "tok-abc" });
  });

  it("an empty (corrupt) header set yields an error, not an unauthenticated call", async () => {
    const app: CustomApp = { ...base, metadata: { authType: "headers" }, headers: [] };
    await expect(resolveAuthHeaders("u1", app)).rejects.toThrow(/headers/i);
  });
});

describe("client session cache keyed by header fingerprint", () => {
  const url = "https://mcp.example.com/mcp";

  it("sends the given headers and reuses the session for identical headers", async () => {
    await discoverTools("u1", url, { "X-Api-Key": "tok-abc" });
    await discoverTools("u1", url, { "X-Api-Key": "tok-abc" });
    expect(connects).toHaveLength(1);
    expect(connects[0].headers).toEqual({ "X-Api-Key": "tok-abc" });
  });

  it("closes the old session and stops sending the old key when headers change", async () => {
    await discoverTools("u1", url, { "X-Api-Key": "tok-abc" });
    await discoverTools("u1", url, { "X-Api-Key": "tok-new" });
    expect(connects).toHaveLength(2);
    expect(closes).toHaveLength(1);
    expect(connects[1].headers).toEqual({ "X-Api-Key": "tok-new" });
  });
});

describe("upstreamAuthHint", () => {
  const headersApp: CustomApp = { ...base, metadata: { authType: "headers" }, headers: [{ name: "X-Api-Key", value: "tok-abc" }] };
  it("maps 401/403 on a headers app to a check-your-headers hint without any value", () => {
    const hint = upstreamAuthHint(headersApp, new StreamableHTTPError(401, "boom tok-abc"));
    expect(hint).toMatch(/check the app's headers/i);
    expect(hint).not.toContain("tok-abc");
  });
  it("returns null for other errors and for OAuth apps", () => {
    expect(upstreamAuthHint(headersApp, new Error("x"))).toBeNull();
    expect(upstreamAuthHint(base as CustomApp, new StreamableHTTPError(401, "x"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/server && npx vitest run tests/custom-app-auth.test.ts`
Expected: FAIL (`auth.ts` missing; `discoverTools` still takes a token string).

- [ ] **Step 3: Create `auth.ts`**

```ts
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isHeadersApp, type CustomApp } from "./store";
import { headersToRecord } from "./headers";
import { ensureCustomAppToken } from "./oauth";

/** Request headers that authenticate workbench to the app's server. */
export async function resolveAuthHeaders(userId: string, app: CustomApp): Promise<Record<string, string>> {
  if (isHeadersApp(app)) {
    // Empty means corrupt/undecryptable (see store.toCustomApp) — fail loudly
    // rather than call the server unauthenticated.
    if (!app.headers || app.headers.length === 0) throw new Error("App headers are missing or unreadable — re-enter them");
    return headersToRecord(app.headers);
  }
  return { Authorization: `Bearer ${await ensureCustomAppToken(userId, app)}` };
}

/** A user-facing hint for an upstream 401/403 on a headers app; null otherwise. */
export function upstreamAuthHint(app: CustomApp, e: unknown): string | null {
  if (!isHeadersApp(app)) return null;
  const code = (e as { code?: unknown } | null)?.code;
  if (e instanceof StreamableHTTPError || typeof code === "number") {
    if (code === 401 || code === 403) {
      return `Server rejected the app's headers (HTTP ${code}) — check the app's headers`;
    }
  }
  return null;
}
```

- [ ] **Step 4: Change `client.ts` to take a header record**

Replace `authHeaders`, the cache type, and signatures:

```ts
import { fingerprint } from "./headers";

const sessions = new Map<string, { client: Client; fp: string }>();

async function getSession(userId: string, baseUrl: string, headers: Record<string, string>): Promise<Client> {
  const key = `${userId}::${baseUrl}`;
  const fp = fingerprint(headers);
  const existing = sessions.get(key);
  if (existing && existing.fp === fp) return existing.client;
  if (existing) await existing.client.close().catch(() => undefined);
  // ... unchanged body, but `requestInit: { headers }` in BOTH transports
  // (streamable and the SSE fallback), and `sessions.set(key, { client, fp })`
  // / `sessions.set(key, { client: sse, fp })`.
}
```

Delete the `authHeaders(token)` helper. Change `discoverTools(userId, baseUrl, headers)` and `callRemoteTool(userId, baseUrl, headers, remoteName, args)` to pass `headers` to `getSession`. Update the comment above `sessions` (“a token change” → “a header change”).

- [ ] **Step 5: Update callers**

`index.ts`: replace `import { ensureCustomAppToken } from "./oauth";` with `import { resolveAuthHeaders } from "./auth";` and

```ts
        const headers = await resolveAuthHeaders(userId, c);
        const remote = await discoverTools(userId, c.baseUrl, headers);
```

`meta-tools.ts`: replace the `ensureCustomAppToken` import with `import { resolveAuthHeaders, upstreamAuthHint } from "../custom-apps/auth";`; rename `let accessToken: string;` → `let authHeaders: Record<string, string>;` with `authHeaders = await resolveAuthHeaders(userId, app);`; pass `authHeaders` to `callRemoteTool`. In the final `catch (e)` (the one that builds `const err = scrubString(...)`), compute the message as:

```ts
        const err = scrubString(
          upstreamAuthHint(app, e) ?? (e instanceof Error ? e.message : String(e)),
          scrubEntries,
          substringOk
        );
```

- [ ] **Step 6: Run to verify pass, then the wider custom-app suite and typecheck**

Run: `cd packages/server && npx vitest run tests/custom-app-auth.test.ts tests/custom-apps.test.ts tests/custom-app-loop-guard.test.ts tests/custom-apps-policy.test.ts && npx tsc --noEmit -p .`
Expected: PASS, no type errors (`tests/` is type-checked; see the Postgres-dialect finding).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/custom-apps packages/server/src/mcp/meta-tools.ts packages/server/tests/custom-app-auth.test.ts
git commit -m "feat(custom-apps): resolve auth as a header record, key sessions on its fingerprint"
```

---

### Task 4: Create / update service and routes

**Files:**
- Create: `packages/server/src/custom-apps/headers-app.ts`
- Modify: `packages/server/src/api/routes.ts` (`POST /api/custom-apps` ~line 897; new `PUT /api/custom-apps/:id` after the DELETE route ~line 949)
- Test: `packages/server/tests/custom-app-headers-app.test.ts`

**Interfaces:**
- Consumes: `validateHeaders` (Task 2); `createCustomApp`, `setCustomAppHeaders`, `getCustomApp`, `getCustomAppByName`, `isHeadersApp` (Task 1); `discoverTools`, `evictSession` (client); `normalizeBaseUrl`, `isOwnResource` (`loop-guard`).
- Produces (`headers-app.ts`):
  - `export type Verify = (userId: string, baseUrl: string, headers: Record<string, string>) => Promise<void>` (default = `discoverTools(...)` discarding the result; throws on failure)
  - `export class HeadersAppError extends Error { status: number }`
  - `export async function createHeadersApp(args: { userId: string; name: string; baseUrl: string; headers: unknown }, verify?: Verify): Promise<CustomApp>`
  - `export async function updateHeadersApp(args: { userId: string; id: string; headers: unknown }, verify?: Verify): Promise<CustomApp>`
  - `export function verifyFailureMessage(e: unknown): string` — status-only text, never `e.message`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    SERVER_PUBLIC_URL: "https://wb.example.com",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
    ENCRYPTION_KEY: "0".repeat(64),
    PORT: "3000",
  },
}));

import { db } from "../src/db";
import { listCustomApps } from "../src/custom-apps/store";
import { createHeadersApp, updateHeadersApp, HeadersAppError, verifyFailureMessage } from "../src/custom-apps/headers-app";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ok = vi.fn(async () => undefined);
beforeEach(async () => { await db.run("DELETE FROM custom_apps"); ok.mockClear(); });

const args = { userId: "u1", name: "keyed", baseUrl: "https://mcp.example.com/mcp/", headers: [{ name: "X-Api-Key", value: "tok-abc" }] };

describe("createHeadersApp", () => {
  it("verifies with the supplied headers, then persists as a headers app", async () => {
    const app = await createHeadersApp(args, ok);
    expect(ok).toHaveBeenCalledWith("u1", "https://mcp.example.com/mcp", { "X-Api-Key": "tok-abc" });
    expect(app.metadata.authType).toBe("headers");
    expect(app.baseUrl).toBe("https://mcp.example.com/mcp");
    expect(app.headers).toEqual([{ name: "X-Api-Key", value: "tok-abc" }]);
  });

  it("persists nothing and leaks no value when verification fails", async () => {
    const bad = vi.fn(async () => { throw new StreamableHTTPError(401, "denied tok-abc"); });
    const err = await createHeadersApp(args, bad).catch((e) => e);
    expect(err).toBeInstanceOf(HeadersAppError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("tok-abc");
    expect(await listCustomApps("u1")).toHaveLength(0);
  });

  it("rejects invalid headers before any network call", async () => {
    const err = await createHeadersApp({ ...args, headers: [{ name: "Host", value: "x" }] }, ok).catch((e) => e);
    expect(err.status).toBe(400);
    expect(ok).not.toHaveBeenCalled();
  });

  it("rejects blocked URLs, own /mcp, and duplicate names", async () => {
    expect((await createHeadersApp({ ...args, baseUrl: "http://10.0.0.5/mcp" }, ok).catch((e) => e)).status).toBe(400);
    expect((await createHeadersApp({ ...args, baseUrl: "https://wb.example.com/mcp" }, ok).catch((e) => e)).status).toBe(400);
    await createHeadersApp(args, ok);
    expect((await createHeadersApp(args, ok).catch((e) => e)).status).toBe(409);
  });
});

describe("updateHeadersApp", () => {
  it("keeps a blank value, re-verifies, and saves", async () => {
    const app = await createHeadersApp(args, ok);
    ok.mockClear();
    const updated = await updateHeadersApp({ userId: "u1", id: app.id, headers: [{ name: "x-api-key" }, { name: "X-Tenant", value: "acme" }] }, ok);
    expect(updated.headers).toEqual([{ name: "X-Api-Key", value: "tok-abc" }, { name: "X-Tenant", value: "acme" }]);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("does not save when re-verification fails", async () => {
    const app = await createHeadersApp(args, ok);
    const bad = vi.fn(async () => { throw new Error("nope"); });
    await expect(updateHeadersApp({ userId: "u1", id: app.id, headers: [{ name: "X-Api-Key", value: "tok-new" }] }, bad)).rejects.toBeInstanceOf(HeadersAppError);
    expect((await listCustomApps("u1"))[0].headers).toEqual([{ name: "X-Api-Key", value: "tok-abc" }]);
  });

  it("404s for another user's app and 400s for an OAuth app", async () => {
    const app = await createHeadersApp(args, ok);
    expect((await updateHeadersApp({ userId: "u2", id: app.id, headers: [{ name: "X-A", value: "v" }] }, ok).catch((e) => e)).status).toBe(404);
    const { createCustomApp } = await import("../src/custom-apps/store");
    const oauth = await createCustomApp({ userId: "u1", name: "oa", baseUrl: "https://o.example.com/mcp", metadata: {}, clientId: "c" });
    expect((await updateHeadersApp({ userId: "u1", id: oauth.id, headers: [{ name: "X-A", value: "v" }] }, ok).catch((e) => e)).status).toBe(400);
  });
});

describe("verifyFailureMessage", () => {
  it("is status-only for HTTP errors and generic otherwise", () => {
    expect(verifyFailureMessage(new StreamableHTTPError(403, "secret"))).toBe("Server rejected the headers (HTTP 403)");
    expect(verifyFailureMessage(new Error("secret tok-abc"))).toBe("Could not connect to the server with these headers");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/server && npx vitest run tests/custom-app-headers-app.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `headers-app.ts`**

```ts
import { randomUUID } from "node:crypto";
import { normalizeBaseUrl } from "./ssrf";
import { isOwnResource } from "./loop-guard";
import { discoverTools, evictSession } from "./client";
import { validateHeaders, headersToRecord } from "./headers";
import {
  createCustomApp, deleteCustomApp, getCustomApp, getCustomAppByName, isHeadersApp,
  setCustomAppHeaders, type CustomApp,
} from "./store";

export class HeadersAppError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type Verify = (userId: string, baseUrl: string, headers: Record<string, string>) => Promise<void>;

const defaultVerify: Verify = async (userId, baseUrl, headers) => {
  await discoverTools(userId, baseUrl, headers);
};

/** Status-only: upstream error text can echo request details, so never forward it. */
export function verifyFailureMessage(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "number" && code >= 400 && code < 600) return `Server rejected the headers (HTTP ${code})`;
  return "Could not connect to the server with these headers";
}

export async function createHeadersApp(
  args: { userId: string; name: string; baseUrl: string; headers: unknown },
  verify: Verify = defaultVerify
): Promise<CustomApp> {
  const name = args.name.trim();
  if (!name || !args.baseUrl.trim()) throw new HeadersAppError(400, "name and baseUrl are required");
  if (name.length > 64) throw new HeadersAppError(400, "name too long");
  if (await getCustomAppByName(args.userId, name)) throw new HeadersAppError(409, `An app named "${name}" already exists`);

  const baseUrl = normalizeBaseUrl(args.baseUrl.trim());
  if (!baseUrl) throw new HeadersAppError(400, `Invalid or blocked URL: ${args.baseUrl.trim().slice(0, 200)}`);
  if (isOwnResource(baseUrl)) throw new HeadersAppError(400, "This URL points back at this workbench");

  const v = validateHeaders(args.headers);
  if (!v.ok) throw new HeadersAppError(400, v.error);

  try {
    await verify(args.userId, baseUrl, headersToRecord(v.headers));
  } catch (e) {
    evictSession(args.userId, baseUrl);
    throw new HeadersAppError(400, verifyFailureMessage(e));
  }
  return createCustomApp({
    id: randomUUID(), userId: args.userId, name, baseUrl,
    metadata: { authType: "headers" }, headers: v.headers,
  });
}

export async function updateHeadersApp(
  args: { userId: string; id: string; headers: unknown },
  verify: Verify = defaultVerify
): Promise<CustomApp> {
  const app = await getCustomApp(args.userId, args.id);
  if (!app) throw new HeadersAppError(404, "Custom app not found");
  if (!isHeadersApp(app)) throw new HeadersAppError(400, "This app uses OAuth, not headers");

  const v = validateHeaders(args.headers, app.headers);
  if (!v.ok) throw new HeadersAppError(400, v.error);
  try {
    await verify(args.userId, app.baseUrl, headersToRecord(v.headers));
  } catch (e) {
    throw new HeadersAppError(400, verifyFailureMessage(e));
  }
  const saved = await setCustomAppHeaders(args.userId, args.id, v.headers);
  return saved!;
}
```

(`deleteCustomApp` import is unused — drop it from the import list.)

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/server && npx vitest run tests/custom-app-headers-app.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the routes**

In `routes.ts` import `createHeadersApp, updateHeadersApp, HeadersAppError` from `../custom-apps/headers-app` and `isHeadersApp` from `../custom-apps/store` (extend the existing import block at lines 26-36).

Change the POST body type to `{ name?: string; baseUrl?: string; authType?: "oauth" | "headers"; headers?: unknown }`. After the `customAppsAllowedFor` check and before the OAuth `name`/`baseUrl` handling, add:

```ts
    if (request.body?.authType === "headers") {
      try {
        const created = await createHeadersApp({
          userId: user.userId,
          name: request.body.name ?? "",
          baseUrl: request.body.baseUrl ?? "",
          headers: request.body.headers,
        });
        invalidateIndex(user.userId);
        return {
          app: {
            id: created.id, name: created.name, baseUrl: created.baseUrl,
            integration: integrationKey(created.id), authType: "headers" as const,
            headerNames: (created.headers ?? []).map((h) => h.name),
          },
        };
      } catch (err) {
        if (err instanceof HeadersAppError) return reply.status(err.status).send({ error: err.message });
        throw err;
      }
    }
```

Add the update route after the DELETE route:

```ts
  app.put<{ Params: { id: string }; Body: { headers?: unknown } }>("/api/custom-apps/:id", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const updated = await updateHeadersApp({ userId: user.userId, id: request.params.id, headers: request.body?.headers });
      invalidateIndex(user.userId);
      return { app: { id: updated.id, name: updated.name, headerNames: (updated.headers ?? []).map((h) => h.name) } };
    } catch (err) {
      if (err instanceof HeadersAppError) return reply.status(err.status).send({ error: err.message });
      throw err;
    }
  });
```

(Update has no `customAppsAllowedFor` gate because it only edits an app the user already owns; creation is what the policy gates. If you prefer to gate it too, add the same 403 check as POST.)

- [ ] **Step 6: Typecheck and commit**

Run: `cd packages/server && npx tsc --noEmit -p . && npx vitest run tests/custom-app-headers-app.test.ts tests/custom-apps.test.ts`
Expected: PASS.

```bash
git add packages/server/src/custom-apps/headers-app.ts packages/server/src/api/routes.ts packages/server/tests/custom-app-headers-app.test.ts
git commit -m "feat(custom-apps): create and update header apps with live verification"
```

---

### Task 5: Connected state and integration listing for header apps

**Files:**
- Modify: `packages/server/src/custom-apps/store.ts` (add helper)
- Modify: `packages/server/src/api/routes.ts` (`/api/integrations` custom entries ~line 326; `/api/connections` ~line 849-854)
- Modify: `packages/server/src/mcp/meta-tools.ts` (`list_integrations` ~line 831-839)
- Test: `packages/server/tests/custom-apps.test.ts`

**Interfaces:**
- Consumes: `isHeadersApp` (Task 1), `getToken` (existing).
- Produces: `export async function isCustomAppConnected(userId: string, app: CustomApp): Promise<boolean>` in `store.ts` (headers app → `true`; OAuth → `!!(await getToken(userId, integrationKey(app.id)))`). `IntegrationSummary` for a custom headers app gets `authType: "apikey"` and `headerNames: string[]`.

- [ ] **Step 1: Write the failing test** (append to `tests/custom-apps.test.ts`; import `isCustomAppConnected`)

```ts
describe("isCustomAppConnected", () => {
  beforeEach(async () => { await db.run("DELETE FROM custom_apps"); });

  it("treats a headers app as connected without any connections row", async () => {
    const c = await createCustomApp({
      userId: "u1", name: "keyed", baseUrl: "https://mcp.example.com/mcp",
      metadata: { authType: "headers" }, headers: [{ name: "X-Api-Key", value: "tok-abc" }],
    });
    expect(await isCustomAppConnected("u1", c)).toBe(true);
  });

  it("an OAuth app is connected only when a token row exists", async () => {
    const c = await createCustomApp({ userId: "u1", name: "oa", baseUrl: "https://o.example.com/mcp", metadata: {}, clientId: "c" });
    expect(await isCustomAppConnected("u1", c)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/server && npx vitest run tests/custom-apps.test.ts`
Expected: FAIL (`isCustomAppConnected` not exported).

- [ ] **Step 3: Implement and use the helper**

`store.ts`: `import { getToken } from "../auth/tokens";` and

```ts
/** Headers apps hold their credential on the row itself, so they are always "connected". */
export async function isCustomAppConnected(userId: string, app: CustomApp): Promise<boolean> {
  if (isHeadersApp(app)) return true;
  return !!(await getToken(userId, integrationKey(app.id)));
}
```

`routes.ts` `/api/connections`: replace `connected: !!(await getToken(user.userId, integrationKey(c.id))),` with `connected: await isCustomAppConnected(user.userId, c),`. `meta-tools.ts` `list_integrations`: same replacement with `ctx.userId`. Import `isCustomAppConnected` in both.

`routes.ts` `/api/integrations` custom entries: replace `authType: "oauth2" as const,` with

```ts
          authType: isHeadersApp(c) ? ("apikey" as const) : ("oauth2" as const),
          headerNames: isHeadersApp(c) ? (c.headers ?? []).map((h) => h.name) : undefined,
```

Also change `description` to `Custom MCP server at ${c.baseUrl}` (unchanged) — no edit needed.

Admin "needs reconnect" is derived from `connections` rows (`admin/connections.ts`), and header apps have none, so they are never flagged; no change there.

- [ ] **Step 4: Run to verify pass, typecheck**

Run: `cd packages/server && npx vitest run tests/custom-apps.test.ts tests/admin-overview.test.ts tests/connections.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(custom-apps): headers apps report connected and expose header names"
```

---

### Task 6: Portal — auth toggle and header editor

**Files:**
- Create: `packages/portal/src/components/CustomAppHeadersEditor.tsx`
- Modify: `packages/portal/src/api.ts` (`createCustomApp` ~line 151; add `updateCustomAppHeaders`; `IntegrationSummary` ~line 95)
- Modify: `packages/portal/src/pages/Apps.tsx` (state ~33-40; `submitNewApp` ~42-74; modal ~190-230)
- Modify: `packages/portal/src/pages/AppDetail.tsx` (custom block ~line 102)
- Test: `packages/portal/src/pages/Apps.test.tsx`

**Interfaces:**
- Consumes: server `POST /api/custom-apps` (`authType`, `headers`), `PUT /api/custom-apps/:id` (Task 4); `IntegrationSummary.headerNames` (Task 5).
- Produces:
  - `api.ts`: `export interface HeaderRow { name: string; value: string }`; `createCustomApp(name, baseUrl, headers?: HeaderRow[])` (when `headers` is given sends `authType: "headers"`; with two args the request body is unchanged); `updateCustomAppHeaders(id: string, headers: { name: string; value?: string }[])`.
  - `CustomAppHeadersEditor` props: `{ rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void; disabled?: boolean; valueOptional?: boolean }` (`valueOptional` → placeholder “unchanged” and no required marker, for edit).

- [ ] **Step 1: Write the failing tests** (append to `Apps.test.tsx`, following the existing mock setup at its top; add `updateCustomAppHeaders` to its `vi.mock("../api")` factory if the mock enumerates exports)

```tsx
  it("registers a headers app without starting OAuth", async () => {
    vi.mocked(createCustomApp).mockResolvedValue({
      app: { id: "a2", name: "Keyed", baseUrl: "https://mcp.example.com/mcp", integration: "custom:a2" },
    });
    renderApps();
    fireEvent.click(await screen.findByRole("button", { name: "New custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keyed" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("radio", { name: "Headers" }));
    fireEvent.change(screen.getByLabelText("Header name 1"), { target: { value: "X-Api-Key" } });
    fireEvent.change(screen.getByLabelText("Header value 1"), { target: { value: "tok-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));

    await waitFor(() =>
      expect(createCustomApp).toHaveBeenCalledWith("Keyed", "https://mcp.example.com/mcp", [
        { name: "X-Api-Key", value: "tok-abc" },
      ])
    );
    expect(startIntegrationAuth).not.toHaveBeenCalled();
  });

  it("masks header values and shows the server's verify error inline", async () => {
    vi.mocked(createCustomApp).mockRejectedValue(new Error("Server rejected the headers (HTTP 401)"));
    renderApps();
    fireEvent.click(await screen.findByRole("button", { name: "New custom app" }));
    fireEvent.click(screen.getByRole("radio", { name: "Headers" }));
    expect(screen.getByLabelText("Header value 1")).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keyed" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.change(screen.getByLabelText("Header name 1"), { target: { value: "X-Api-Key" } });
    fireEvent.change(screen.getByLabelText("Header value 1"), { target: { value: "tok-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    expect(await screen.findByText("Server rejected the headers (HTTP 401)")).toBeInTheDocument();
  });
```

Keep the existing OAuth test unchanged: it asserts `createCustomApp` is called with exactly `("Tracker", url)` — the OAuth path must still call it with two arguments.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/portal && npx vitest run src/pages/Apps.test.tsx`
Expected: FAIL (no “Headers” radio).

- [ ] **Step 3: API client**

In `api.ts`:

```ts
export interface HeaderRow { name: string; value: string }

export async function createCustomApp(
  name: string,
  baseUrl: string,
  headers?: HeaderRow[]
): Promise<{ app: { id: string; name: string; baseUrl: string; integration: string } }> {
  const res = await fetch(`${API_URL}/api/custom-apps`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(headers ? { name, baseUrl, authType: "headers", headers } : { name, baseUrl }),
  });
  // ... existing error handling unchanged
}

export async function updateCustomAppHeaders(
  id: string,
  headers: { name: string; value?: string }[]
): Promise<{ app: { id: string; name: string; headerNames: string[] } }> {
  const res = await fetch(`${API_URL}/api/custom-apps/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: getHeaders(),
    body: JSON.stringify({ headers }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || "Failed to update headers");
  }
  return res.json();
}
```

Add `headerNames?: string[];` to `IntegrationSummary`.

- [ ] **Step 4: Editor component**

`CustomAppHeadersEditor.tsx` (match the `Input`/`Button` imports used in `Apps.tsx`):

```tsx
import { Button, Input } from "../ui"; // use the same import path Apps.tsx uses for Button/Input
import type { HeaderRow } from "../api";

const MAX_ROWS = 10;

export function CustomAppHeadersEditor({
  rows, onChange, disabled, valueOptional,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  disabled?: boolean;
  valueOptional?: boolean;
}) {
  const set = (i: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div className="wb-section-gap">
      {rows.map((r, i) => (
        <div className="ui-field" key={i} style={{ display: "flex", gap: 8 }}>
          <Input aria-label={`Header name ${i + 1}`} placeholder="X-Api-Key" value={r.name}
            onChange={(e) => set(i, { name: e.target.value })} disabled={disabled} />
          <Input aria-label={`Header value ${i + 1}`} type="password" autoComplete="off"
            placeholder={valueOptional ? "unchanged" : "value"} value={r.value}
            onChange={(e) => set(i, { value: e.target.value })} disabled={disabled} />
          <Button variant="outline" type="button" aria-label={`Remove header ${i + 1}`} disabled={disabled || rows.length === 1}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>×</Button>
        </div>
      ))}
      {rows.length < MAX_ROWS && (
        <Button variant="outline" type="button" disabled={disabled}
          onClick={() => onChange([...rows, { name: "", value: "" }])}>Add header</Button>
      )}
    </div>
  );
}
```

Before writing, open `Apps.tsx` and copy the exact import lines for `Button`/`Input` so the paths are correct.

- [ ] **Step 5: Wire `Apps.tsx`**

Add state: `const [newAuth, setNewAuth] = useState<"oauth" | "headers">("oauth"); const [newHeaders, setNewHeaders] = useState<HeaderRow[]>([{ name: "", value: "" }]);`.

In `submitNewApp`, after the `createCustomApp` try/catch decide the path:

```ts
    const useHeaders = newAuth === "headers";
    try {
      ({ app } = useHeaders
        ? await createCustomApp(newName.trim(), newUrl.trim(), newHeaders.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value })))
        : await createCustomApp(newName.trim(), newUrl.trim()));
    } catch (err) { /* existing */ }
    qc.invalidateQueries({ queryKey: ["integrations"] });
    qc.invalidateQueries({ queryKey: ["connections"] });
    if (useHeaders) {
      // Verified server-side and already connected: no OAuth hand-off.
      setNewName(""); setNewUrl(""); setNewHeaders([{ name: "", value: "" }]); setNewAuth("oauth");
      setShowNewApp(false); setNewPhase("idle");
      return;
    }
```

Modal: add a two-option radio group (`role="radio"` with accessible names “OAuth” and “Headers”; use the project's existing radio/segmented control if there is one, else native `<input type="radio">` with `<label>`), render `<CustomAppHeadersEditor rows={newHeaders} onChange={setNewHeaders} disabled={newBusy} />` when `newAuth === "headers"`, disable the submit button unless at least one row has a name and value, and set the submit label to `"Add app"` for headers mode (`"Connect"` stays for OAuth; `registering` text becomes `"Verifying…"` in headers mode).

- [ ] **Step 6: AppDetail header editing**

Open `AppDetail.tsx` and read the `data.custom` block near line 102. Add, inside it and only when `data.authType === "apikey"`, a card with `CustomAppHeadersEditor` initialised from `data.headerNames` (`rows = data.headerNames.map((name) => ({ name, value: "" }))`), `valueOptional`, and a Save button that calls `updateCustomAppHeaders(id, rows.filter((r) => r.name.trim()))`, invalidates the `["integrations"]` query, and shows the error text inline on failure. `id` is `data.name.replace(/^custom:/, "")` (same derivation the delete handler at line 44 uses). Add a short test in a new `AppDetail.headers.test.tsx` only if `AppDetail` already has a test harness; otherwise rely on the Apps tests plus manual verification in Task 7.

- [ ] **Step 7: Run to verify pass, typecheck**

Run: `cd packages/portal && npx vitest run src/pages/Apps.test.tsx && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/portal
git commit -m "feat(portal): header auth option when adding a custom app"
```

---

### Task 7: Docs, finding, end-to-end check

**Files:**
- Create: `docs/findings/2026-10-06-custom-app-header-auth.md`
- Modify: `CLAUDE.md` (Findings Index, append one line)
- Modify: the docs page that documents custom apps (find with `grep -rli "custom app" docs/site/_content`)

- [ ] **Step 1: Docs page** — add a "Header auth" subsection: what it is, the header limits and deny-list from Global Constraints, that values are write-only, and that a wrong key fails at add time.

- [ ] **Step 2: Finding** — record what is non-obvious: static credentials live on the `custom_apps` row (not `connections`) so the admin "needs reconnect" derivation and `connected` computations needed no change except `isCustomAppConnected`; sessions are keyed on a header fingerprint so rotation replaces the session; verify errors are status-only because upstream text can echo request details; blank-value-keeps-stored on update. Add the one-line index entry to `CLAUDE.md`.

- [ ] **Step 3: Full verification**

Run: `npm run test && npm run build` from the repo root.
Expected: PASS, build clean.

- [ ] **Step 4: Manual smoke** (the `run` skill covers launching the app)

Start a throwaway local MCP server that requires `X-Api-Key: tok-abc` (loopback needs `NODE_ENV=development`). Add it via the portal with the right key → app appears connected, `search_tools` finds its tools, `execute_tools` runs one. Re-add with a wrong key → inline “Server rejected the headers (HTTP 401)” and no app row. Edit the key via AppDetail → next call uses the new key. Confirm an existing OAuth custom app still works.

- [ ] **Step 5: Pre-commit hygiene check and commit**

```bash
git diff --cached | grep -inIE '<company>|<internal-project>|@(icloud|gmail)\.com|<real-name>'
git add docs CLAUDE.md
git commit -m "docs(custom-apps): header auth guide and finding"
```

Release note: this touches DB schema and auth, so it ships as an `-rc.N` first per CLAUDE.md; hand-write `docs/releases/<tag>.md` at release time (see the `release-prep` skill).
