# Browser Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `session_id` names a tab inside the user's one Chromium; the routing key is derived from the bearer server-side and never handed to the agent.

**Architecture:** The MCP and REST endpoints compute `X-Browser-Session` from the authenticated `userId` through one shared forward helper. `WarmSession` grows a `tabs` map of page-level `CdpClient`s; `browser_start` creates a target and returns its id; every other tool resolves that id inside the caller's session, with a one-release fallback for the old HMAC value.

**Tech Stack:** TypeScript, Fastify, `ws`, Chromium DevTools Protocol (`Target.*`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-browser-tabs-design.md`

## Global Constraints

- Repo is public: no PII, no company refs, no secrets; test fixtures use `user-1`, `dev@example.com`, `example.com`.
- No `Co-Authored-By:` or "Generated with" trailers on commits.
- Routing header value stays `mintSessionKey(userId)` (HMAC), never the raw user id.
- Field name `session_id` is kept on every tool; only its meaning changes.
- Old HMAC `session_id` values must still drive the default tab (compat for one release).
- `BROWSER_TAB_LIMIT` default 8; error codes exactly `BROWSER_TAB_NOT_FOUND`, `BROWSER_TAB_LIMIT`.
- `BAD_SESSION_KEY` and `verifySessionKey` calls in tool handlers are removed.
- Live view keeps dialing `session.cdpPageWsUrl`, which must remain the default tab's ws url.
- Run tests with `npm run test -w @a-workbench/server`; typecheck with `npm run typecheck:tests -w @a-workbench/server`.
- Work on a branch, not `main`. Commit per task.

---

### Task 1: Extract the affinity forward into a shared helper keyed on the bearer

**Files:**
- Create: `packages/server/src/auth/affinity-forward.ts`
- Modify: `packages/server/src/index.ts:104-170` (the proxy block inside `app.post("/mcp")`)
- Test: `packages/server/tests/mcp-browser-proxy.test.ts` (rewrite)

**Interfaces:**
- Produces: `forwardForBrowserAffinity(opts: { userId; request; reply; target; body }): Promise<boolean>` and `touchesBrowser(executions: unknown, directTool?: unknown): boolean`.

- [ ] **Step 1: Write the failing test**

Replace the whole of `packages/server/tests/mcp-browser-proxy.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    INTERNAL_MCP_URL: "http://a-workbench/mcp",
  },
}));

import { config } from "../src/config";
import { SESSION_HEADER, mintSessionKey } from "../src/auth/cdp-bridge";
import { forwardForBrowserAffinity, touchesBrowser } from "../src/auth/affinity-forward";

// A trimmed /mcp: authenticate (stubbed), then the helper under test, then a
// local marker so the test can tell "handled here" from "forwarded".
async function buildApp() {
  const app = Fastify({ logger: false });
  app.post("/mcp", async (request, reply) => {
    const userId = request.headers["x-workbench-api-key"] === "valid-key" ? "user-1" : null;
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });
    const body = request.body as Record<string, unknown>;
    const params = body.params as { name?: unknown; arguments?: { executions?: unknown } } | undefined;
    if (
      body.method === "tools/call" &&
      touchesBrowser(params?.arguments?.executions, params?.name)
    ) {
      const sent = await forwardForBrowserAffinity({
        userId, request, reply, target: config.INTERNAL_MCP_URL!, body,
      });
      if (sent) return reply;
    }
    return { jsonrpc: "2.0", id: 1, result: { local: true } };
  });
  await app.ready();
  return app;
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function wrapped(tool: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "execute_tools", arguments: { executions: [{ tool, args }] } },
  };
}

describe("touchesBrowser", () => {
  it("is true for any browser_* execution, with or without a session_id", () => {
    expect(touchesBrowser([{ tool: "browser_navigate", args: { url: "https://example.com" } }])).toBe(true);
    expect(touchesBrowser([{ tool: "github_list_repos", args: {} }, { tool: "browser_start", args: {} }])).toBe(true);
  });
  it("is false for non-browser tools even when an arg is named session_id", () => {
    expect(touchesBrowser([{ tool: "github_list_repos", args: { session_id: "x" } }])).toBe(false);
    expect(touchesBrowser(undefined)).toBe(false);
    expect(touchesBrowser("not-a-list")).toBe(false);
  });
  it("is true for a direct browser_* tools/call", () => {
    expect(touchesBrowser(undefined, "browser_start")).toBe(true);
    expect(touchesBrowser(undefined, "execute_tools")).toBe(false);
  });
});

