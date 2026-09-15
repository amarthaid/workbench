import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Fastify from "fastify";
import { registerApiRoutes } from "../src/api/routes";
import { db } from "../src/db";
import { registry } from "../src/plugins/registry";
import { signConnectToken } from "../src/auth/connect-token";
import { stopReaper, createPending, getPending, _clearAll } from "../src/auth/connections";

vi.mock("../src/config", () => ({
  config: {
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    PORTAL_URL: "http://localhost:5173",
    CONNECT_TTL_SECONDS: 600,
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    PLUGINS_DIR: "./plugins",
    AUDIT_LOG_DEST: "sqlite",
    AUDIT_LOG_KAFKA_TOPIC: "audit-log",
    SERVER_PUBLIC_URL: "http://localhost:3000",
  },
}));

vi.mock("../src/auth/google", () => ({
  buildAuthUrl: vi.fn(() => "https://accounts.google.com/oauth?test=1"),
  handleCallback: vi.fn(),
}));

vi.mock("../src/auth/keycloak", () => ({
  isKeycloakConfigured: vi.fn(() => true),
  buildAuthUrl: vi.fn(() => "https://keycloak.example.com/oauth?test=1"),
  handleCallback: vi.fn(),
}));

vi.mock("../src/auth/plugin-oauth", () => ({
  buildPluginAuthUrl: vi.fn(() => "https://example.com/oauth?plugin=1"),
  handlePluginCallback: vi.fn(),
  getPluginOAuthCreds: vi.fn(() => ({ clientId: "id", clientSecret: "secret" })),
}));

vi.mock("../src/auth/session", () => ({
  signSession: vi.fn(() => "signed-jwt-token"),
  verifySession: vi.fn((token: string) => {
    if (token === "valid-jwt") return { userId: "user-1", email: "test@example.com" };
    if (token === "other-jwt") return { userId: "user-2", email: "other@example.com" };
    throw new Error("Invalid token");
  }),
}));

vi.mock("../src/auth/users", () => ({
  verifyApiKey: vi.fn((key: string) => (key === "valid-api-key" ? "user-1" : null)),
  getUserById: vi.fn((id: string) =>
    id === "user-1" ? { id: "user-1", email: "test@example.com" } : null
  ),
  setApiKey: vi.fn(() => ({ apiKey: "minted-key-123" })),
  getApiKey: vi.fn(() => "revealed-key-123"),
  clearApiKey: vi.fn(),
  hasApiKey: vi.fn(() => false),
}));

vi.mock("../src/auth/tokens", () => ({
  getToken: vi.fn(() => null),
  deleteToken: vi.fn(),
  storeToken: vi.fn(),
}));

vi.mock("../src/auth/cookie", async () => {
  const real = await vi.importActual<typeof import("../src/auth/cookie")>("../src/auth/cookie");
  return {
    closeCookieSession: vi.fn(() => Promise.resolve()),
    storeCookies: vi.fn(),
    getCookies: vi.fn(() => null),
    hasValidCookies: vi.fn(() => false),
    deleteCookies: vi.fn(),
    resetBrowserProfile: vi.fn(() => Promise.resolve()),
    // Real expiry logic: drives the smart-capture "already logged in?" branch.
    isCookieExpired: real.isCookieExpired,
  };
});

vi.mock("../src/auth/oauth", () => ({
  createAuthState: vi.fn(() => "test-state"),
}));

vi.mock("../src/auth/browser-session", async () => {
  const real = await vi.importActual<typeof import("../src/auth/browser-session")>("../src/auth/browser-session");
  return {
    ...real,
    ensureSession: vi.fn(() => Promise.resolve({ cdpToken: "tok-123", userId: "user-1" })),
    captureLiveCookies: vi.fn(),
    navigate: vi.fn(() => Promise.resolve({ url: "https://x.test", title: "X" })),
  };
});

vi.mock("../src/auth/connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/connections")>();
  return {
    ...actual,
    startReaper: vi.fn(),
    stopReaper: vi.fn(),
    markConnected: vi.fn(),
  };
});

async function buildApp() {
  const app = Fastify();
  await registerApiRoutes(app);
  return app;
}

// Seeds a pending_auth row shaped like one /authorize would have created, so a
// callback's state=`<base>.<ticket>` can resume it — mirrors oauth-resume.test.ts.
async function seedOAuthAuthorizeTicket(ticket: string, binding: string) {
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
    [
      ticket, "", "__oauth_authorize__", now + 600,
      JSON.stringify({
        clientId: "c1", redirectUri: "http://127.0.0.1:33418/cb",
        codeChallenge: "challenge", scope: "mcp", state: "client-state", resource: "http://x/mcp",
        binding,
      }),
    ]
  );
}

