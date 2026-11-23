import { describe, it, expect, beforeEach, vi } from "vitest";
import { createContext } from "../src/plugins/context";
import { registry } from "../src/plugins/registry";
import { db } from "../src/db";
import { TokenRefreshError, _setClockForTest } from "../src/auth/token-refresh";

vi.mock("../src/auth/tokens", () => ({
  getToken: vi.fn(),
  storeToken: vi.fn(),
  // createContext reads the per-connection config (self-hosted instance URL)
  // through this. A factory mock replaces the module wholesale, so anything
  // the subject imports must be listed here or the import throws.
  getConnectionConfig: vi.fn(async () => null),
}));

vi.mock("../src/auth/cookie", () => ({
  getCookies: vi.fn(),
  isCookieExpired: vi.fn(() => false),
}));

vi.mock("../src/auth/plugin-oauth", () => ({
  getPluginOAuthCreds: vi.fn(),
  // Passthrough: no self-hosted instance in these tests, so the static
  // manifest URLs are used as-is.
  resolveOAuthUrls: (auth: { authorizationUrl: string; tokenUrl: string }) => ({
    authorizationUrl: auth.authorizationUrl,
    tokenUrl: auth.tokenUrl,
  }),
}));

const mockCookieIntegration = {
  name: "legacy",
  version: "1.0.0",
  auth: {
    type: "cookie" as const,
    targetDomain: "legacy.com",
    cookieDomains: [".legacy.com"],
  },
};