describe("browser affinity forward", () => {
  it("forwards a wrapped browser_* call with the user's routing key, derived from the bearer", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { remote: true } }) });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("browser_navigate", { url: "https://example.com" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { remote: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://a-workbench/mcp");
    expect(init.headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    expect(init.headers["x-workbench-api-key"]).toBe("valid-key");
    await app.close();
  });

  it("never reads a session_id from the args: an agent-supplied value is ignored", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ ok: 1 }) });
    const app = await buildApp();
    await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("browser_click", { session_id: "attacker-chosen", x: 1, y: 1 }),
    });
    expect(fetchMock.mock.calls[0][1].headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    await app.close();
  });

  it("forwards a direct browser_start tools/call (no execute_tools wrapper)", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ ok: 1 }) });
    const app = await buildApp();
    await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_start", arguments: {} } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("handles a non-browser call locally", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("github_list_repos", { session_id: "x" }),
    });
    expect(res.json().result).toEqual({ local: true });
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not re-forward a request that already carries the header (the receiving replica)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json", [SESSION_HEADER]: "already-routed" },
      payload: wrapped("browser_navigate", { url: "https://example.com" }),
    });
    expect(res.json().result).toEqual({ local: true });
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("falls through to local handling on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("browser_navigate", { url: "https://example.com" }),
    });
    expect(res.json().result).toEqual({ local: true });
    await app.close();
  });

  it("maps an empty upstream body to 202", async () => {
    fetchMock.mockResolvedValue({ status: 202, text: async () => "" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("browser_navigate", { url: "https://example.com" }),
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-browser-proxy.test.ts -w @a-workbench/server` (from `packages/server`: `npx vitest run tests/mcp-browser-proxy.test.ts`)
Expected: FAIL — cannot resolve `../src/auth/affinity-forward`.

- [ ] **Step 3: Write the helper**

Create `packages/server/src/auth/affinity-forward.ts`:

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_HEADER, mintSessionKey } from "./cdp-bridge";

// A browser session is process-local (docs/findings/2026-09-10-browser-session-pod-affinity.md),
// so under CLUSTER_ENABLED every call that touches one must reach the replica
// that owns the user's chromium. The mesh hashes on X-Browser-Session; this
// helper sets it on a second hop to the internal service.
//
// The value is derived from the authenticated user, never taken from the
// agent: the endpoint has already resolved the bearer to a userId by the time
// it decides to forward, and the routing key is a pure function of that id.
// The agent's `session_id` names a tab and has nothing to do with routing.

/** True when any execution, or the directly named tool, is a browser_* tool. */
export function touchesBrowser(executions: unknown, directTool?: unknown): boolean {
  if (typeof directTool === "string" && directTool.startsWith("browser_")) return true;
  if (!Array.isArray(executions)) return false;
  return executions.some(
    (e) => e && typeof e === "object" && typeof (e as { tool?: unknown }).tool === "string" &&
      ((e as { tool: string }).tool).startsWith("browser_")
  );
}

export interface ForwardOpts {
  userId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  /** Absolute URL on the internal service, e.g. `${INTERNAL_MCP_URL}` or `/rest/browser` on its origin. */
  target: string;
  body: unknown;
}

/**
 * Forward `body` to `target` with the caller's routing key. Returns true when
 * the reply has been sent (the upstream answered), false when the caller
 * should handle the request locally: the inbound request already carried the
 * header (we are the owning replica), or the hop failed at the network layer.
 */
export async function forwardForBrowserAffinity(opts: ForwardOpts): Promise<boolean> {
  const { userId, request, reply, target, body } = opts;
  if (request.headers[SESSION_HEADER]) return false;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [SESSION_HEADER]: mintSessionKey(userId),
  };
  const auth = request.headers.authorization as string | undefined;
  if (auth) headers.authorization = auth;
  const apiKey = request.headers["x-workbench-api-key"] as string | undefined;
  if (apiKey) headers["x-workbench-api-key"] = apiKey;
  let res: Response;
  let text: string;
  try {
    res = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    text = await res.text();
  } catch {
    return false;
  }
  if (res.status === 202 || !text) {
    reply.status(202).send();
    return true;
  }
  reply.status(res.status).send(JSON.parse(text) as Record<string, unknown>);
  return true;
}
```

- [ ] **Step 4: Replace the proxy block in `index.ts`**

In `packages/server/src/index.ts`, replace everything from the comment `// Forward browser_* tools/call requests through the mesh` down to and including the closing `}` of `if (config.INTERNAL_MCP_URL && ...) { ... }` with:

```ts
    // Under CLUSTER_ENABLED a browser_* call must reach the replica that owns
    // this user's chromium. The routing key is derived from the bearer, not
    // read from the agent's arguments. See auth/affinity-forward.ts.
    const params = body.params as { name?: unknown; arguments?: { executions?: unknown } } | undefined;
    if (
      config.INTERNAL_MCP_URL &&
      body.method === "tools/call" &&
      touchesBrowser(params?.arguments?.executions, params?.name)
    ) {
      const sent = await forwardForBrowserAffinity({
        userId, request, reply, target: config.INTERNAL_MCP_URL, body,
      });
      if (sent) return reply;
    }
```

Update imports at the top of `index.ts`: change
`import { registerCdpBridgeRoutes, startChannelReaper, SESSION_HEADER } from "./auth/cdp-bridge";`
to
`import { registerCdpBridgeRoutes, startChannelReaper } from "./auth/cdp-bridge";`
and add
`import { forwardForBrowserAffinity, touchesBrowser } from "./auth/affinity-forward";`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run test -w @a-workbench/server -- tests/mcp-browser-proxy.test.ts` then `npm run typecheck:tests -w @a-workbench/server`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth/affinity-forward.ts packages/server/src/index.ts packages/server/tests/mcp-browser-proxy.test.ts
git commit -m "feat(browser): derive the affinity routing key from the bearer, not the agent's args"
```

---

### Task 2: Forward `POST /rest/browser` the same way

**Files:**
- Modify: `packages/server/src/api/rest-routes.ts` (the `scope.post("/rest/:integration")` handler, after `authenticate` and the integration check)
- Test: `packages/server/tests/rest-browser-proxy.test.ts` (new)

**Interfaces:**
- Consumes: `forwardForBrowserAffinity`, `touchesBrowser` from Task 1.

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/rest-browser-proxy.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

vi.mock("../src/config", () => ({
  config: {
    PORTAL_URL: "http://portal.test",
    SERVER_PUBLIC_URL: "http://localhost:3000",
    CONNECT_TTL_SECONDS: 600,
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    INTERNAL_MCP_URL: "http://a-workbench/mcp",
  },
}));
vi.mock("../src/plugins/context", () => ({
  createContext: vi.fn(() => ({ userId: "user-1", getToken: vi.fn(), http: vi.fn() })),
}));
vi.mock("../src/audit/logger", () => ({ auditLogger: { log: vi.fn(() => Promise.resolve()) } }));
vi.mock("../src/auth/tokens", () => ({ getToken: vi.fn() }));
vi.mock("../src/auth/users", () => ({ getUserById: vi.fn(), verifyApiKey: vi.fn() }));
vi.mock("../src/auth/cookie", () => ({ hasValidCookies: vi.fn(() => false), storeCookies: vi.fn() }));
vi.mock("../src/auth/connections", () => ({ createPending: vi.fn(), getPending: vi.fn(), reapOne: vi.fn() }));
vi.mock("../src/auth/connect-token", () => ({ signConnectToken: vi.fn() }));
vi.mock("../src/auth/curl-session", () => ({ signCurlToken: vi.fn() }));
vi.mock("../src/telemetry/tracing", () => ({ withSpan: vi.fn((_n: string, fn: Function) => fn()) }));
vi.mock("../src/vault/store", () => ({ readSecretValue: vi.fn(async () => null), touchUsed: vi.fn(async () => undefined) }));
vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) =>
    headers["x-workbench-api-key"] === "valid-api-key" ? "user-1" : null
  ),
}));

import { registerRestRoutes } from "../src/api/rest-routes";
import { registry } from "../src/plugins/registry";
import { SESSION_HEADER, mintSessionKey } from "../src/auth/cdp-bridge";

const browserStart = {
  name: "browser_start",
  description: "start",
  integration: "browser",
  inputSchema: z.object({}),
  handler: vi.fn(async () => ({ session_id: "local-tab" })),
};
const listRepos = {
  name: "github_list_repos",
  description: "List repos",
  integration: "github",
  inputSchema: z.object({}),
  handler: vi.fn(async () => ({ local: true })),
};

