import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../src/auth/session", () => ({
  signSession: vi.fn(() => "signed"),
  verifySession: vi.fn(async (token: string) => {
    if (token === "valid-jwt") return { userId: "user-rc", email: "dev@example.com" };
    throw new Error("Invalid token");
  }),
}));
vi.mock("../src/auth/users", async (orig) => ({
  ...(await orig<typeof import("../src/auth/users")>()),
  verifyApiKey: vi.fn(async (key: string) => (key === "valid-api-key" ? "user-rc" : null)),
}));

import { registerApiRoutes } from "../src/api/routes";
import { stopReaper } from "../src/auth/connections";
import { registry } from "../src/plugins/registry";
import { storeCookies } from "../src/auth/cookie";
import { putSecret } from "../src/vault/store";
import { getReconnectState, updateReconnectState } from "../src/auth/reconnect/state";
import { db } from "../src/db";
import { signAccessToken } from "../src/auth/oauth-server/tokens";

const USER = "user-rc";
const auth = { authorization: "Bearer valid-jwt" };
const cookieData = {
  domain: "app.example.com",
  cookies: [{ name: "sid", value: "tok-abc", domain: "app.example.com", path: "/", expires: 9999999999 }],
  capturedAt: 1,
};
const acme = {
  name: "acme", version: "1", displayName: "Acme", description: "d", categories: [],
  auth: {
    type: "cookie", loginUrl: "https://app.example.com/login", targetDomain: "app.example.com",
    cookieDomains: ["app.example.com"],
    reconnect: {
      credentials: [{ key: "username", label: "Username" }, { key: "password", label: "Password", secret: true }],
      steps: [{ goto: "loginUrl" }],
    },
  },
} as any;
const plain = {
  name: "plain", version: "1", displayName: "Plain", description: "d", categories: [],
  auth: { type: "cookie", loginUrl: "https://p.example.com/login", targetDomain: "p.example.com", cookieDomains: ["p.example.com"] },
} as any;

let app: FastifyInstance;

beforeEach(async () => {
  await db.run("DELETE FROM connections WHERE user_id = ?", [USER]);
  await db.run("DELETE FROM user_vaults WHERE user_id = ?", [USER]);
  vi.spyOn(registry, "getIntegration").mockImplementation((n: string) => (n === "acme" ? acme : n === "plain" ? plain : undefined));
  vi.spyOn(registry, "listIntegrations").mockReturnValue([acme, plain]);
  app = Fastify();
  await registerApiRoutes(app);
  await app.ready();
});
afterAll(() => stopReaper());

const put = (bindings: unknown, headers: Record<string, string> = auth, integration = "acme") =>
  app.inject({ method: "PUT", url: `/api/connections/${integration}/reconnect`, headers, payload: { bindings } as any });

describe("auto-reconnect bindings API", () => {
  it("PUT bindings stores names and GET /api/connections reports them", async () => {
    await putSecret(USER, "acme_pw", "pw-abc");
    await storeCookies(USER, "acme", cookieData);
    const r = await put({ password: "acme_pw" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true });
    const list = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
    const row = list.json().connections.find((c: any) => c.name === "acme");
    expect(row.autoReconnect).toMatchObject({ bindings: { password: "acme_pw" }, missing: ["username"], dead: false });
    expect(list.body).not.toContain("pw-abc");
    const plainRow = list.json().connections.find((c: any) => c.name === "plain");
    expect(plainRow.autoReconnect).toBeUndefined();
  });

  it("reports dead and last", async () => {
    await storeCookies(USER, "acme", cookieData);
    await updateReconnectState(USER, "acme", { deadAt: 5, last: { at: 6, ok: false, error: "TIMEOUT" } });
    const list = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
    const row = list.json().connections.find((c: any) => c.name === "acme");
    expect(row.autoReconnect).toMatchObject({ dead: true, last: { at: 6, ok: false, error: "TIMEOUT" }, missing: ["username", "password"] });
  });

  it("rejects an undeclared key", async () => {
    await putSecret(USER, "acme_pw", "pw-abc");
    await storeCookies(USER, "acme", cookieData);
    expect((await put({ token: "acme_pw" })).statusCode).toBe(400);
  });

  it("rejects a vault name the user does not have", async () => {
    await storeCookies(USER, "acme", cookieData);
    const r = await put({ password: "nope" });
    expect(r.statusCode).toBe(400);
    expect((await getReconnectState(USER, "acme")).bindings).toBeUndefined();
  });

  it("rejects a non-object body", async () => {
    await storeCookies(USER, "acme", cookieData);
    expect((await put(["x"])).statusCode).toBe(400);
  });

  it("404 for an integration without a recipe", async () => {
    expect((await put({ password: "x" }, auth, "plain")).statusCode).toBe(404);
  });

  it("409 before the integration is connected", async () => {
    await putSecret(USER, "acme_pw", "pw-abc");
    expect((await put({ password: "acme_pw" })).statusCode).toBe(409);
  });

  it("empty string unbinds", async () => {
    await putSecret(USER, "acme_pw", "pw-abc");
    await storeCookies(USER, "acme", cookieData);
    await put({ password: "acme_pw" });
    expect((await put({ password: "" })).statusCode).toBe(200);
    expect((await getReconnectState(USER, "acme")).bindings).toEqual({});
  });

  it("requires a portal session: no auth 401, API key 403, nothing written", async () => {
    await putSecret(USER, "acme_pw", "pw-abc");
    await storeCookies(USER, "acme", cookieData);
    const anon = await put({ password: "acme_pw" }, {});
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["www-authenticate"]).toContain("Bearer");
    const oauth = await signAccessToken({ userId: USER, scope: "mcp", clientId: "c1" });
    const viaOauth = await put({ password: "acme_pw" }, { authorization: `Bearer ${oauth}` });
    expect(viaOauth.statusCode).toBe(403);
    expect(viaOauth.json().error).toBe("PORTAL_SESSION_REQUIRED");
    const viaKey = await put({ password: "acme_pw" }, { "x-workbench-api-key": "valid-api-key" });
    // Same as the vault: an API-key header alone is not a session (401), never accepted.
    expect(viaKey.statusCode).toBe(401);
    expect((await getReconnectState(USER, "acme")).bindings).toBeUndefined();
  });

  it("integration detail exposes credential slots", async () => {
    const r = await app.inject({ method: "GET", url: "/api/integrations/acme", headers: auth });
    expect(r.json().autoReconnect.credentials.map((c: any) => c.key)).toEqual(["username", "password"]);
    const p = await app.inject({ method: "GET", url: "/api/integrations/plain", headers: auth });
    expect(p.json().autoReconnect).toBeUndefined();
  });
});