describe("createContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(() => Promise.resolve(new Response("ok"))) as any;
  });

  describe("getToken", () => {
    it("returns access token when connected", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok-123", scopes: "read" });
      const ctx = await createContext("user-1", "slack");
      const token = await ctx.getToken();
      expect(token).toBe("tok-123");
      expect(getToken).toHaveBeenCalledWith("user-1", "slack");
    });

    it("caches token after first call", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok-123", scopes: "read" });
      const ctx = await createContext("user-1", "slack");
      await ctx.getToken();
      await ctx.getToken();
      expect(getToken).toHaveBeenCalledTimes(1);
    });

    it("throws when not connected", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue(null);
      const ctx = await createContext("user-1", "slack");
      await expect(ctx.getToken()).rejects.toThrow("Not connected");
    });
  });

  describe("http with oauth2", () => {
    it("sets Bearer header and calls fetch", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok-123", scopes: "read" });
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "slack",
        version: "1.0.0",
        auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
      });

      const ctx = await createContext("user-1", "slack");
      await ctx.http("https://api.slack.com/test");

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.slack.com/test",
        expect.objectContaining({ headers: expect.any(Headers) })
      );
      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[1].headers.get("Authorization")).toBe("Bearer tok-123");
    });

    it("preserves existing headers", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok-123", scopes: "read" });
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "slack",
        version: "1.0.0",
        auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
      });

      const ctx = await createContext("user-1", "slack");
      await ctx.http("https://api.slack.com/test", { headers: { "X-Custom": "value" } });

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[1].headers.get("X-Custom")).toBe("value");
      expect(callArgs[1].headers.get("Authorization")).toBe("Bearer tok-123");
    });
  });

  describe("http with apikey auth", () => {
    it("sets the manifest headerName to the stored key (no Bearer prefix)", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "nrak-secret", scopes: "" });
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "newrelic",
        version: "1.0.0",
        auth: { type: "apikey" as const, headerName: "Api-Key", fields: [] },
      });

      const ctx = await createContext("user-1", "newrelic");
      await ctx.http("https://api.newrelic.com/graphql", { method: "POST" });

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[0]).toBe("https://api.newrelic.com/graphql");
      expect(callArgs[1].headers.get("Api-Key")).toBe("nrak-secret");
      expect(callArgs[1].headers.get("Authorization")).toBeNull();
      expect(callArgs[1].method).toBe("POST");
    });

    it("throws NOT_CONNECTED when no key is stored", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue(null);
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "newrelic",
        version: "1.0.0",
        auth: { type: "apikey" as const, headerName: "Api-Key", fields: [] },
      });

      const ctx = await createContext("user-1", "newrelic");
      await expect(ctx.http("https://api.newrelic.com/graphql")).rejects.toThrow("NOT_CONNECTED");
    });

    it("attaches the key to a host in allowedHosts", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "nrak-secret", scopes: "" });
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "newrelic",
        version: "1.0.0",
        auth: {
          type: "apikey" as const,
          headerName: "Api-Key",
          fields: [],
          allowedHosts: ["api.newrelic.com", "api.eu.newrelic.com"],
        },
      });

      const ctx = await createContext("user-1", "newrelic");
      await ctx.http("https://api.eu.newrelic.com/graphql", { method: "POST" });

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[1].headers.get("Api-Key")).toBe("nrak-secret");
    });

    it("allows subdomains declared by allowedHosts", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "nrak-secret", scopes: "" });
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "example",
        version: "1.0.0",
        auth: {
          type: "apikey" as const,
          headerName: "X-Key",
          fields: [],
          allowedHosts: ["example.com"],
        },
      });

      const ctx = await createContext("user-1", "example");
      await ctx.http("https://api.example.com/v1");

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[1].headers.get("X-Key")).toBe("nrak-secret");
    });

    it("throws (and never sends the key) for a host outside allowedHosts", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "nrak-secret", scopes: "" });
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "newrelic",
        version: "1.0.0",
        auth: {
          type: "apikey" as const,
          headerName: "Api-Key",
          fields: [],
          allowedHosts: ["api.newrelic.com"],
        },
      });

      const ctx = await createContext("user-1", "newrelic");
      await expect(ctx.http("https://evil.com/steal")).rejects.toThrow(
        "API-key auth: URL host evil.com not in declared allowedHosts"
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("http with cookie auth", () => {
    it("sets Cookie header for allowed domain", async () => {
      const { getCookies } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [{ name: "session", value: "abc", domain: "legacy.com", path: "/" }],
        capturedAt: 1,
      });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration as any);

      const ctx = await createContext("user-1", "legacy");
      await ctx.http("https://legacy.com/api/data");

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[1].headers.get("Cookie")).toBe("session=abc");
      expect(callArgs[1].redirect).toBe("manual");
    });

    it("sends only cookies whose domain matches the target host (browser-like scoping)", async () => {
      // Repro from a multi-subdomain provider: capture sweeps in cookies for
      // sibling hosts (sso.*).
      // Replaying ALL of them to one host bloats the header (nginx 400) and
      // isn't what a browser does. Only host-matching cookies must be sent.
      const { getCookies } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [
          { name: "session", value: "abc", domain: "legacy.com", path: "/" },
          { name: "wide", value: "w", domain: ".legacy.com", path: "/" },
          { name: "foreign", value: "x", domain: "sso.legacy.com", path: "/" },
        ],
        capturedAt: 1,
      });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration as any);

      const ctx = await createContext("user-1", "legacy");
      await ctx.http("https://legacy.com/api/data");

      const callArgs = (global.fetch as any).mock.calls[0];
      // `session` (host-only match) + `wide` (.legacy.com suffix) sent;
      // `foreign` (host-only for sso.legacy.com) excluded.
      expect(callArgs[1].headers.get("Cookie")).toBe("session=abc; wide=w");
    });

    it("allows subdomain via cookieDomains", async () => {
      const { getCookies } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [{ name: "session", value: "abc", domain: ".legacy.com", path: "/" }],
        capturedAt: 1,
      });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration as any);

      const ctx = await createContext("user-1", "legacy");
      await ctx.http("https://app.legacy.com/api/data");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("throws NOT_CONNECTED when no cookies", async () => {
      const { getCookies } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue(null);
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration as any);

      const ctx = await createContext("user-1", "legacy");
      await expect(ctx.http("https://legacy.com/api/data")).rejects.toThrow("NOT_CONNECTED");
    });

    it("throws NOT_CONNECTED when cookies expired", async () => {
      const { getCookies, isCookieExpired } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [{ name: "session", value: "abc", domain: "legacy.com", path: "/", expires: 1 }],
        capturedAt: 1,
      });
      vi.mocked(isCookieExpired).mockReturnValueOnce(true);
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration as any);

      const ctx = await createContext("user-1", "legacy");
      await expect(ctx.http("https://legacy.com/api/data")).rejects.toThrow("NOT_CONNECTED");
    });

    it("throws for foreign domain", async () => {
      const { getCookies } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [{ name: "session", value: "abc", domain: "legacy.com", path: "/" }],
        capturedAt: 1,
      });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration as any);

      const ctx = await createContext("user-1", "legacy");
      await expect(ctx.http("https://evil.com/steal")).rejects.toThrow(
        "Cookie auth: URL host evil.com not in declared cookieDomains"
      );
    });

    it("caches cookie data after first call", async () => {
      const { getCookies } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [{ name: "session", value: "abc", domain: "legacy.com", path: "/" }],
        capturedAt: 1,
      });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration as any);

      const ctx = await createContext("user-1", "legacy");
      await ctx.http("https://legacy.com/api/1");
      await ctx.http("https://legacy.com/api/2");

      expect(getCookies).toHaveBeenCalledTimes(1);
    });

    it("joins multiple cookies with semicolon", async () => {
      const { getCookies } = await import("../src/auth/cookie");
      vi.mocked(getCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [
          { name: "a", value: "1", domain: "legacy.com", path: "/" },
          { name: "b", value: "2", domain: "legacy.com", path: "/" },
        ],
        capturedAt: 1,
      });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration as any);

      const ctx = await createContext("user-1", "legacy");
      await ctx.http("https://legacy.com/api/data");

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[1].headers.get("Cookie")).toBe("a=1; b=2");
    });
  });

  describe("http without integration config", () => {
    it("falls back to Bearer token when integration not in registry", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok-123", scopes: "read" });
      vi.spyOn(registry, "getIntegration").mockReturnValue(undefined);

      const ctx = await createContext("user-1", "unknown");
      await ctx.http("https://api.example.com/test");

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[1].headers.get("Authorization")).toBe("Bearer tok-123");
    });
  });

  describe("token refresh", () => {
    const oauth2Integration = {
      name: "google-gmail",
      version: "1.0.0",
      auth: {
        type: "oauth2" as const,
        tokenUrl: "https://oauth2.googleapis.com/token",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      },
    };

    it("refreshes access token when expiry is within skew window", async () => {
      const { getToken, storeToken } = await import("../src/auth/tokens");
      const { getPluginOAuthCreds } = await import("../src/auth/plugin-oauth");

      vi.spyOn(registry, "getIntegration").mockReturnValue(oauth2Integration);
      vi.mocked(getPluginOAuthCreds).mockReturnValue({ clientId: "cid", clientSecret: "csec" });

      // Stored token already expired.
      const now = Math.floor(Date.now() / 1000);
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "stale",
        refreshToken: "rt-old",
        expiresAt: now - 60,
        scopes: "read",
      });

      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 })
      );
      global.fetch = fetchMock as any;

      const ctx = await createContext("user-1", "google-gmail");
      const token = await ctx.getToken();

      expect(token).toBe("fresh");
      const call = fetchMock.mock.calls[0];
      expect(call[0]).toBe("https://oauth2.googleapis.com/token");
      const body = (call[1] as RequestInit).body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("cid");
      expect(body.get("client_secret")).toBe("csec");
      expect(body.get("refresh_token")).toBe("rt-old");
      expect(storeToken).toHaveBeenCalledWith(
        "user-1",
        "google-gmail",
        expect.objectContaining({ accessToken: "fresh", refreshToken: "rt-old" })
      );
    });

    it("accepts rotated refresh token from response", async () => {
      const { getToken, storeToken } = await import("../src/auth/tokens");
      const { getPluginOAuthCreds } = await import("../src/auth/plugin-oauth");

      vi.spyOn(registry, "getIntegration").mockReturnValue(oauth2Integration);
      vi.mocked(getPluginOAuthCreds).mockReturnValue({ clientId: "cid", clientSecret: "csec" });
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "stale",
        refreshToken: "rt-old",
        expiresAt: 1, // expired
        scopes: "read",
      });

      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ access_token: "fresh", refresh_token: "rt-new", expires_in: 3600 }), {
          status: 200,
        })
      ) as any;

      const ctx = await createContext("user-1", "google-gmail");
      await ctx.getToken();
      expect(storeToken).toHaveBeenCalledWith(
        "user-1",
        "google-gmail",
        expect.objectContaining({ accessToken: "fresh", refreshToken: "rt-new" })
      );
    });

    it("does not refresh when expiry is in the future", async () => {
      const { getToken, storeToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue(oauth2Integration);
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "still-good",
        refreshToken: "rt",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: "read",
      });
      const fetchMock = vi.fn();
      global.fetch = fetchMock as any;

      const ctx = await createContext("user-1", "google-gmail");
      const token = await ctx.getToken();
      expect(token).toBe("still-good");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(storeToken).not.toHaveBeenCalled();
    });

    it("throws if no refresh token stored", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue(oauth2Integration);
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "stale",
        expiresAt: 1,
        scopes: "read",
      });

      const ctx = await createContext("user-1", "google-gmail");
      await expect(ctx.getToken()).rejects.toThrow(/no refresh_token/i);
    });

    it("throws if refresh upstream returns non-OK", async () => {
      const { getToken } = await import("../src/auth/tokens");
      const { getPluginOAuthCreds } = await import("../src/auth/plugin-oauth");
      vi.spyOn(registry, "getIntegration").mockReturnValue(oauth2Integration);
      vi.mocked(getPluginOAuthCreds).mockReturnValue({ clientId: "cid", clientSecret: "csec" });
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "stale",
        refreshToken: "rt",
        expiresAt: 1,
        scopes: "read",
      });
      global.fetch = vi.fn(async () => new Response("invalid_grant", { status: 400 })) as any;

      const ctx = await createContext("user-1", "google-gmail");
      await expect(ctx.getToken()).rejects.toThrow(/Refresh failed 400/);
    });

    it("throws if plugin OAuth creds are not configured", async () => {
      const { getToken } = await import("../src/auth/tokens");
      const { getPluginOAuthCreds } = await import("../src/auth/plugin-oauth");
      vi.spyOn(registry, "getIntegration").mockReturnValue(oauth2Integration);
      vi.mocked(getPluginOAuthCreds).mockReturnValue(null);
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "stale",
        refreshToken: "rt",
        expiresAt: 1,
        scopes: "read",
      });

      const ctx = await createContext("user-1", "google-gmail");
      await expect(ctx.getToken()).rejects.toThrow(/OAuth client not configured/);
    });

    it("refuses to refresh non-oauth2 integrations", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration);
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "stale",
        refreshToken: "rt",
        expiresAt: 1,
        scopes: "read",
      });

      const ctx = await createContext("user-1", "legacy");
      await expect(ctx.getToken()).rejects.toThrow(/Cannot refresh non-oauth2/);
    });
  });

  describe("Atlassian cloud-id resolution", () => {
    const jiraIntegration = {
      name: "atlassian-jira",
      version: "1.0.0",
      auth: {
        type: "oauth2" as const,
        tokenUrl: "https://auth.atlassian.com/oauth/token",
        authorizationUrl: "https://auth.atlassian.com/authorize",
        scopes: ["read:jira-work"],
      },
    };

    it("substitutes cloud-id placeholder for atlassian-jira URLs", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue(jiraIntegration);
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "atok",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: "read:jira-work",
      });

      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/oauth/token/accessible-resources")) {
          return new Response(JSON.stringify([{ id: "abc-cloud-id-123", scopes: ["read:jira-work"] }]), {
            status: 200,
          });
        }
        return new Response("ok", { status: 200 });
      });
      global.fetch = fetchMock as any;

      const ctx = await createContext("user-cid", "atlassian-jira");
      await ctx.http("https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/myself");

      // Last call should be the substituted URL.
      const lastCall = fetchMock.mock.calls.at(-1)!;
      expect(lastCall[0]).toBe(
        "https://api.atlassian.com/ex/jira/abc-cloud-id-123/rest/api/3/myself"
      );
    });

    it("caches the resolved cloud-id across requests", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue(jiraIntegration);
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "atok",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: "read:jira-work",
      });

      let resourcesCalls = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/oauth/token/accessible-resources")) {
          resourcesCalls++;
          return new Response(JSON.stringify([{ id: "cached-id", scopes: ["read:jira-work"] }]), {
            status: 200,
          });
        }
        return new Response("ok", { status: 200 });
      });
      global.fetch = fetchMock as any;

      const ctx = await createContext("user-cache", "atlassian-jira");
      await ctx.http("https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/a");
      await ctx.http("https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/b");

      expect(resourcesCalls).toBe(1);
    });

    it("leaves non-Atlassian URLs untouched", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "google-gmail",
        version: "1.0.0",
        auth: {
          type: "oauth2" as const,
          tokenUrl: "https://oauth2.googleapis.com/token",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          scopes: ["x"],
        },
      });
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "g",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: "x",
      });

      const fetchMock = vi.fn(async () => new Response("ok"));
      global.fetch = fetchMock as any;

      const ctx = await createContext("user-x", "google-gmail");
      await ctx.http("https://gmail.googleapis.com/gmail/v1/users/me/profile");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile"
      );
    });

    it("throws when accessible-resources upstream fails", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue(jiraIntegration);
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "atok",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: "read:jira-work",
      });
      global.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as any;

      const ctx = await createContext("user-err", "atlassian-jira");
      await expect(
        ctx.http("https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/x")
      ).rejects.toThrow(/accessible-resources 500/);
    });

    it("hands back a 401 from accessible-resources as the response (no refresh token to retry with)", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.spyOn(registry, "getIntegration").mockReturnValue(jiraIntegration);
      vi.mocked(getToken).mockResolvedValue({
        accessToken: "atok",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: "read:jira-work",
      });
      global.fetch = vi.fn(async () => new Response("nope", { status: 401 })) as any;

      const ctx = await createContext("user-err-401", "atlassian-jira");
      const res = await ctx.http("https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/x");
      expect(res.status).toBe(401);
    });
  });
});