const fetchMock = vi.fn();
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  registry.clear();
  registry.registerIntegration({ name: "browser", displayName: "Browser", auth: { type: "none" } } as any, [browserStart] as any);
  registry.registerIntegration({ name: "github", displayName: "GitHub", auth: { type: "none" } } as any, [listRepos] as any);
  app = Fastify({ logger: false });
  await registerRestRoutes(app as any);
  await app.ready();
});
afterEach(async () => { vi.unstubAllGlobals(); await app.close(); });

const headers = { "x-workbench-api-key": "valid-api-key", "content-type": "application/json" };

describe("POST /rest/browser affinity", () => {
  it("forwards to /rest/browser on the internal origin with the user's routing key", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ integration: "browser", result: { session_id: "remote-tab" } }) });
    const res = await app.inject({ method: "POST", url: "/rest/browser", headers, payload: { tool: "start" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ integration: "browser", result: { session_id: "remote-tab" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://a-workbench/rest/browser");
    expect(init.headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    expect(browserStart.handler).not.toHaveBeenCalled();
  });

  it("does not forward another integration", async () => {
    const res = await app.inject({ method: "POST", url: "/rest/github", headers, payload: { tool: "list_repos" } });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles locally when the header is already present", async () => {
    const res = await app.inject({
      method: "POST", url: "/rest/browser",
      headers: { ...headers, [SESSION_HEADER]: "routed" },
      payload: { tool: "start" },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browserStart.handler).toHaveBeenCalled();
  });
});
```

Check how `rest-routes.test.ts` registers integrations (the exact `registry.registerIntegration` / `registry.clear` signatures around its `beforeEach`) and mirror that; the two calls above are the intended shape, adjust argument order to match the real registry API.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @a-workbench/server -- tests/rest-browser-proxy.test.ts`
Expected: first test FAILS (`fetchMock` not called; handler ran locally).

- [ ] **Step 3: Add the forward to the REST execute handler**

In `packages/server/src/api/rest-routes.ts`, add the import:

```ts
import { forwardForBrowserAffinity } from "../auth/affinity-forward";
```

Inside `scope.post("/rest/:integration", ...)`, right after the `if (!registry.getIntegration(integration))` 404 check and before `const body = request.body;`, insert:

```ts
        // The browser integration is process-local: route it to the replica
        // that owns this user's chromium, exactly as /mcp does. Same origin as
        // INTERNAL_MCP_URL, this endpoint's own path.
        if (integration === "browser" && config.INTERNAL_MCP_URL) {
          const target = new URL("/rest/browser", config.INTERNAL_MCP_URL).toString();
          const sent = await forwardForBrowserAffinity({
            userId, request, reply, target, body: request.body ?? {},
          });
          if (sent) return reply;
        }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run test -w @a-workbench/server -- tests/rest-browser-proxy.test.ts tests/rest-routes.test.ts` and `npm run typecheck:tests -w @a-workbench/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/rest-routes.ts packages/server/tests/rest-browser-proxy.test.ts
git commit -m "fix(rest): route POST /rest/browser to the replica that owns the user's chromium"
```

---

### Task 3: Tabs inside `WarmSession`

**Files:**
- Modify: `packages/server/src/config.ts:33` (add `BROWSER_TAB_LIMIT`)
- Modify: `packages/server/src/auth/profile-chromium.ts:146-157, 250-258` (`SpawnedChromium.cdpPageTargetId`)
- Modify: `packages/server/src/auth/browser-session.ts` (`WarmSession`, `ensureSession`, `closeBrowserSession`, action helper signatures, new tab functions)
- Test: `packages/server/tests/browser-session.test.ts` (extend), `packages/server/tests/browser-actions.test.ts` (type only)

**Interfaces:**
- Produces:
  - `interface PageHandle { cdp: CdpClient; lastShotHash?: string }`
  - `interface Tab extends PageHandle { id: string; lastActivity: number; createdAt: number }`
  - `WarmSession.tabs: Map<string, Tab>`, `WarmSession.defaultTabId: string`, `WarmSession.cdpPageWsUrl` unchanged (default tab's url)
  - `openTab(userId): Promise<{ ok: true; tab: Tab } | { ok: false; error: "BROWSER_TAB_LIMIT"; limit: number }>`
  - `getTab(userId, tabId): Tab | undefined`
  - `defaultTab(userId): Promise<Tab>` (ensures the session, re-registers a default if it was closed)
  - `closeTab(userId, tabId): Promise<boolean>`
  - `listTabs(userId): Promise<Array<{ id: string; url: string; title: string; active: boolean }>>`
  - `touchTab(userId, tabId): void`
  - Action helpers `navigate/screenshot/click/typeText/pressKey/scroll/readText/evaluate` now take `PageHandle` as first arg.
- Consumes: `browserClient(s)` (existing) for `Target.*` commands on the browser target.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/tests/browser-session.test.ts`. First extend the `spawnMock` fixture in the existing `beforeEach` to include `cdpPageTargetId: "T0"`. Then add:

```ts
import { openTab, getTab, defaultTab, closeTab, listTabs, touchTab, browserClient } from "../src/auth/browser-session";

// browserClient opens a second FakeWebSocket on the browser target; Target.*
// replies come from cdpSend below, patched onto that client after creation.
async function stubBrowserTarget(userId: string, replies: Record<string, unknown>) {
  const s = getWarmSession(userId)!;
  const client = await browserClient(s);
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  (client as any).send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    sent.push({ method, params });
    const r = replies[method];
    return typeof r === "function" ? r(params) : (r ?? {});
  });
  return sent;
}

describe("tabs", () => {
  it("ensureSession registers the spawn's page as the default tab", async () => {
    const s = await ensureSession("u1");
    expect(s.defaultTabId).toBe("T0");
    expect(s.tabs.get("T0")).toMatchObject({ id: "T0" });
    expect(s.cdpPageWsUrl).toBe("ws://127.0.0.1:9999/page");
  });

  it("openTab creates a target, registers it under its id, and returns it", async () => {
    await ensureSession("u1");
    const sent = await stubBrowserTarget("u1", { "Target.createTarget": { targetId: "T1" } });
    const r = await openTab("u1");
    expect(r).toMatchObject({ ok: true, tab: { id: "T1" } });
    expect(sent).toContainEqual({ method: "Target.createTarget", params: { url: "about:blank" } });
    expect(getTab("u1", "T1")).toBeDefined();
    expect(getWarmSession("u1")!.tabs.size).toBe(2);
  });

  it("openTab refuses past BROWSER_TAB_LIMIT", async () => {
    await ensureSession("u1");
    let n = 0;
    await stubBrowserTarget("u1", { "Target.createTarget": () => ({ targetId: `T${++n}` }) });
    for (let i = 1; i < 8; i++) expect((await openTab("u1")).ok).toBe(true); // 7 + default = 8
    const r = await openTab("u1");
    expect(r).toEqual({ ok: false, error: "BROWSER_TAB_LIMIT", limit: 8 });
  });

  it("closeTab closes the target and removes only that tab; the session stays warm", async () => {
    await ensureSession("u1");
    const sent = await stubBrowserTarget("u1", { "Target.createTarget": { targetId: "T1" } });
    await openTab("u1");
    expect(await closeTab("u1", "T1")).toBe(true);
    expect(sent).toContainEqual({ method: "Target.closeTarget", params: { targetId: "T1" } });
    expect(getTab("u1", "T1")).toBeUndefined();
    expect(getWarmSession("u1")).toBeDefined();
    expect(await closeTab("u1", "nope")).toBe(false);
  });

  it("a tab whose socket dies is dropped without taking the session down", async () => {
    await ensureSession("u1");
    await stubBrowserTarget("u1", { "Target.createTarget": { targetId: "T1" } });
    const r = await openTab("u1");
    if (!r.ok) throw new Error("open failed");
    (r.tab.cdp as any).ws.emit("close");
    expect(getTab("u1", "T1")).toBeUndefined();
    expect(getWarmSession("u1")).toBeDefined();
  });

  it("defaultTab re-registers from Target.getTargets when the default was closed", async () => {
    await ensureSession("u1");
    const sent = await stubBrowserTarget("u1", {
      "Target.getTargets": { targetInfos: [{ targetId: "T9", type: "page", url: "about:blank", title: "" }] },
    });
    await closeTab("u1", "T0");
    const t = await defaultTab("u1");
    expect(t.id).toBe("T9");
    expect(getWarmSession("u1")!.defaultTabId).toBe("T9");
    expect(getWarmSession("u1")!.cdpPageWsUrl).toBe("ws://127.0.0.1:9999/devtools/page/T9");
    expect(sent.map((x) => x.method)).toContain("Target.getTargets");
  });

  it("listTabs joins Target.getTargets with the map", async () => {
    await ensureSession("u1");
    await stubBrowserTarget("u1", {
      "Target.getTargets": { targetInfos: [
        { targetId: "T0", type: "page", url: "https://example.com", title: "Ex" },
        { targetId: "POP", type: "page", url: "https://example.com/pop", title: "Pop" },
        { targetId: "SW", type: "service_worker", url: "x", title: "" },
      ] },
    });
    expect(await listTabs("u1")).toEqual([
      { id: "T0", url: "https://example.com", title: "Ex", active: true },
      { id: "POP", url: "https://example.com/pop", title: "Pop", active: false },
    ]);
  });

  it("touchTab bumps the tab and the session", async () => {
    const s = await ensureSession("u1");
    s.lastActivity = 0;
    s.tabs.get("T0")!.lastActivity = 0;
    touchTab("u1", "T0");
    expect(s.tabs.get("T0")!.lastActivity).toBeGreaterThan(0);
    expect(s.lastActivity).toBeGreaterThan(0);
  });

  it("closeBrowserSession closes every tab client", async () => {
    await ensureSession("u1");
    await stubBrowserTarget("u1", { "Target.createTarget": { targetId: "T1" } });
    const r = await openTab("u1");
    if (!r.ok) throw new Error("open failed");
    const spy = vi.spyOn(r.tab.cdp, "close");
    await closeBrowserSession("u1");
    expect(spy).toHaveBeenCalled();
    expect(getWarmSession("u1")).toBeUndefined();
  });
});
```

If the existing suite has an `afterEach` that calls `closeBrowserSession`, keep it; otherwise add one so sessions don't leak between tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @a-workbench/server -- tests/browser-session.test.ts`
Expected: FAIL — `openTab` etc. not exported; `defaultTabId` undefined.

- [ ] **Step 3: Config and spawn**

In `packages/server/src/config.ts`, after `BROWSER_SESSION_TTL_SECONDS`, add:

```ts
  // Tabs one user may hold open in their chromium at once. Bounds an agent
  // that calls browser_start in a loop; the idle reaper bounds the rest.
  BROWSER_TAB_LIMIT: z.coerce.number().int().positive().default(8),
```

In `packages/server/src/auth/profile-chromium.ts`, add to `SpawnedChromium`:

```ts
  /** targetId of the page chromium opened at spawn; the session's default tab. */
  cdpPageTargetId: string;
```

and in the return object of `spawnProfileChromium`, add `cdpPageTargetId: target.id,` next to `cdpPageWsUrl`.

- [ ] **Step 4: Session shape and tab functions**

In `packages/server/src/auth/browser-session.ts`:

Replace the `WarmSession` interface's `cdp: CdpClient;` and `lastShotHash?: string;` lines with:

```ts
  /**
   * Page targets this session drives, keyed by chromium targetId. The agent's
   * `session_id` is one of these keys. `defaultTabId` is the page chromium
   * opened at spawn; the live view dials it (`cdpPageWsUrl`) and pre-upgrade
   * agents holding the old routing key are mapped onto it.
   */
  tabs: Map<string, Tab>;
  defaultTabId: string;
```

Above `WarmSession`, add:

```ts
/** What the CDP action helpers need: one page-level client and its last screenshot hash. */
export interface PageHandle {
  cdp: CdpClient;
  lastShotHash?: string;
}

export interface Tab extends PageHandle {
  id: string;
  lastActivity: number;
  createdAt: number;
}

function pageWsUrl(remotePort: number, targetId: string): string {
  return `ws://127.0.0.1:${remotePort}/devtools/page/${targetId}`;
}