describe("API routes", () => {
  beforeEach(() => {
    db.exec("DELETE FROM users");
    db.exec("DELETE FROM pending_auth");
    vi.clearAllMocks();
  });

  afterAll(() => {
    stopReaper();
  });

  describe("GET /api/auth/google", () => {
    it("returns auth URL when configured", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/google" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).url).toContain("accounts.google.com");
    });

    it("returns 503 when not configured", async () => {
      const { config } = await import("../src/config");
      const original = config.GOOGLE_CLIENT_ID;
      config.GOOGLE_CLIENT_ID = undefined;
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/google" });
      expect(res.statusCode).toBe(503);
      config.GOOGLE_CLIENT_ID = original;
    });

    it("threads a ?ticket= through to buildAuthUrl so the choice page can carry an /authorize flow", async () => {
      const { buildAuthUrl } = await import("../src/auth/google");
      const app = await buildApp();
      await app.inject({ method: "GET", url: "/api/auth/google?ticket=tkt-abc" });
      expect(vi.mocked(buildAuthUrl)).toHaveBeenCalledWith("tkt-abc");
    });

    it("omits the ticket when none is given", async () => {
      const { buildAuthUrl } = await import("../src/auth/google");
      const app = await buildApp();
      await app.inject({ method: "GET", url: "/api/auth/google" });
      expect(vi.mocked(buildAuthUrl)).toHaveBeenCalledWith(undefined);
    });
  });

  describe("GET /api/auth/google/callback", () => {
    it("redirects with token on success", async () => {
      const { handleCallback } = await import("../src/auth/google");
      vi.mocked(handleCallback).mockResolvedValue({ userId: "user-1", email: "test@example.com" });
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/google/callback?code=abc&state=xyz" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("token=signed-jwt-token");
    });

    it("returns 400 on provider error", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/google/callback?error=access_denied" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("access_denied");
    });

    it("returns 400 when code missing", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/google/callback?state=xyz" });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 on callback failure", async () => {
      const { handleCallback } = await import("../src/auth/google");
      vi.mocked(handleCallback).mockRejectedValue(new Error("Invalid state"));
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/google/callback?code=abc&state=xyz" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("Invalid state");
    });

    it("resumes a pending /authorize ticket instead of a normal portal login", async () => {
      const { handleCallback } = await import("../src/auth/google");
      vi.mocked(handleCallback).mockResolvedValue({ userId: "user-1", email: "test@example.com" });
      await seedOAuthAuthorizeTicket("tkt-google", "bind-google");
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/google/callback?code=abc&state=base.tkt-google",
        headers: { cookie: "awb_oauth_binding=bind-google" },
      });
      expect(res.statusCode).toBe(302);
      const redirect = new URL(res.headers.location as string);
      expect(redirect.origin + redirect.pathname).toBe("http://127.0.0.1:33418/cb");
      expect(redirect.searchParams.get("code")).toBeTruthy();
    });
  });

  describe("GET /api/auth/keycloak", () => {
    it("returns auth URL when configured", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/keycloak" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).url).toContain("keycloak.example.com");
    });

    it("returns 503 when not configured", async () => {
      const { isKeycloakConfigured } = await import("../src/auth/keycloak");
      vi.mocked(isKeycloakConfigured).mockReturnValueOnce(false);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/keycloak" });
      expect(res.statusCode).toBe(503);
    });

    it("threads a ?ticket= through to buildAuthUrl so the choice page can carry an /authorize flow", async () => {
      const { buildAuthUrl } = await import("../src/auth/keycloak");
      const app = await buildApp();
      await app.inject({ method: "GET", url: "/api/auth/keycloak?ticket=tkt-abc" });
      expect(vi.mocked(buildAuthUrl)).toHaveBeenCalledWith("tkt-abc");
    });

    it("omits the ticket when none is given", async () => {
      const { buildAuthUrl } = await import("../src/auth/keycloak");
      const app = await buildApp();
      await app.inject({ method: "GET", url: "/api/auth/keycloak" });
      expect(vi.mocked(buildAuthUrl)).toHaveBeenCalledWith(undefined);
    });
  });

  describe("GET /api/auth/keycloak/callback", () => {
    it("redirects with token on success", async () => {
      const { handleCallback } = await import("../src/auth/keycloak");
      vi.mocked(handleCallback).mockResolvedValue({ userId: "user-1", email: "test@example.com" });
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/keycloak/callback?code=abc&state=xyz" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("token=signed-jwt-token");
    });

    it("returns 400 on provider error", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/keycloak/callback?error=access_denied" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("access_denied");
    });

    it("resumes a pending /authorize ticket instead of a normal portal login", async () => {
      const { handleCallback } = await import("../src/auth/keycloak");
      vi.mocked(handleCallback).mockResolvedValue({ userId: "user-1", email: "test@example.com" });
      await seedOAuthAuthorizeTicket("tkt-keycloak", "bind-keycloak");
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/keycloak/callback?code=abc&state=base.tkt-keycloak",
        headers: { cookie: "awb_oauth_binding=bind-keycloak" },
      });
      expect(res.statusCode).toBe(302);
      const redirect = new URL(res.headers.location as string);
      expect(redirect.origin + redirect.pathname).toBe("http://127.0.0.1:33418/cb");
      expect(redirect.searchParams.get("code")).toBeTruthy();
    });
  });

  describe("/api/keys", () => {
    it("mints a key (shown once) with valid JWT", async () => {
      const { setApiKey } = await import("../src/auth/users");
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/keys",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ apiKey: "minted-key-123" });
      expect(vi.mocked(setApiKey)).toHaveBeenCalledWith("user-1");
    });

    it("rejects minting without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/keys" });
      expect(res.statusCode).toBe(401);
    });

    it("reports key status", async () => {
      const { hasApiKey } = await import("../src/auth/users");
      vi.mocked(hasApiKey).mockResolvedValueOnce(true);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/keys",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ hasKey: true });
    });

    it("reveals the stored key", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/keys/reveal",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ apiKey: "revealed-key-123" });
    });

    it("404s reveal when no key set", async () => {
      const { getApiKey } = await import("../src/auth/users");
      vi.mocked(getApiKey).mockResolvedValueOnce(null);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/keys/reveal",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects reveal without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/keys/reveal" });
      expect(res.statusCode).toBe(401);
    });

    it("revokes the key", async () => {
      const { clearApiKey } = await import("../src/auth/users");
      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/keys",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });
      expect(vi.mocked(clearApiKey)).toHaveBeenCalledWith("user-1");
    });

    it("rejects revoke without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/api/keys" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns user profile with valid JWT", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: "user-1", email: "test@example.com" });
    });

    it("returns user profile with valid API key (x-workbench-api-key header)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { "x-workbench-api-key": "valid-api-key" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects API key sent via Authorization Bearer", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: "Bearer valid-api-key" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for unknown user", async () => {
      const { getUserById } = await import("../src/auth/users");
      vi.mocked(getUserById).mockResolvedValue(null);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("returns success", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
    });
  });

  describe("GET /api/integrations", () => {
    it("returns integrations for authenticated user", async () => {
      vi.spyOn(registry, "listIntegrations").mockReturnValue([
        { name: "slack", version: "1.0.0", auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] } },
        // The built-in browser is a registry plugin like any other now.
        { name: "browser", version: "1.0.0", auth: { type: "none" as const } },
      ]);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/integrations",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      const list = JSON.parse(res.body).integrations;
      expect(list).toHaveLength(2);
      expect(list.map((i: { name: string }) => i.name)).toContain("slack");
      const browser = list.find((i: { name: string }) => i.name === "browser");
      expect(browser).toMatchObject({ name: "browser", configured: true, authType: "none" });
    });

    it("returns 401 without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/integrations" });
      expect(res.statusCode).toBe(401);
    });

    it("reports configured flag per auth type", async () => {
      const { getPluginOAuthCreds } = await import("../src/auth/plugin-oauth");
      // cookie -> always; oauth2 -> only when creds present; none -> always
      // (built-in capability, nothing to configure).
      vi.mocked(getPluginOAuthCreds).mockImplementation((n: string) =>
        n === "oauth-ready" ? { clientId: "id", clientSecret: "secret" } : null
      );
      vi.spyOn(registry, "listIntegrations").mockReturnValue([
        { name: "cookie-x", version: "1.0.0", auth: { type: "cookie" as const, targetDomain: "x.test", cookieDomains: ["x.test"] } },
        { name: "oauth-ready", version: "1.0.0", auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] } },
        { name: "oauth-bare", version: "1.0.0", auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] } },
        { name: "builtin", version: "1.0.0", auth: { type: "none" as const } },
      ] as never);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET", url: "/api/integrations",
        headers: { authorization: "Bearer valid-jwt" },
      });
      const list = JSON.parse(res.body).integrations as { name: string; configured: boolean }[];
      const by = (n: string) => list.find((i) => i.name === n)?.configured;
      expect(by("cookie-x")).toBe(true);
      expect(by("oauth-ready")).toBe(true);
      expect(by("oauth-bare")).toBe(false);
      expect(by("builtin")).toBe(true);
    });

    it("includes presentation metadata + tool count + resolved logo", async () => {
      vi.spyOn(registry, "listIntegrations").mockReturnValue([
        {
          name: "slack", version: "1.0.0",
          displayName: "Slack", description: "Team chat",
          logo: "logo.svg", categories: ["comms"],
          auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
        },
        {
          name: "acme", version: "2.0.0", logo: "https://cdn.acme.test/l.png",
          auth: { type: "none" as const },
        },
      ]);
      vi.spyOn(registry, "listToolsByIntegration").mockImplementation((n: string) =>
        n === "slack" ? ([{ name: "a" }, { name: "b" }] as never) : []
      );
      const app = await buildApp();
      const res = await app.inject({
        method: "GET", url: "/api/integrations",
        headers: { authorization: "Bearer valid-jwt" },
      });
      const list = JSON.parse(res.body).integrations;
      const slack = list.find((i: { name: string }) => i.name === "slack");
      const acme = list.find((i: { name: string }) => i.name === "acme");
      expect(slack).toMatchObject({
        displayName: "Slack", description: "Team chat", categories: ["comms"], toolCount: 2,
      });
      // bundled filename -> served via endpoint; full URL -> passed through.
      expect(slack.logo).toBe("/api/integrations/slack/logo");
      expect(acme.logo).toBe("https://cdn.acme.test/l.png");
    });
  });

  describe("GET /api/integrations/:integration (detail)", () => {
    it("returns integration meta + its tools", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "slack", version: "1.0.0", displayName: "Slack",
        auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
      });
      vi.spyOn(registry, "listToolsByIntegration").mockReturnValue([
        { name: "slack_post", description: "Post a message" } as never,
      ]);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET", url: "/api/integrations/slack",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("slack");
      expect(body.tools).toEqual([{ name: "slack_post", description: "Post a message" }]);
    });

    it("returns the built-in browser integration from the registry", async () => {
      const { browserPlugin } = await import("../src/plugins/internal/browser");
      vi.spyOn(registry, "getIntegration").mockReturnValue(browserPlugin.integration);
      vi.spyOn(registry, "listToolsByIntegration").mockReturnValue(browserPlugin.tools);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET", url: "/api/integrations/browser",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("browser");
      expect(body.authType).toBe("none");
      expect(body.tools.every((t: { name: string }) => t.name.startsWith("browser_"))).toBe(true);
    });

    it("404s for unknown integration", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(undefined);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET", url: "/api/integrations/nope",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("401 without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/integrations/slack" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/auth/:integration", () => {
    const mockOauthInteg = {
      name: "slack",
      version: "1.0.0",
      auth: { type: "oauth2" as const, authorizationUrl: "https://slack.com/oauth", tokenUrl: "https://slack.com/token", scopes: ["chat:write"] },
    };

    const mockCookieInteg = {
      name: "legacy",
      version: "1.0.0",
      auth: { type: "cookie" as const, loginUrl: "https://legacy.com/login", targetDomain: "legacy.com", cookieDomains: [] },
    };

    it("returns oauth2 URL for oauth2 integration", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/slack",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).type).toBe("oauth2");
      expect(JSON.parse(res.body).url).toBeDefined();
    });

    it("always returns login_required + live-view info, even when live cookies exist", async () => {
      const { captureLiveCookies, navigate } = await import("../src/auth/browser-session");
      const { storeCookies } = await import("../src/auth/cookie");
      const { markConnected } = await import("../src/auth/connections");
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieInteg);
      // Even with plenty of live cookies present, connect must NOT auto-connect.
      vi.mocked(captureLiveCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [{ name: "s", value: "v", expires: Math.floor(Date.now() / 1000) + 86400 }],
        capturedAt: Math.floor(Date.now() / 1000),
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/legacy",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.type).toBe("cookie");
      expect(body.status).toBe("login_required");
      expect(body.cdpProxyUrl).toBe("/api/auth/cookie/legacy/cdp");
      expect(body.cdpToken).toBeUndefined();
      expect(body.loginUrl).toBe("https://legacy.com/login");
      expect(navigate).toHaveBeenCalled();
      // No auto-connect on the connect path.
      expect(storeCookies).not.toHaveBeenCalled();
      expect(markConnected).not.toHaveBeenCalled();
    });

    it("returns login_required + live-view info when no live cookies", async () => {
      const { navigate } = await import("../src/auth/browser-session");
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieInteg);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/legacy",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.type).toBe("cookie");
      expect(body.status).toBe("login_required");
      expect(body.cdpProxyUrl).toBe("/api/auth/cookie/legacy/cdp");
      expect(body.cdpToken).toBeUndefined();
      expect(body.loginUrl).toBe("https://legacy.com/login");
      expect(navigate).toHaveBeenCalled();
    });

    it("reports built-in (none) auth as already connected", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "browser",
        version: "1.0.0",
        auth: { type: "none" as const },
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/browser",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ type: "none", connected: true });
    });

    it("returns the field spec for apikey auth", async () => {
      const fields = [
        { key: "apiKey", label: "API Key", secret: true },
        { key: "region", label: "Region", options: ["US", "EU"] },
      ];
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "keyed",
        version: "1.0.0",
        auth: { type: "apikey" as const, headerName: "X-Key", fields },
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/keyed",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ type: "apikey", fields });
    });

    it("stores secret as token and other fields as config on apikey submit", async () => {
      const { storeToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "newrelic",
        version: "1.0.0",
        auth: {
          type: "apikey" as const,
          headerName: "Api-Key",
          fields: [
            { key: "apiKey", label: "API Key", secret: true },
            { key: "region", label: "Region", options: ["US", "EU"] },
          ],
        },
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/apikey/newrelic",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { values: { apiKey: "nrak-secret", region: "EU" } },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });
      expect(storeToken).toHaveBeenCalledWith("user-1", "newrelic", {
        accessToken: "nrak-secret",
        scopes: "",
        config: JSON.stringify({ region: "EU" }),
      });
    });

    it("rejects apikey submit with a missing required field", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "newrelic",
        version: "1.0.0",
        auth: {
          type: "apikey" as const,
          headerName: "Api-Key",
          fields: [
            { key: "apiKey", label: "API Key", secret: true },
            { key: "region", label: "Region", options: ["US", "EU"] },
          ],
        },
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/apikey/newrelic",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { values: { apiKey: "nrak-secret" } },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects apikey submit when an enum field is out of range", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "newrelic",
        version: "1.0.0",
        auth: {
          type: "apikey" as const,
          headerName: "Api-Key",
          fields: [
            { key: "apiKey", label: "API Key", secret: true },
            { key: "region", label: "Region", options: ["US", "EU"] },
          ],
        },
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/apikey/newrelic",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { values: { apiKey: "nrak-secret", region: "APAC" } },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/slack" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for unknown integration", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(undefined);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/unknown",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 503 when oauth client not configured", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg);
      const { buildPluginAuthUrl } = await import("../src/auth/plugin-oauth");
      // Once, not persistent: clearAllMocks() between tests clears call history
      // but not implementations, so a non-"Once" override here would leak into
      // every later test that calls buildPluginAuthUrl.
      vi.mocked(buildPluginAuthUrl).mockImplementationOnce(() => {
        throw new Error("OAuth client not configured for slack");
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/slack",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(503);
    });
  });

  describe("GET /api/auth/plugin/:integration/callback", () => {
    // Every exit from this route is a redirect to the portal's result page
    // carrying a status code. The provider's own error text and any exception
    // message stay server-side: they are attacker-influenced and end up in a
    // URL the human sees.
    const RESULT = "http://localhost:5173/connected/slack";

    it("redirects to the result page with status=ok on success", async () => {
      const { handlePluginCallback } = await import("../src/auth/plugin-oauth");
      vi.mocked(handlePluginCallback).mockResolvedValue({ userId: "user-1" });
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/plugin/slack/callback?code=abc&state=xyz" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${RESULT}?status=ok`);
    });

    it("redirects with status=denied when the human rejected the consent screen", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/plugin/slack/callback?error=access_denied" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${RESULT}?status=denied`);
    });

    it("redirects with status=failed on any other provider error", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/plugin/slack/callback?error=server_error" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${RESULT}?status=failed`);
    });

    it("keeps the provider's error text out of the redirect", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/plugin/slack/callback?error=" + encodeURIComponent("tenant acme-internal is not entitled"),
      });
      expect(res.headers.location).toBe(`${RESULT}?status=failed`);
      expect(res.headers.location).not.toContain("acme-internal");
    });

    it("redirects with status=failed when code or state is missing", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/plugin/slack/callback?code=abc" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${RESULT}?status=failed`);
    });

    it("redirects with status=expired when the pending row is gone", async () => {
      const { handlePluginCallback } = await import("../src/auth/plugin-oauth");
      vi.mocked(handlePluginCallback).mockRejectedValue(new Error("Invalid state"));
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/plugin/slack/callback?code=abc&state=xyz" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${RESULT}?status=expired`);
    });

    it("redirects with status=failed on any other handler error, without leaking the message", async () => {
      const { handlePluginCallback } = await import("../src/auth/plugin-oauth");
      vi.mocked(handlePluginCallback).mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:443"));
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/plugin/slack/callback?code=abc&state=xyz" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${RESULT}?status=failed`);
      expect(res.headers.location).not.toContain("10.1.2.3");
    });

    it("cannot be steered off the portal origin by the integration path param", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/plugin/..%2F..%2Fevil.example.com/callback?error=access_denied",
      });
      expect(res.statusCode).toBe(302);
      expect(new URL(res.headers.location as string).origin).toBe("http://localhost:5173");
    });
  });

  describe("POST /api/auth/cookie/:integration/capture", () => {
    const cookieInteg = {
      name: "legacy",
      version: "1.0.0",
      auth: { type: "cookie" as const, loginUrl: "https://legacy.com/login", targetDomain: "legacy.com", cookieDomains: [] },
    };

    it("captures live cookies and connects", async () => {
      const { captureLiveCookies } = await import("../src/auth/browser-session");
      const { storeCookies } = await import("../src/auth/cookie");
      const { markConnected } = await import("../src/auth/connections");
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      vi.mocked(captureLiveCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [{ name: "s", value: "v" }],
        capturedAt: 1,
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/cookie/legacy/capture",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true, cookieCount: 1 });
      expect(storeCookies).toHaveBeenCalled();
      expect(markConnected).toHaveBeenCalledWith("user-1", "legacy");
    });

    it("returns 401 without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/cookie/legacy/capture",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for a non-cookie / unknown integration", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(undefined);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/cookie/legacy/capture",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 on capture error", async () => {
      const { captureLiveCookies } = await import("../src/auth/browser-session");
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      vi.mocked(captureLiveCookies).mockRejectedValue(new Error("No browser session for user"));
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/cookie/legacy/capture",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("No browser session for user");
    });

    it("returns 400 on zero cookies and does not store/markConnected", async () => {
      const { captureLiveCookies } = await import("../src/auth/browser-session");
      const { storeCookies } = await import("../src/auth/cookie");
      const { markConnected } = await import("../src/auth/connections");
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      vi.mocked(captureLiveCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [],
        capturedAt: 1,
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/cookie/legacy/capture",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("No cookies");
      expect(storeCookies).not.toHaveBeenCalled();
      expect(markConnected).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/auth/cookie/:integration/cancel", () => {
    it("dismisses without tearing down the session", async () => {
      const { closeCookieSession } = await import("../src/auth/cookie");
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/cookie/legacy/cancel",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });
      // No teardown — the shared session may be driven by browser-use.
      expect(closeCookieSession).not.toHaveBeenCalled();
    });

    it("returns 401 without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/cookie/legacy/cancel",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("connect endpoints", () => {
    const mockCookieIntegForConnect = {
      name: "legacy",
      version: "1.0.0",
      auth: {
        type: "cookie" as const,
        loginUrl: "https://legacy.com/login",
        targetDomain: "legacy.com",
        cookieDomains: [],
      },
    };

    it("GET /api/connect/session no longer exists", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/connect/session",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/connect/capture captures when session and link agree", async () => {
      const { captureLiveCookies } = await import("../src/auth/browser-session");
      const { storeCookies } = await import("../src/auth/cookie");
      const { markConnected } = await import("../src/auth/connections");
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegForConnect);
      vi.mocked(captureLiveCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [{ name: "x", value: "y" }],
        capturedAt: Math.floor(Date.now() / 1000),
      });
      const token = await signConnectToken(
        { connectionId: "c1", userId: "user-1", integration: "legacy", sessionId: "user-1" },
        600
      );
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/capture",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().cookieCount).toBe(1);
      expect(storeCookies).toHaveBeenCalledWith("user-1", "legacy", expect.objectContaining({ cookies: [{ name: "x", value: "y" }] }));
      expect(markConnected).toHaveBeenCalledWith("user-1", "legacy");
    });

    it("POST /api/connect/capture 403s when the session is a different user", async () => {
      const { captureLiveCookies } = await import("../src/auth/browser-session");
      const { storeCookies } = await import("../src/auth/cookie");
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegForConnect);
      const token = await signConnectToken(
        { connectionId: "c1", userId: "user-1", integration: "legacy", sessionId: "user-1" },
        600
      );
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/capture",
        headers: { authorization: "Bearer other-jwt" },
        payload: { token },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("ACCOUNT_MISMATCH");
      // The gate must not depend on redeem having run first.
      expect(captureLiveCookies).not.toHaveBeenCalled();
      expect(storeCookies).not.toHaveBeenCalled();
    });

    it("POST /api/connect/capture 401s with a valid link but no session", async () => {
      const token = await signConnectToken(
        { connectionId: "c1", userId: "user-1", integration: "legacy", sessionId: "user-1" },
        600
      );
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/connect/capture", payload: { token } });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("AUTH_REQUIRED");
    });

    it("POST /api/connect/capture 401s on a bad token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/capture",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { token: "garbage" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("LINK_INVALID");
    });

    it("POST /api/connect/capture 400s on zero cookies and does not store/markConnected", async () => {
      const { captureLiveCookies } = await import("../src/auth/browser-session");
      const { storeCookies } = await import("../src/auth/cookie");
      const { markConnected } = await import("../src/auth/connections");
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegForConnect);
      vi.mocked(captureLiveCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [],
        capturedAt: 1,
      });
      const token = await signConnectToken(
        { connectionId: "c1", userId: "user-1", integration: "legacy", sessionId: "user-1" },
        600
      );
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/capture",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { token },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("No cookies");
      expect(storeCookies).not.toHaveBeenCalled();
      expect(markConnected).not.toHaveBeenCalled();
    });

    it("GET /api/connect/browser-session no longer exists", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/connect/browser-session?t=anything",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/browser-session/live-url", () => {
    it("mints a /browser link, navigating when a url is given", async () => {
      const { navigate } = await import("../src/auth/browser-session");
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/browser-session/live-url",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { url: "https://x.test" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).url).toMatch(/\/browser\?t=/);
      expect(navigate).toHaveBeenCalled();
    });

    it("skips navigation when no url is given", async () => {
      const { navigate } = await import("../src/auth/browser-session");
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/browser-session/live-url",
        headers: { authorization: "Bearer valid-jwt" },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(navigate).not.toHaveBeenCalled();
    });

    it("rejects a non-http url", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/browser-session/live-url",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { url: "ftp://x.test" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("401 without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/browser-session/live-url", payload: {} });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/connections", () => {
    it("reports the built-in browser as always connected", async () => {
      vi.spyOn(registry, "listIntegrations").mockReturnValue([
        { name: "browser", version: "1.0.0", auth: { type: "none" as const } },
      ]);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      const conns = JSON.parse(res.body).connections;
      expect(conns).toContainEqual({ name: "browser", connected: true });
    });

    it("returns connection status for oauth2 integrations", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });
      vi.spyOn(registry, "listIntegrations").mockReturnValue([
        { name: "slack", version: "1.0.0", auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] } },
      ]);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).connections[0].connected).toBe(true);
    });

    it("returns connection status for cookie integrations", async () => {
      const { hasValidCookies } = await import("../src/auth/cookie");
      vi.mocked(hasValidCookies).mockResolvedValue(true);
      vi.spyOn(registry, "listIntegrations").mockReturnValue([
        { name: "legacy", version: "1.0.0", auth: { type: "cookie" as const, loginUrl: "", targetDomain: "" } },
      ]);
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).connections[0].connected).toBe(true);
    });

    it("returns 401 without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/connections" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("DELETE /api/connections/:integration", () => {
    it("deletes the OAuth token for an oauth2 integration", async () => {
      const { deleteToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "slack",
        version: "1.0.0",
        auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
      } as any);
      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/connections/slack",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(vi.mocked(deleteToken)).toHaveBeenCalledWith("user-1", "slack");
    });

    it("deletes cookies for a cookie integration", async () => {
      const { deleteCookies } = await import("../src/auth/cookie");
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "legacy",
        version: "1.0.0",
        auth: { type: "cookie" as const, loginUrl: "", targetDomain: "" },
      } as any);
      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/connections/legacy",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(deleteCookies)).toHaveBeenCalledWith("user-1", "legacy");
    });

    it("returns 400 for the built-in browser", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "browser", version: "1.0.0", auth: { type: "none" as const },
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/connections/browser",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for an unknown integration", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(undefined);
      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/connections/nope",
        headers: { authorization: "Bearer valid-jwt" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/api/connections/slack" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/browser-session/reset", () => {
    const apiKey = { "x-workbench-api-key": "valid-api-key" };

    it("resets the caller's browser profile", async () => {
      const { resetBrowserProfile } = await import("../src/auth/cookie");
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/browser-session/reset", headers: apiKey });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(vi.mocked(resetBrowserProfile)).toHaveBeenCalledWith("user-1");
    });

    it("401s without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/browser-session/reset" });
      expect(res.statusCode).toBe(401);
    });

    it("409s when a session is busy", async () => {
      const { resetBrowserProfile } = await import("../src/auth/cookie");
      vi.mocked(resetBrowserProfile).mockRejectedValueOnce(new Error("BROWSER_SESSION_BUSY: x"));
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/browser-session/reset", headers: apiKey });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("session export/import", () => {
    const cookieInteg = {
      name: "legacy",
      version: "1.0.0",
      auth: { type: "cookie" as const, loginUrl: "https://legacy.com/login", targetDomain: "legacy.com" },
    };
    const bundle = { domain: "legacy.com", cookies: [{ name: "s", value: "v", domain: "legacy.com", path: "/" }], capturedAt: 1 };
    const apiKey = { "x-workbench-api-key": "valid-api-key" };

    it("exports the stored cookie bundle for a cookie integration", async () => {
      const { getCookies } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue(bundle as any);
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/integrations/legacy/session/export", headers: apiKey });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.integration).toBe("legacy");
      expect(body.session.cookies[0].name).toBe("s");
    });

    it("404s export when no session stored", async () => {
      const { getCookies } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue(null);
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/integrations/legacy/session/export", headers: apiKey });
      expect(res.statusCode).toBe(404);
    });

    it("401s export without auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/integrations/legacy/session/export" });
      expect(res.statusCode).toBe(401);
    });

    it("imports a cookie bundle and stores it", async () => {
      const { storeCookies } = await import("../src/auth/cookie");
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/integrations/legacy/session/import",
        headers: { ...apiKey, "content-type": "application/json" },
        payload: { session: bundle },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).cookieCount).toBe(1);
      expect(vi.mocked(storeCookies)).toHaveBeenCalledWith("user-1", "legacy", expect.objectContaining({ cookies: bundle.cookies }));
    });

    it("imports a bare cookie array under session (auto-wrapped)", async () => {
      const { storeCookies } = await import("../src/auth/cookie");
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/integrations/legacy/session/import",
        headers: { ...apiKey, "content-type": "application/json" },
        payload: { session: bundle.cookies },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).cookieCount).toBe(1);
      expect(vi.mocked(storeCookies)).toHaveBeenCalledWith("user-1", "legacy", expect.objectContaining({ cookies: bundle.cookies }));
    });

    it("imports a bare cookie array at the body root (auto-wrapped)", async () => {
      const { storeCookies } = await import("../src/auth/cookie");
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/integrations/legacy/session/import",
        headers: { ...apiKey, "content-type": "application/json" },
        payload: bundle.cookies,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).cookieCount).toBe(1);
      expect(vi.mocked(storeCookies)).toHaveBeenCalledWith("user-1", "legacy", expect.objectContaining({ cookies: bundle.cookies }));
    });

    it("400s import of an empty array", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/integrations/legacy/session/import",
        headers: { ...apiKey, "content-type": "application/json" },
        payload: [],
      });
      expect(res.statusCode).toBe(400);
    });

    it("400s import of an empty/invalid bundle", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/integrations/legacy/session/import",
        headers: { ...apiKey, "content-type": "application/json" },
        payload: { session: { domain: "legacy.com", cookies: [], capturedAt: 1 } },
      });
      expect(res.statusCode).toBe(400);
    });

    it("404s import for a non-cookie integration", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "slack",
        version: "1.0.0",
        auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/integrations/slack/session/import",
        headers: { ...apiKey, "content-type": "application/json" },
        payload: { session: bundle },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/connect/redeem", () => {
    const cookieInteg = {
      name: "legacy",
      version: "1.0.0",
      auth: {
        type: "cookie" as const,
        loginUrl: "https://legacy.example.com/login",
        targetDomain: "legacy.example.com",
        cookieDomains: [],
      },
    };

    async function mintLink(userId: string, integration: string, connectionId: string) {
      return signConnectToken({ connectionId, userId, integration, sessionId: userId }, 600);
    }

    beforeEach(() => {
      _clearAll();
    });

    it("returns cookie login details when the session owns the link", async () => {
      const { ensureSession, navigate } = await import("../src/auth/browser-session");
      vi.mocked(ensureSession).mockResolvedValue({ cdpToken: "cdp-1" } as never);
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg as never);
      const rec = createPending({ userId: "user-1", integration: "legacy", type: "cookie", ttlSeconds: 600 });
      const token = await mintLink("user-1", "legacy", rec.connectionId);

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/redeem",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { token },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.type).toBe("cookie");
      expect(body.integration).toBe("legacy");
      expect(body.loginUrl).toBe("https://legacy.example.com/login");
      expect(body.cdpProxyUrl).toBe("/api/auth/cookie/legacy/cdp");
      // Nothing identifying rides along: the live view authenticates with the
      // portal bearer, and the bridge mints its own per-user routing key.
      expect(body.sessionId).toBeUndefined();
      expect(body.cdpToken).toBeUndefined();
      expect(navigate).toHaveBeenCalled();
    });

    it("403s ACCOUNT_MISMATCH and does no work when a different user redeems", async () => {
      const { ensureSession } = await import("../src/auth/browser-session");
      vi.mocked(ensureSession).mockResolvedValue({ cdpToken: "cdp-1" } as never);
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg as never);
      const rec = createPending({ userId: "user-1", integration: "legacy", type: "cookie", ttlSeconds: 600 });
      const token = await mintLink("user-1", "legacy", rec.connectionId);

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/redeem",
        headers: { authorization: "Bearer other-jwt" },
        payload: { token },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("ACCOUNT_MISMATCH");
      expect(res.json().integration).toBe("legacy");
      // No side effects: no browser session warmed, and the link is not spent.
      expect(ensureSession).not.toHaveBeenCalled();
      expect(getPending(rec.connectionId)!.redeemedAt).toBeUndefined();
    });

    it("401s AUTH_REQUIRED with no session, without spending the link", async () => {
      const rec = createPending({ userId: "user-1", integration: "legacy", type: "cookie", ttlSeconds: 600 });
      const token = await mintLink("user-1", "legacy", rec.connectionId);

      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/connect/redeem", payload: { token } });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("AUTH_REQUIRED");
      expect(getPending(rec.connectionId)!.redeemedAt).toBeUndefined();
    });

    it("401s LINK_INVALID on a garbage link token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/redeem",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { token: "not-a-jwt" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("LINK_INVALID");
    });

    it("410s LINK_CONSUMED for a valid link whose pending record is gone", async () => {
      // A valid, well-signed JWT but no matching pending record — e.g. the
      // server restarted and the in-memory pending store was lost.
      const token = await mintLink("user-1", "legacy", "connection-never-registered");

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/redeem",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { token },
      });

      expect(res.statusCode).toBe(410);
      expect(res.json().error).toBe("LINK_CONSUMED");
    });

    it("410s LINK_CONSUMED on a second redemption", async () => {
      const { ensureSession } = await import("../src/auth/browser-session");
      vi.mocked(ensureSession).mockResolvedValue({ cdpToken: "cdp-1" } as never);
      vi.spyOn(registry, "getIntegration").mockReturnValue(cookieInteg as never);
      const rec = createPending({ userId: "user-1", integration: "legacy", type: "cookie", ttlSeconds: 600 });
      const token = await mintLink("user-1", "legacy", rec.connectionId);

      const app = await buildApp();
      const headers = { authorization: "Bearer valid-jwt" };
      const first = await app.inject({ method: "POST", url: "/api/connect/redeem", headers, payload: { token } });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url: "/api/connect/redeem", headers, payload: { token } });
      expect(second.statusCode).toBe(410);
      expect(second.json().error).toBe("LINK_CONSUMED");
    });

    it("returns the provider URL for an oauth2 link, built only after the match", async () => {
      const { buildPluginAuthUrl } = await import("../src/auth/plugin-oauth");
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "github",
        version: "1.0.0",
        auth: { type: "oauth2" as const, scopes: ["repo"] },
      } as never);
      const rec = createPending({ userId: "user-1", integration: "github", type: "oauth2", ttlSeconds: 600 });
      const token = await mintLink("user-1", "github", rec.connectionId);

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/redeem",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { token },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().type).toBe("oauth2");
      expect(res.json().url).toBe("https://example.com/oauth?plugin=1");
      expect(buildPluginAuthUrl).toHaveBeenCalledWith("user-1", "github");
    });

    it("does not build a provider URL when the redeemer is the wrong user", async () => {
      const { buildPluginAuthUrl } = await import("../src/auth/plugin-oauth");
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "github",
        version: "1.0.0",
        auth: { type: "oauth2" as const, scopes: ["repo"] },
      } as never);
      const rec = createPending({ userId: "user-1", integration: "github", type: "oauth2", ttlSeconds: 600 });
      const token = await mintLink("user-1", "github", rec.connectionId);

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/redeem",
        headers: { authorization: "Bearer other-jwt" },
        payload: { token },
      });

      expect(res.statusCode).toBe(403);
      expect(buildPluginAuthUrl).not.toHaveBeenCalled();
    });

    it("returns browser-session details for a __browser__ link", async () => {
      const { ensureSession } = await import("../src/auth/browser-session");
      vi.mocked(ensureSession).mockResolvedValue({ cdpToken: "cdp-1" } as never);
      const rec = createPending({ userId: "user-1", integration: "__browser__", type: "cookie", ttlSeconds: 600 });
      const token = await mintLink("user-1", "__browser__", rec.connectionId);

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connect/redeem",
        headers: { authorization: "Bearer valid-jwt" },
        payload: { token },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        type: "browser",
        cdpProxyUrl: "/api/browser-session/cdp",
      });
      // The link redeem still warms the browser on this replica.
      expect(ensureSession).toHaveBeenCalledWith("user-1");
    });
  });
});
