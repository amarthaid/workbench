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

vi.mock("../src/auth/browser-session", async (orig) => ({
  ...(await orig<typeof import("../src/auth/browser-session")>()),
  captureLiveCookies: vi.fn(),
}));

import { registerApiRoutes } from "../src/api/routes";
import { captureLiveCookies } from "../src/auth/browser-session";
import { verifySession } from "../src/auth/session";
import { verifyApiKey } from "../src/auth/users";
import { reconnectSession } from "../src/auth/reconnect/runner";
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

  it("autoReconnect is present only when a connection row exists (dead rows included)", async () => {
    let list = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
    expect(list.json().connections.find((c: any) => c.name === "acme").autoReconnect).toBeUndefined();
    await storeCookies(USER, "acme", cookieData);
    await updateReconnectState(USER, "acme", { deadAt: 5 });
    list = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
    const row = list.json().connections.find((c: any) => c.name === "acme");
    expect(row.connected).toBe(false); // dead
    expect(row.autoReconnect).toMatchObject({ dead: true }); // still bindable
  });

  it("changing bindings clears a failed attempt's cooldown; an unchanged PUT keeps it", async () => {
    await putSecret(USER, "acme_pw", "pw-abc");
    await storeCookies(USER, "acme", cookieData);
    await updateReconnectState(USER, "acme", { deadAt: 5, last: { at: Date.now(), ok: false, error: "step 1: CREDENTIAL_UNBOUND" } });
    expect((await put({ password: "acme_pw" })).statusCode).toBe(200);
    let st = await getReconnectState(USER, "acme");
    expect(st.last).toBeUndefined();
    expect(st.deadAt).toBe(5);
    await updateReconnectState(USER, "acme", { last: { at: 7, ok: false, error: "verify: PROBE_FAILED" } });
    expect((await put({ password: "acme_pw" })).statusCode).toBe(200);
    st = await getReconnectState(USER, "acme");
    expect(st.last).toMatchObject({ ok: false });
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

  describe("a recorded failure's cooldown: only a portal session may clear it", () => {
    const failed = { at: Date.now(), ok: false, error: "verify: PROBE_FAILED" };
    const importBody = { session: cookieData };
    const withSession = { ...acme, auth: { ...acme.auth, session: { dead: { status: [401] } } } };
    beforeEach(async () => {
      await storeCookies(USER, "acme", cookieData);
      await updateReconnectState(USER, "acme", { deadAt: 5, last: failed });
      vi.mocked(captureLiveCookies).mockResolvedValue(cookieData as any);
    });

    it("import via API key stores cookies but keeps the failure, so the next call is COOLDOWN", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/integrations/acme/session/import",
        headers: { "x-workbench-api-key": "valid-api-key" }, payload: importBody,
      });
      expect(r.statusCode).toBe(200);
      const st = await getReconnectState(USER, "acme");
      expect(st.last).toEqual(failed);
      expect(st.deadAt).toBeUndefined(); // the fresh cookies still end the dead spell
      vi.mocked(registry.getIntegration).mockImplementation((n: string) => (n === "acme" ? withSession : undefined));
      expect(await reconnectSession(USER, "acme")).toEqual({ ok: false, reason: "COOLDOWN" });
    });

    it("import via API key with a valid portal bearer for another user still keeps the failure", async () => {
      vi.mocked(verifyApiKey).mockResolvedValueOnce(USER);
      vi.mocked(verifySession).mockResolvedValueOnce({ userId: "someone-else" } as any);
      await app.inject({
        method: "POST", url: "/api/integrations/acme/session/import",
        headers: { "x-workbench-api-key": "valid-api-key", authorization: "Bearer other-jwt" }, payload: importBody,
      });
      expect((await getReconnectState(USER, "acme")).last).toEqual(failed);
    });

    it("import via portal session clears the failure", async () => {
      const r = await app.inject({ method: "POST", url: "/api/integrations/acme/session/import", headers: auth, payload: importBody });
      expect(r.statusCode).toBe(200);
      expect((await getReconnectState(USER, "acme")).last).toBeUndefined();
    });

    it("capture via portal session clears the failure", async () => {
      const r = await app.inject({ method: "POST", url: "/api/auth/cookie/acme/capture", headers: auth });
      expect(r.statusCode).toBe(200);
      expect((await getReconnectState(USER, "acme")).last).toBeUndefined();
    });

    it("DELETE via API key inside the cooldown is refused and keeps the row (no delete + import reset)", async () => {
      const r = await app.inject({
        method: "DELETE", url: "/api/connections/acme", headers: { "x-workbench-api-key": "valid-api-key" },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe("RECONNECT_COOLDOWN");
      expect((await getReconnectState(USER, "acme")).last).toEqual(failed);
    });

    it("DELETE via API key is allowed once the cooldown is over", async () => {
      await updateReconnectState(USER, "acme", { last: { ...failed, at: Date.now() - 600_001 } });
      const r = await app.inject({
        method: "DELETE", url: "/api/connections/acme", headers: { "x-workbench-api-key": "valid-api-key" },
      });
      expect(r.statusCode).toBe(200);
      expect(await db.get("SELECT 1 AS one FROM connections WHERE user_id = ? AND integration = 'acme'", [USER])).toBeUndefined();
    });

    it("DELETE via portal session inside the cooldown is allowed", async () => {
      const r = await app.inject({ method: "DELETE", url: "/api/connections/acme", headers: auth });
      expect(r.statusCode).toBe(200);
    });

    it("capture via API key keeps the failure", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/auth/cookie/acme/capture", headers: { "x-workbench-api-key": "valid-api-key" },
      });
      expect(r.statusCode).toBe(200);
      expect((await getReconnectState(USER, "acme")).last).toEqual(failed);
    });
  });

  it("integration detail exposes credential slots", async () => {
    const r = await app.inject({ method: "GET", url: "/api/integrations/acme", headers: auth });
    expect(r.json().autoReconnect.credentials.map((c: any) => c.key)).toEqual(["username", "password"]);
    const p = await app.inject({ method: "GET", url: "/api/integrations/plain", headers: auth });
    expect(p.json().autoReconnect).toBeUndefined();
  });
});