async function attachTab(s: WarmSession, targetId: string, wsUrl: string): Promise<Tab> {
  const cdp = new CdpClient(wsUrl, () => {
    // Only this tab is gone. Never tear the session down from here: chromium
    // is still up and the other tabs are still driveable.
    const cur = s.tabs.get(targetId);
    if (cur && cur.cdp === cdp) s.tabs.delete(targetId);
  });
  await cdp.ready;
  const now = Date.now();
  const tab: Tab = { id: targetId, cdp, lastActivity: now, createdAt: now };
  s.tabs.set(targetId, tab);
  return tab;
}
```

In `ensureSession`, replace
```ts
    const cdp = new CdpClient(spawned.cdpPageWsUrl, () => { void closeBrowserSession(userId); });
    await cdp.ready;
```
with nothing (delete both lines), and build the session object as:

```ts
    const session: WarmSession = {
      proc: spawned.proc,
      remotePort: spawned.remotePort,
      cdpPageWsUrl: spawned.cdpPageWsUrl,
      cdpBrowserWsUrl: spawned.cdpBrowserWsUrl,
      userId,
      lastActivity: Date.now(),
      tabs: new Map(),
      defaultTabId: spawned.cdpPageTargetId,
      authWs,
    };
    await attachTab(session, spawned.cdpPageTargetId, spawned.cdpPageWsUrl);
    warmSessions.set(userId, session);