describe("retry once on 401 with a shared refresh", () => {
  const TOKEN_URL = "https://oauth.example.com/token";
  const API = "https://api.example.com/items";
  const integ = {
    name: "acme",
    version: "1.0.0",
    auth: { type: "oauth2" as const, authorizationUrl: "https://oauth.example.com/auth", tokenUrl: TOKEN_URL, scopes: [] },
  };
  const future = () => Math.floor(Date.now() / 1000) + 3600;

  let stored: any;
  let tokenCalls: number;
  let apiAuth: string[];
  // The API accepts only `accepted`; the token endpoint answers `refreshResponse`.
  let accepted: string;
  let refreshResponse: () => Response;

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.run("DELETE FROM pending_auth WHERE integration = ?", ["__token_refresh__"]);
    _setClockForTest({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const { getToken, storeToken } = await import("../src/auth/tokens");
    const { getPluginOAuthCreds } = await import("../src/auth/plugin-oauth");
    vi.spyOn(registry, "getIntegration").mockReturnValue(integ as any);
    vi.mocked(getPluginOAuthCreds).mockReturnValue({ clientId: "cid", clientSecret: "csec" });
    stored = { accessToken: "stale", refreshToken: "rt-1", expiresAt: future(), scopes: "" };
    vi.mocked(getToken).mockImplementation(async () => ({ ...stored }));
    vi.mocked(storeToken).mockImplementation(async (_u: string, _i: string, d: any) => {
      stored = { ...d };
    });
    tokenCalls = 0;
    apiAuth = [];
    accepted = "fresh";
    refreshResponse = () =>
      new Response(JSON.stringify({ access_token: "fresh", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 });
    global.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url) === TOKEN_URL) {
        tokenCalls++;
        await new Promise((r) => setTimeout(r, 5));
        return refreshResponse();
      }
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      apiAuth.push(auth);
      return auth === `Bearer ${accepted}` ? new Response("ok") : new Response("unauthorized", { status: 401 });
    }) as any;
  });

  it("refreshes and re-sends the same request once", async () => {
    const ctx = await createContext("u1", "acme");
    const res = await ctx.http(API, { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(res.status).toBe(200);
    expect(apiAuth).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(tokenCalls).toBe(1);
    expect(stored).toMatchObject({ accessToken: "fresh", refreshToken: "rt-2" });
  });

  it("returns the second 401 as is: one refresh, no loop", async () => {
    accepted = "never";
    const ctx = await createContext("u1", "acme");
    const res = await ctx.http(API);
    expect(res.status).toBe(401);
    expect(apiAuth).toHaveLength(2);
    expect(tokenCalls).toBe(1);
  });

  it("does not retry without a refresh token, on a 403, or with a stream body", async () => {
    stored.refreshToken = undefined;
    expect((await (await createContext("u1", "acme")).http(API)).status).toBe(401);
    stored.refreshToken = "rt-1";

    (global.fetch as any).mockImplementationOnce(async () => new Response("forbidden", { status: 403 }));
    expect((await (await createContext("u1", "acme")).http(API)).status).toBe(403);

    const stream = new ReadableStream({ start: (c) => c.close() });
    expect((await (await createContext("u1", "acme")).http(API, { method: "POST", body: stream, duplex: "half" } as any)).status).toBe(401);
    expect(tokenCalls).toBe(0);
  });

  it("refreshes once for many concurrent 401s and every call retries with the new token", async () => {
    const ctxs = await Promise.all([1, 2, 3, 4, 5].map(() => createContext("u1", "acme")));
    const results = await Promise.all(ctxs.map((c) => c.http(API)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(tokenCalls).toBe(1);
  });

  it("uses a token another process already refreshed instead of refreshing again", async () => {
    // The API rejects `stale`; by then another pod has stored `fresh`.
    (global.fetch as any).mockImplementationOnce(async () => {
      stored = { ...stored, accessToken: "fresh", refreshToken: "rt-2" };
      return new Response("unauthorized", { status: 401 });
    });
    const res = await (await createContext("u1", "acme")).http(API);
    expect(res.status).toBe(200);
    expect(tokenCalls).toBe(0);
  });

  it("waits on another process's lock and takes its token", async () => {
    const { createHash } = await import("node:crypto");
    const key = "refresh:" + createHash("sha256").update("u1\0acme").digest("hex").slice(0, 40);
    await db.run("INSERT INTO pending_auth (state, user_id, integration, expires_at) VALUES (?, ?, ?, ?)", [
      key,
      "u1",
      "__token_refresh__",
      Math.floor(Date.now() / 1000) + 30,
    ]);
    // The other holder finishes while we poll.
    _setClockForTest({
      sleep: async () => {
        stored = { ...stored, accessToken: "fresh", refreshToken: "rt-2" };
      },
    });
    const res = await (await createContext("u1", "acme")).http(API);
    expect(res.status).toBe(200);
    expect(tokenCalls).toBe(0);
  });

  it("takes over a lock whose holder died", async () => {
    const { createHash } = await import("node:crypto");
    const key = "refresh:" + createHash("sha256").update("u1\0acme").digest("hex").slice(0, 40);
    await db.run("INSERT INTO pending_auth (state, user_id, integration, expires_at) VALUES (?, ?, ?, ?)", [
      key,
      "u1",
      "__token_refresh__",
      Math.floor(Date.now() / 1000) - 5,
    ]);
    const res = await (await createContext("u1", "acme")).http(API);
    expect(res.status).toBe(200);
    expect(tokenCalls).toBe(1);
    const left = await db.get("SELECT 1 AS n FROM pending_auth WHERE state = ?", [key]);
    expect(left).toBeUndefined();
  });

  it("a refused refresh token raises TokenRefreshError (NOT_CONNECTED) and releases the lock", async () => {
    refreshResponse = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const err = await (await createContext("u1", "acme")).http(API).catch((e) => e);
    expect(err).toBeInstanceOf(TokenRefreshError);
    expect(err.code).toBe("NOT_CONNECTED");
    const left = await db.get("SELECT 1 AS n FROM pending_auth WHERE integration = ?", ["__token_refresh__"]);
    expect(left).toBeUndefined();
  });

  it("a token endpoint 5xx stays a plain error (may be transient)", async () => {
    refreshResponse = () => new Response("down", { status: 503 });
    const err = await (await createContext("u1", "acme")).http(API).catch((e) => e);
    expect(err).not.toBeInstanceOf(TokenRefreshError);
    expect(String(err.message)).toMatch(/Refresh failed 503/);
  });

  it("an expired token with no refresh token is NOT_CONNECTED", async () => {
    stored = { accessToken: "stale", expiresAt: 1, scopes: "" };
    const err = await (await createContext("u1", "acme")).getToken().catch((e) => e);
    expect(err).toBeInstanceOf(TokenRefreshError);
  });
});