```

In the `proc.on("exit")` handler replace `try { session.cdp.close(); } catch { /* noop */ }` with:

```ts
      for (const t of session.tabs.values()) { try { t.cdp.close(); } catch { /* noop */ } }
      session.tabs.clear();
```

In `closeBrowserSession` replace `try { s.cdp.close(); } catch { /* noop */ }` with the same two lines.

After `getWarmSession`, add:

```ts
export function getTab(userId: string, tabId: string): Tab | undefined {
  return warmSessions.get(userId)?.tabs.get(tabId);
}

export function touchTab(userId: string, tabId: string): void {
  const s = warmSessions.get(userId);
  if (!s) return;
  const now = Date.now();
  s.lastActivity = now;
  const t = s.tabs.get(tabId);
  if (t) t.lastActivity = now;
}

export type OpenTabResult =
  | { ok: true; tab: Tab }
  | { ok: false; error: "BROWSER_TAB_LIMIT"; limit: number };

/** Open a fresh about:blank tab in this user's chromium and register it. */
export async function openTab(userId: string): Promise<OpenTabResult> {
  const s = await ensureSession(userId);
  const limit = config.BROWSER_TAB_LIMIT;
  if (s.tabs.size >= limit) return { ok: false, error: "BROWSER_TAB_LIMIT", limit };
  const browser = await browserClient(s);
  const { targetId } = (await browser.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const tab = await attachTab(s, targetId, pageWsUrl(s.remotePort, targetId));
  s.lastActivity = Date.now();
  return { ok: true, tab };
}

/**
 * The default tab, ensuring the session. If the default was closed, adopt the
 * first live page target (or create one) so the live view and compat callers
 * always have somewhere to land.
 */
export async function defaultTab(userId: string): Promise<Tab> {
  const s = await ensureSession(userId);
  const existing = s.tabs.get(s.defaultTabId);
  if (existing) return existing;
  const browser = await browserClient(s);
  const { targetInfos } = (await browser.send("Target.getTargets")) as {
    targetInfos?: Array<{ targetId: string; type: string }>;
  };
  let targetId = targetInfos?.find((t) => t.type === "page")?.targetId;
  if (!targetId) {
    targetId = ((await browser.send("Target.createTarget", { url: "about:blank" })) as { targetId: string }).targetId;
  }
  const tab = s.tabs.get(targetId) ?? (await attachTab(s, targetId, pageWsUrl(s.remotePort, targetId)));
  s.defaultTabId = targetId;
  s.cdpPageWsUrl = pageWsUrl(s.remotePort, targetId);
  return tab;
}

/** Close one tab. False when it is not a tab of this user's session. */
export async function closeTab(userId: string, tabId: string): Promise<boolean> {
  const s = warmSessions.get(userId);
  const tab = s?.tabs.get(tabId);
  if (!s || !tab) return false;
  s.tabs.delete(tabId);
  try { tab.cdp.close(); } catch { /* noop */ }
  try {
    const browser = await browserClient(s);
    await browser.send("Target.closeTarget", { targetId: tabId });
  } catch { /* target already gone */ }
  s.lastActivity = Date.now();
  return true;
}

export interface TabInfo { id: string; url: string; title: string; active: boolean }

/** Every page target in the user's chromium; `active` = driveable through a registered tab. */
export async function listTabs(userId: string): Promise<TabInfo[]> {
  const s = await ensureSession(userId);
  const browser = await browserClient(s);
  const { targetInfos } = (await browser.send("Target.getTargets")) as {
    targetInfos?: Array<{ targetId: string; type: string; url: string; title: string }>;
  };
  return (targetInfos ?? [])
    .filter((t) => t.type === "page")
    .map((t) => ({ id: t.targetId, url: t.url, title: t.title, active: s.tabs.has(t.targetId) }));
}
```

Change every action helper signature from `s: WarmSession` to `s: PageHandle` (`navigate`, `pageTitle`, `screenshot`, `click`, `typeText`, `pressKey`, `scroll`, `readText`, `evaluate`). Bodies are unchanged: they only use `s.cdp` and `s.lastShotHash`. Update the header comment above them: `// Each takes a PageHandle (a tab) and speaks CDP through its page-level client.`

`cdpPageWsUrl` must become mutable: it already is (interface property, not readonly).

- [ ] **Step 5: Fix the action test's type helper**

In `packages/server/tests/browser-actions.test.ts`, change the import `type WarmSession` to `type PageHandle` and `sessionWithCdp` to return `PageHandle`:

```ts
function sessionWithCdp(send: ReturnType<typeof vi.fn>): PageHandle {
  return { cdp: { send } } as unknown as PageHandle;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run test -w @a-workbench/server -- tests/browser-session.test.ts tests/browser-actions.test.ts tests/cdp-bridge.test.ts tests/browser-file-transfer.test.ts` and `npm run typecheck:tests -w @a-workbench/server`
Expected: PASS. `cdp-bridge.test.ts` still passes because it mocks `ensureSession` returning `cdpPageWsUrl`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/auth/profile-chromium.ts packages/server/src/auth/browser-session.ts packages/server/tests/browser-session.test.ts packages/server/tests/browser-actions.test.ts
git commit -m "feat(browser): tabs inside the per-user session — open, close, list, default"
```

---

### Task 4: `session_id` names a tab in the plugin

**Files:**
- Modify: `packages/server/src/plugins/internal/browser.ts` (every tool)
- Test: `packages/server/tests/browser-meta-tools.test.ts` (rewrite the mock + affected tests)

**Interfaces:**
- Consumes: `openTab`, `getTab`, `defaultTab`, `closeTab`, `listTabs`, `touchTab`, `Tab` from Task 3; `verifySessionKey` from `cdp-bridge` (compat only).
- Produces: `browser_start` → `{ session_id }` (tab id) or `{ error: "BROWSER_TAB_LIMIT", limit }`; new tool `browser_tabs`; error `BROWSER_TAB_NOT_FOUND`.

- [ ] **Step 1: Write the failing tests**

In `packages/server/tests/browser-meta-tools.test.ts`:

Replace the `vi.mock("../src/auth/browser-session", ...)` factory with:

```ts
const { openTabMock, getTabMock, defaultTabMock, closeTabMock, listTabsMock, touchTabMock } = vi.hoisted(() => ({
  openTabMock: vi.fn(),
  getTabMock: vi.fn(),
  defaultTabMock: vi.fn(),
  closeTabMock: vi.fn(),
  listTabsMock: vi.fn(),
  touchTabMock: vi.fn(),
}));

vi.mock("../src/auth/browser-session", () => ({
  ensureSession: ensureMock,
  touch: touchMock,
  touchTab: touchTabMock,
  openTab: openTabMock,
  getTab: getTabMock,
  defaultTab: defaultTabMock,
  closeTab: closeTabMock,
  listTabs: listTabsMock,
  navigate: navMock,
  screenshot: shotMock,
  click: clickMock,
  typeText: typeMock,
  pressKey: keyMock,
  scroll: scrollMock,
  readText: readMock,
  evaluate: evalMock,
  closeBrowserSession: closeMock,
  browserClient: vi.fn(),
  ensureDownloadRouting: vi.fn(),
}));
```

Keep the `cdp-bridge` mock (`mintSessionKey` → `"test-session-id"`, `verifySessionKey` true only for it).

In `beforeEach`, after `ensureMock.mockResolvedValue({ userId: "u1" })`, add:

```ts
  TAB = { id: "T1", cdp: { send: vi.fn() }, lastActivity: 0, createdAt: 0 };
  DEFAULT = { id: "T0", cdp: { send: vi.fn() }, lastActivity: 0, createdAt: 0 };
  getTabMock.mockImplementation((_u: string, id: string) => (id === "T1" ? TAB : undefined));
  defaultTabMock.mockResolvedValue(DEFAULT);
```

with `let TAB: any; let DEFAULT: any;` declared at module scope.

Replace the three tests `browser_navigate ensures session, touches, navigates`, `refuses a session_id that is not this user's routing key…`, and `browser_evaluate runs the expression…` with:

```ts
  it("browser_start opens a tab and returns its id as session_id", async () => {
    openTabMock.mockResolvedValue({ ok: true, tab: TAB });
    const out = await (tool("browser_start").handler as any)({ userId: "u1" }, {});
    expect(openTabMock).toHaveBeenCalledWith("u1");
    expect(out).toEqual({ session_id: "T1" });
  });

  it("browser_start surfaces the tab cap", async () => {
    openTabMock.mockResolvedValue({ ok: false, error: "BROWSER_TAB_LIMIT", limit: 8 });
    const out = await (tool("browser_start").handler as any)({ userId: "u1" }, {});
    expect(out).toEqual({ error: "BROWSER_TAB_LIMIT", limit: 8 });
  });

  it("browser_navigate resolves session_id to a tab, touches it, navigates that tab", async () => {
    navMock.mockResolvedValue({ url: "https://e.com", title: "E" });
    const out = await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "T1", url: "https://e.com" });
    expect(navMock).toHaveBeenCalledWith(TAB, "https://e.com");
    expect(touchTabMock).toHaveBeenCalledWith("u1", "T1");
    expect(out).toEqual({ url: "https://e.com", title: "E" });
  });

  it("an unknown session_id is BROWSER_TAB_NOT_FOUND and touches nothing", async () => {
    const out = await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "garbage", url: "https://e.com" });
    expect(out).toMatchObject({ error: "BROWSER_TAB_NOT_FOUND" });
    expect(navMock).not.toHaveBeenCalled();
    expect(defaultTabMock).not.toHaveBeenCalled();
  });

  it("the pre-upgrade routing key still drives the default tab (compat)", async () => {
    navMock.mockResolvedValue({ url: "https://e.com", title: "E" });
    await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "test-session-id", url: "https://e.com" });
    expect(defaultTabMock).toHaveBeenCalledWith("u1");
    expect(navMock).toHaveBeenCalledWith(DEFAULT, "https://e.com");
  });

  it("two tabs are driven independently", async () => {
    const T2 = { id: "T2", cdp: { send: vi.fn() }, lastActivity: 0, createdAt: 0 };
    getTabMock.mockImplementation((_u: string, id: string) => ({ T1: TAB, T2 }[id]));
    navMock.mockResolvedValue({ url: "x", title: "" });
    await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "T1", url: "https://a.example.com" });
    await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "T2", url: "https://b.example.com" });
    expect(navMock).toHaveBeenNthCalledWith(1, TAB, "https://a.example.com");
    expect(navMock).toHaveBeenNthCalledWith(2, T2, "https://b.example.com");
  });

  it("browser_evaluate runs the expression on the tab", async () => {
    evalMock.mockResolvedValue({ value: 3 });
    const out = await (tool("browser_evaluate").handler as any)({ userId: "u1" }, { session_id: "T1", expression: "1+2" });
    expect(evalMock).toHaveBeenCalledWith(TAB, "1+2", expect.objectContaining({ awaitPromise: true }));
    expect(out).toEqual({ value: 3 });
  });

  it("browser_close closes the tab, not the session", async () => {
    closeTabMock.mockResolvedValue(true);
    const out = await (tool("browser_close").handler as any)({ userId: "u1" }, { session_id: "T1" });
    expect(closeTabMock).toHaveBeenCalledWith("u1", "T1");
    expect(closeMock).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
  });

  it("browser_tabs lists the session's page targets", async () => {
    listTabsMock.mockResolvedValue([{ id: "T1", url: "https://e.com", title: "E", active: true }]);
    const out = await (tool("browser_tabs").handler as any)({ userId: "u1" }, {});
    expect(out).toEqual({ tabs: [{ session_id: "T1", url: "https://e.com", title: "E", active: true }] });
  });
```

Update `requires session_id on every tool except browser_start…` to skip `browser_start`, `browser_tabs`, and `browser_live_url`:

```ts
    for (const t of browserPlugin.tools) {
      if (["browser_start", "browser_tabs", "browser_live_url"].includes(t.name)) continue;
```

and rewrite its comment: the field now names the tab, and every driving tool needs one. Every other existing test in the file that passes `session_id: "test-session-id"` and asserts on `ensureMock`/`touchMock` must switch to `session_id: "T1"`, assert `touchTabMock` was called with `("u1", "T1")`, and expect helpers to be called with `TAB` instead of `{ userId: "u1" }`. `browser_expect_download` and `browser_await_download` keep asserting on `ensureMock`/`browserClient`, but pass `session_id: "T1"`. `browser_live_url` tests drop `session_id` from args.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @a-workbench/server -- tests/browser-meta-tools.test.ts`
Expected: FAIL on `browser_start`, `browser_tabs`, `BROWSER_TAB_NOT_FOUND`.

- [ ] **Step 3: Rewrite the plugin**

In `packages/server/src/plugins/internal/browser.ts`:

Replace the import block from `../../auth/browser-session` with:

```ts
import {
  ensureSession,
  touch,
  touchTab,
  openTab,
  getTab,
  defaultTab,
  closeTab,
  listTabs,
  navigate as browserNavigate,
  screenshot as browserScreenshot,
  click as browserClick,
  typeText as browserType,
  pressKey as browserKey,
  scroll as browserScroll,
  readText as browserReadText,
  evaluate as browserEvaluate,
  browserClient,
  ensureDownloadRouting,
  type Tab,
} from "../../auth/browser-session";
```

Replace `import { mintSessionKey, verifySessionKey } from "../../auth/cdp-bridge";` with `import { verifySessionKey } from "../../auth/cdp-bridge";`.

Replace `SESSION_ID_DESC` and the whole `badSessionKey` block with:

```ts
const SESSION_ID_DESC =
  "The tab to act on: the session_id returned by browser_start. Each browser_start opens a new tab; use one per independent task.";

type TabNotFound = { error: "BROWSER_TAB_NOT_FOUND"; detail: string };

// session_id names a tab in this user's own chromium. Lookup is scoped to the
// caller's session, so another user's tab id can never resolve. Routing to the
// replica that owns the chromium happened before this handler ran, keyed on
// the bearer (auth/affinity-forward.ts) — nothing here is a routing check.
//
// Compat, one release: a value that is the pre-upgrade routing key maps onto
// the default tab, so agents holding an old session_id keep working.
async function resolveTab(ctx: { userId: string }, args: { session_id?: string }): Promise<Tab | TabNotFound> {
  const id = args.session_id ?? "";
  const tab = getTab(ctx.userId, id);
  if (tab) { touchTab(ctx.userId, id); return tab; }
  if (verifySessionKey(id, ctx.userId)) {
    const d = await defaultTab(ctx.userId);
    touchTab(ctx.userId, d.id);
    return d;
  }
  return {
    error: "BROWSER_TAB_NOT_FOUND",
    detail: "session_id is not an open tab of yours; call browser_start and pass the session_id it returns, or browser_tabs to list them",
  };
}

function isNotFound(x: Tab | TabNotFound): x is TabNotFound {
  return (x as TabNotFound).error === "BROWSER_TAB_NOT_FOUND";
}
```

Rewrite `browser_start`:

```ts
  {
    name: "browser_start",
    description:
      "Open a new tab in your browser and return its session_id. Pass it to every other browser_* call. Call it once per independent task; two agents each get their own tab and never step on each other. All tabs share one browser, so a login in one is visible in the others.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({}),
    handler: async (ctx: any) => {
      const r = await openTab(ctx.userId);
      if (!r.ok) return { error: r.error, limit: r.limit };
      return { session_id: r.tab.id };
    },
  },
```

For each of `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, `browser_read_text`, `browser_evaluate`, replace the handler prologue

```ts
      const bad = badSessionKey(ctx, args);
      if (bad) return bad;
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
```

with

```ts
      const s = await resolveTab(ctx, args);
      if (isNotFound(s)) return s;
```

and leave the rest of each body as is (they already pass `s` to the helper). Update descriptions that say "per-user browser session" to "this tab" (`browser_navigate`: "Navigate this tab to a URL. Returns the final url and page title."; `browser_click`: "Click at viewport coordinates (x, y) in this tab.").

`browser_expect_download`:

```ts
    handler: async (ctx: any, args: any) => {
      const t = await resolveTab(ctx, args);
      if (isNotFound(t)) return t;
      const s = await ensureSession(ctx.userId);
      // Arming is the point at which routing has to be real, so wait for it
      // here rather than at session creation.
      await ensureDownloadRouting(s);
      const client = await browserClient(s);
      return expectDownload(ctx.userId, client, () => touch(ctx.userId));
    },
```

`browser_await_download`: replace the `badSessionKey` two lines with `const t = await resolveTab(ctx, args); if (isNotFound(t)) return t;` and keep the comment about the handle living in this process.

`browser_upload_file`:

```ts
    handler: async (ctx: any, args: any) => {
      const s = await resolveTab(ctx, args);
      if (isNotFound(s)) return s;
      try {
        const done = await uploadWorkspaceFile(s.cdp, ctx.userId, args.selector, args.name);
```

`browser_close`:

```ts
  {
    name: "browser_close",
    description: "Close this tab. The browser and its logged-in profile stay; other tabs are untouched. An idle browser closes itself after BROWSER_SESSION_TTL_SECONDS.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({ session_id: z.string().describe(SESSION_ID_DESC) }),
    handler: async (ctx: any, args: any) => {
      const t = await resolveTab(ctx, args);
      if (isNotFound(t)) return t;
      await closeTab(ctx.userId, t.id);
      return { ok: true };
    },
  },
```

Add, before `browser_live_url`:

```ts
  {
    name: "browser_tabs",
    description: "List the tabs open in your browser: session_id, url, title, and whether this toolset can drive it (a popup the page opened is listed but not driveable).",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({}),
    handler: async (ctx: any) => {
      const tabs = await listTabs(ctx.userId);
      return { tabs: tabs.map((t) => ({ session_id: t.id, url: t.url, title: t.title, active: t.active })) };
    },
  },
```

`browser_live_url`: change `inputSchema` to `z.object({})`, drop the `badSessionKey` lines, and remove `session_id` from its description if mentioned. Keep the rest.

Remove the now-unused `closeBrowserSession` import if nothing references it (`browser_close` no longer does).

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run test -w @a-workbench/server` and `npm run typecheck:tests -w @a-workbench/server`
Expected: all PASS. Check `browser-live-url.test.ts` for a `session_id` arg and drop it there too if it fails.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/plugins/internal/browser.ts packages/server/tests/browser-meta-tools.test.ts packages/server/tests/browser-live-url.test.ts
git commit -m "feat(browser): session_id names a tab — browser_start opens one, browser_tabs lists them, browser_close closes one"
```

---

### Task 5: Docs, finding, release notes

**Files:**
- Modify: `docs/site/_content/integrations/browser.md`
- Create: `docs/findings/2026-09-17-browser-affinity-from-bearer.md`
- Create: `docs/releases/v0.30.0.md`
- Modify: `CLAUDE.md` (Findings Index)

- [ ] **Step 1: Rewrite the session model section of `browser.md`**

Replace the paragraph starting `**One user, one browser, one page.**` with:

```markdown
**One user, one browser, many tabs.** `browser_start` opens a new tab and returns its `session_id`. Every other driving tool takes that id and acts on that tab only. Two agents (or one agent with subagents) each call `browser_start` and get their own tab; they never step on each other. All tabs live in one Chromium with one profile and one cookie jar, so a login in one tab is visible in the others, and downloads from any tab land in the same [workspace](files.md). A user may hold `BROWSER_TAB_LIMIT` tabs at once (default 8); `browser_start` past that returns `BROWSER_TAB_LIMIT`. `browser_tabs` lists what is open. An id that is not one of your open tabs is refused with `BROWSER_TAB_NOT_FOUND`.

`session_id` is not a credential and not a routing key. Behind a load balancer every `browser_*` call still has to reach the replica that owns the Chromium process (see [browser session pod affinity](../field-notes/2026-09-10-browser-session-pod-affinity.md)); the server derives that routing key from the bearer itself, so the agent never sees or carries it. Until v0.31, a `session_id` minted by a pre-v0.30 `browser_start` still works and drives the default tab.
```

In the Tools table: `browser_start` → "Open a new tab and return its `session_id`. Once per independent task"; `browser_close` → "Close this tab; the browser and profile stay"; add a row `browser_tabs` | "List open tabs with their `session_id`, url, title"; `browser_live_url` → drop any mention of `session_id`. Update "fourteen tools" / `Tools | 14` to fifteen / 15. In the live-view section, replace "every request after the first carries the same per-user routing key the agent's `session_id` is" with "every request after the first carries the same per-user routing key the server uses for the agent's tool calls". Note the live view shows the default tab.

- [ ] **Step 2: Write the finding**

Create `docs/findings/2026-09-17-browser-affinity-from-bearer.md`:

```markdown
# Browser affinity comes from the bearer, not from the agent

**Date:** 2026-09-17

## What we found

Since the pod-affinity fix ([2026-09-10](2026-09-10-browser-session-pod-affinity.md)) every `browser_*` tool took a `session_id` that was `HMAC(SESSION_SECRET, userId)`, and the `/mcp` handler dug it out of `executions[].args` to set `X-Browser-Session` on the hop to the internal service. But that handler had already resolved the bearer to a `userId` before it looked — the agent was carrying a value the server could compute from what it already had.

Two consequences:

- `session_id` was spent on routing, so there was no way to name a second tab. One user, one page.
- `POST /rest/:integration` runs the same tools through the same engine but never forwarded at all, so under `CLUSTER_ENABLED` a `POST /rest/browser` could spawn a second Chromium on the shared profile and fight the first for `SingletonLock`.

## What changed

- One helper (`auth/affinity-forward.ts`) sets `X-Browser-Session: mintSessionKey(userId)` when a `/mcp` `tools/call` or a `POST /rest/browser` touches a `browser_*` tool. The agent's arguments are never consulted.
- `session_id` now names a tab (a Chromium `targetId`) inside the caller's own session. `browser_start` opens one; `browser_tabs` lists them; `browser_close` closes one. Lookup is scoped to the caller's `WarmSession`, so no HMAC is needed on the id.
- The key stays an HMAC rather than the raw user id: the portal live view already hashes on it, and a user id does not belong in mesh headers or proxy logs.

## What did not change

The portal live view still sends the header from the client: its requests meet the proxy before any server code runs, so the server cannot add it. `attach` mints the key exactly as before. Both paths hash on the same value.
```

- [ ] **Step 3: Release notes**

Create `docs/releases/v0.30.0.md`:

```markdown
## v0.30.0 — browser tabs

The browser toolset moves from one page per user to one Chromium per user with as many tabs as the work needs. Two agents, or one agent with subagents, each open their own tab and stop stepping on each other. Ships as a release candidate first: it touches the routing path behind `CLUSTER_ENABLED`.

### Features

- **Browser: tabs.** `browser_start` now opens a new tab and returns its `session_id`; every other tool acts on that tab. `browser_tabs` lists open tabs, `browser_close` closes one and leaves the browser up. Tabs share the profile and cookie jar, so a login in one is visible in the others. Cap per user: `BROWSER_TAB_LIMIT` (default 8).
- **Browser: routing key derived from the bearer.** The replica-affinity header is set by the server from the authenticated user; the agent no longer carries a routing key in `session_id`. See [the finding](../findings/2026-09-17-browser-affinity-from-bearer.md).

### Fixes

- **REST: `POST /rest/browser` is now routed to the owning replica.** It ran wherever it landed, which under `CLUSTER_ENABLED` could start a second Chromium on the shared profile.

### Compatibility

- A `session_id` minted by a pre-v0.30 `browser_start` keeps working for this release and drives the default tab. The fallback is removed in v0.31.
- `BAD_SESSION_KEY` is gone; the new errors are `BROWSER_TAB_NOT_FOUND` and `BROWSER_TAB_LIMIT`.
- `browser_live_url` no longer takes `session_id`.
- The portal live view shows the default tab.

**Full diff:** https://github.com/barockok/workbench/compare/v0.29.0...v0.30.0
```

- [ ] **Step 4: Findings index**

Append to the Findings Index in `CLAUDE.md`:

```markdown
- [2026-09-17 browser affinity from bearer](docs/findings/2026-09-17-browser-affinity-from-bearer.md) — `/mcp` had already resolved the bearer before it dug the routing key out of the agent's `session_id`; the key is now computed server-side for `/mcp` and the never-forwarded `POST /rest/browser`, which frees `session_id` to name a tab
```

- [ ] **Step 5: Build the docs site and commit**

Run: `node docs/site/build.mjs`
Expected: no broken-link errors.

```bash
git add docs/site/_content/integrations/browser.md docs/findings/2026-09-17-browser-affinity-from-bearer.md docs/releases/v0.30.0.md CLAUDE.md
git commit -m "docs(browser): tabs, affinity from the bearer, v0.30.0 notes"
```
