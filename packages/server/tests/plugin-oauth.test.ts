import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  envVarPrefix,
  getPluginOAuthCreds,
  getPluginCallbackUrl,
  buildPluginAuthUrl,
  handlePluginCallback,
  resolveOAuthUrls,
  normalizeInstanceUrl,
} from "../src/auth/plugin-oauth";
import { registry } from "../src/plugins/registry";
import * as oauth from "../src/auth/oauth";
import * as tokens from "../src/auth/tokens";

vi.mock("../src/config", () => ({
  config: {
    SERVER_PUBLIC_URL: "http://localhost:3000",
    PORTAL_URL: "http://localhost:5173",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    PLUGINS_DIR: "./plugins",
    AUDIT_LOG_DEST: "sqlite",
    AUDIT_LOG_KAFKA_TOPIC: "audit-log",
  },
}));

vi.mock("../src/auth/tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/tokens")>();
  return {
    ...actual,
    storeToken: vi.fn(),
  };
});

const mockIntegration = {
  name: "google-gmail",
  version: "1.0.0",
  auth: {
    type: "oauth2" as const,
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  },
};

const mockSlackIntegration = {
  name: "slack",
  version: "1.0.0",
  auth: {
    type: "oauth2" as const,
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: ["chat:write", "channels:read"],
  },
};

const mockGitlabIntegration = {
  name: "gitlab",
  version: "1.0.0",
  auth: {
    type: "oauth2" as const,
    authorizationUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    scopes: ["api"],
    instance: {
      label: "GitLab instance URL",
      placeholder: "https://gitlab.example.com",
      default: "https://gitlab.com",
    },
  },
};

const mockCookieIntegration = {
  name: "legacy-app",
  version: "1.0.0",
  auth: {
    type: "cookie" as const,
    loginUrl: "https://example.com/login",
    targetDomain: "example.com",
  },
};

describe("envVarPrefix", () => {
  it("converts kebab to upper snake", () => {
    expect(envVarPrefix("google-gmail")).toBe("GOOGLE_GMAIL");
    expect(envVarPrefix("atlassian-jira")).toBe("ATLASSIAN_JIRA");
    expect(envVarPrefix("github")).toBe("GITHUB");
  });
});

describe("getPluginOAuthCreds", () => {
  beforeEach(() => {
    delete process.env.GOOGLE_GMAIL_CLIENT_ID;
    delete process.env.GOOGLE_GMAIL_CLIENT_SECRET;
  });

  it("returns creds when env vars are set", () => {
    process.env.GOOGLE_GMAIL_CLIENT_ID = "gmail-id";
    process.env.GOOGLE_GMAIL_CLIENT_SECRET = "gmail-secret";
    const creds = getPluginOAuthCreds("google-gmail");
    expect(creds).toEqual({ clientId: "gmail-id", clientSecret: "gmail-secret" });
  });

  it("returns null when client id is missing", () => {
    process.env.GOOGLE_GMAIL_CLIENT_SECRET = "gmail-secret";
    expect(getPluginOAuthCreds("google-gmail")).toBeNull();
  });

  it("returns public-client creds (no secret) when client secret is missing", () => {
    process.env.GOOGLE_GMAIL_CLIENT_ID = "gmail-id";
    expect(getPluginOAuthCreds("google-gmail")).toEqual({
      clientId: "gmail-id",
      clientSecret: undefined,
    });
  });

  it("treats an empty-string secret as a public client", () => {
    process.env.GOOGLE_GMAIL_CLIENT_ID = "gmail-id";
    process.env.GOOGLE_GMAIL_CLIENT_SECRET = "";
    expect(getPluginOAuthCreds("google-gmail")).toEqual({
      clientId: "gmail-id",
      clientSecret: undefined,
    });
  });

  it("returns null when both are missing", () => {
    expect(getPluginOAuthCreds("google-gmail")).toBeNull();
  });
});

describe("normalizeInstanceUrl", () => {
  it("reduces a URL to its origin", () => {
    expect(normalizeInstanceUrl("https://gitlab.acme.com/some/path?x=1")).toBe(
      "https://gitlab.acme.com"
    );
  });
  it("keeps a non-default port", () => {
    expect(normalizeInstanceUrl("https://gl.acme.com:8443")).toBe("https://gl.acme.com:8443");
  });
  it("rejects http (secret rides the token POST — https only)", () => {
    expect(normalizeInstanceUrl("http://gitlab.internal")).toBeNull();
  });
  it("rejects userinfo-bearing URLs", () => {
    expect(normalizeInstanceUrl("https://user:pass@gitlab.acme.com")).toBeNull();
  });
  it("rejects private/loopback/link-local literals (SSRF)", () => {
    expect(normalizeInstanceUrl("https://127.0.0.1")).toBeNull();
    expect(normalizeInstanceUrl("https://localhost")).toBeNull();
    expect(normalizeInstanceUrl("https://10.0.0.5")).toBeNull();
    expect(normalizeInstanceUrl("https://172.16.0.1")).toBeNull();
    expect(normalizeInstanceUrl("https://192.168.1.1")).toBeNull();
    expect(normalizeInstanceUrl("https://169.254.169.254")).toBeNull();
    expect(normalizeInstanceUrl("https://[::1]")).toBeNull();
  });
  it("rejects non-http(s) and garbage", () => {
    expect(normalizeInstanceUrl("ftp://x")).toBeNull();
    expect(normalizeInstanceUrl("not a url")).toBeNull();
  });
});

describe("resolveOAuthUrls", () => {
  it("returns the static URLs when no instance support", () => {
    expect(resolveOAuthUrls(mockIntegration.auth)).toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
  });
  it("defaults to the cloud host when no config is stored", () => {
    expect(resolveOAuthUrls(mockGitlabIntegration.auth)).toEqual({
      authorizationUrl: "https://gitlab.com/oauth/authorize",
      tokenUrl: "https://gitlab.com/oauth/token",
    });
  });
  it("swaps in the self-hosted origin while keeping the paths", () => {
    const cfg = JSON.stringify({ instanceUrl: "https://gitlab.acme.com" });
    expect(resolveOAuthUrls(mockGitlabIntegration.auth, cfg)).toEqual({
      authorizationUrl: "https://gitlab.acme.com/oauth/authorize",
      tokenUrl: "https://gitlab.acme.com/oauth/token",
    });
  });
});

describe("getPluginCallbackUrl", () => {
  it("builds callback url with integration name", () => {
    expect(getPluginCallbackUrl("google-gmail")).toBe(
      "http://localhost:3000/api/auth/plugin/google-gmail/callback"
    );
  });
});

describe("buildPluginAuthUrl", () => {
  beforeEach(() => {
    // vi.spyOn returns the existing spy when the method is already spied, so
    // call history accumulates across tests in this block. These assertions
    // read mock.calls[0] and mean "the call this test made".
    process.env.GOOGLE_GMAIL_CLIENT_ID = "gmail-id";
    process.env.GOOGLE_GMAIL_CLIENT_SECRET = "gmail-secret";
    vi.spyOn(registry, "getIntegration").mockReturnValue(mockIntegration);
    vi.spyOn(oauth, "createAuthState").mockResolvedValue("test-state");
  });

  it("builds auth url with all required params", async () => {
    const url = await buildPluginAuthUrl("user-1", "google-gmail");
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("accounts.google.com");
    expect(parsed.searchParams.get("client_id")).toBe("gmail-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/plugin/google-gmail/callback"
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(parsed.searchParams.get("state")).toBe("test-state");
  });

  it("includes an S256 PKCE challenge derived from the stored verifier", async () => {
    const url = await buildPluginAuthUrl("user-1", "google-gmail");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    const verifier = vi.mocked(oauth.createAuthState).mock.calls[0][2];
    expect(verifier).toBeTruthy();
    expect(parsed.searchParams.get("code_challenge")).toBe(
      oauth.codeChallengeS256(verifier!)
    );
  });

  it("adds google-specific extra params", async () => {
    const url = await buildPluginAuthUrl("user-1", "google-gmail");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("include_granted_scopes")).toBe("true");
  });

  it("throws when integration not found", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue(undefined);
    await expect(buildPluginAuthUrl("user-1", "unknown")).rejects.toThrow("Integration not found: unknown");
  });

  it("throws when integration is not oauth2", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration);
    await expect(buildPluginAuthUrl("user-1", "legacy-app")).rejects.toThrow(
      "Integration legacy-app is not oauth2"
    );
  });

  it("throws when creds not configured", async () => {
    delete process.env.GOOGLE_GMAIL_CLIENT_ID;
    delete process.env.GOOGLE_GMAIL_CLIENT_SECRET;
    await expect(buildPluginAuthUrl("user-1", "google-gmail")).rejects.toThrow(
      "OAuth client not configured for google-gmail"
    );
  });

  it("sends slack scopes as user_scope so tokens act as the user, not a bot", async () => {
    process.env.SLACK_CLIENT_ID = "slack-id";
    process.env.SLACK_CLIENT_SECRET = "slack-secret";
    vi.spyOn(registry, "getIntegration").mockReturnValue(mockSlackIntegration);
    const url = await buildPluginAuthUrl("user-1", "slack");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("user_scope")).toBe("chat:write channels:read");
    expect(parsed.searchParams.get("scope")).toBeNull();
  });

  it("does not add extra params for non-google plugins", async () => {
    const nonGoogleIntegration = {
      ...mockIntegration,
      name: "github",
      auth: {
        ...mockIntegration.auth,
        authorizationUrl: "https://github.com/login/oauth/authorize",
      },
    };
    process.env.GITHUB_CLIENT_ID = "github-id";
    process.env.GITHUB_CLIENT_SECRET = "github-secret";
    vi.spyOn(registry, "getIntegration").mockReturnValue(nonGoogleIntegration);
    const url = await buildPluginAuthUrl("user-1", "github");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("access_type")).toBeNull();
    expect(parsed.searchParams.get("prompt")).toBeNull();
  });
});

describe("buildPluginAuthUrl — self-hosted instance", () => {
  beforeEach(() => {
    process.env.GITLAB_CLIENT_ID = "gl-id";
    process.env.GITLAB_CLIENT_SECRET = "gl-secret";
    process.env.GITLAB_ALLOWED_INSTANCES = "https://gitlab.acme.com";
    vi.spyOn(registry, "getIntegration").mockReturnValue(mockGitlabIntegration);
    vi.spyOn(oauth, "createAuthState").mockResolvedValue("test-state");
  });
  afterEach(() => {
    delete process.env.GITLAB_ALLOWED_INSTANCES;
  });

  it("targets an allowlisted instance host and persists it in the state config", async () => {
    const url = await buildPluginAuthUrl("user-1", "gitlab", "https://gitlab.acme.com");
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("gitlab.acme.com");
    expect(parsed.pathname).toBe("/oauth/authorize");
    const configArg = vi.mocked(oauth.createAuthState).mock.calls[0][3];
    expect(JSON.parse(configArg!)).toEqual({ instanceUrl: "https://gitlab.acme.com" });
  });

  it("falls back to the cloud default when no instance URL is given", async () => {
    const url = await buildPluginAuthUrl("user-1", "gitlab");
    expect(new URL(url).hostname).toBe("gitlab.com");
    const configArg = vi.mocked(oauth.createAuthState).mock.calls[0][3];
    expect(JSON.parse(configArg!)).toEqual({ instanceUrl: "https://gitlab.com" });
  });

  it("allows the cloud default even with no allowlist env", async () => {
    delete process.env.GITLAB_ALLOWED_INSTANCES;
    expect(new URL(await buildPluginAuthUrl("user-1", "gitlab", "https://gitlab.com")).hostname).toBe(
      "gitlab.com"
    );
  });

  it("rejects a non-allowlisted instance (client-secret exfil guard)", async () => {
    await expect(buildPluginAuthUrl("user-1", "gitlab", "https://attacker.example")).rejects.toThrow(
      /Instance not allowed/
    );
  });

  it("rejects an invalid instance URL", async () => {
    await expect(buildPluginAuthUrl("user-1", "gitlab", "not a url")).rejects.toThrow(/Invalid instance URL/);
  });

  it("rejects an http instance URL", async () => {
    await expect(buildPluginAuthUrl("user-1", "gitlab", "http://gitlab.acme.com")).rejects.toThrow(
      /Invalid instance URL/
    );
  });
});

describe("handlePluginCallback", () => {
  // Assertions below read mock.calls[0] meaning "the call this test made".
  // That holds because vitest.config.ts sets clearMocks — from vitest 4,
  // vi.spyOn returns the already-installed spy, so history would otherwise
  // carry across tests in this block.
  beforeEach(() => {
    process.env.GOOGLE_GMAIL_CLIENT_ID = "gmail-id";
    process.env.GOOGLE_GMAIL_CLIENT_SECRET = "gmail-secret";
    vi.spyOn(registry, "getIntegration").mockReturnValue(mockIntegration);
    vi.spyOn(oauth, "verifyAuthState").mockResolvedValue({
      userId: "user-1",
      integration: "google-gmail",
    });
    vi.spyOn(oauth, "exchangeCode").mockResolvedValue({
      access_token: "access-123",
      refresh_token: "refresh-456",
      expires_in: 3600,
    });
    vi.spyOn(tokens, "storeToken").mockResolvedValue(undefined);
  });

  it("exchanges code and stores token", async () => {
    const result = await handlePluginCallback("google-gmail", "auth-code", "valid-state");
    expect(result).toEqual({ userId: "user-1" });
    expect(oauth.exchangeCode).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      "gmail-id",
      "gmail-secret",
      "auth-code",
      "http://localhost:3000/api/auth/plugin/google-gmail/callback",
      undefined
    );
    expect(tokens.storeToken).toHaveBeenCalledWith(
      "user-1",
      "google-gmail",
      expect.objectContaining({
        accessToken: "access-123",
        refreshToken: "refresh-456",
        scopes: "https://www.googleapis.com/auth/gmail.modify",
      })
    );
  });

  it("passes the stored PKCE verifier to the token exchange", async () => {
    vi.spyOn(oauth, "verifyAuthState").mockResolvedValue({
      userId: "user-1",
      integration: "google-gmail",
      codeVerifier: "stored-verifier",
    });
    await handlePluginCallback("google-gmail", "auth-code", "valid-state");
    expect(oauth.exchangeCode).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      "gmail-id",
      "gmail-secret",
      "auth-code",
      "http://localhost:3000/api/auth/plugin/google-gmail/callback",
      "stored-verifier"
    );
  });

  it("calculates expiresAt from expires_in", async () => {
    const before = Math.floor(Date.now() / 1000);
    await handlePluginCallback("google-gmail", "auth-code", "valid-state");
    const after = Math.floor(Date.now() / 1000);
    expect(tokens.storeToken).toHaveBeenCalledWith(
      "user-1",
      "google-gmail",
      expect.objectContaining({
        expiresAt: expect.any(Number),
      })
    );
    const callArgs = (tokens.storeToken as any).mock.calls[0][2];
    expect(callArgs.expiresAt).toBeGreaterThanOrEqual(before + 3600);
    expect(callArgs.expiresAt).toBeLessThanOrEqual(after + 3600);
  });

  it("rejects invalid state", async () => {
    vi.spyOn(oauth, "verifyAuthState").mockResolvedValue(null);
    await expect(handlePluginCallback("google-gmail", "code", "bad-state")).rejects.toThrow(
      "Invalid state"
    );
  });

  it("rejects state for wrong integration", async () => {
    vi.spyOn(oauth, "verifyAuthState").mockResolvedValue({
      userId: "user-1",
      integration: "google-drive",
    });
    await expect(handlePluginCallback("google-gmail", "code", "valid-state")).rejects.toThrow(
      "Invalid state"
    );
  });

  it("throws when integration not found", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue(undefined);
    await expect(handlePluginCallback("google-gmail", "code", "state")).rejects.toThrow(
      "Integration not configured for OAuth"
    );
  });

  it("throws when integration is not oauth2", async () => {
    vi.spyOn(oauth, "verifyAuthState").mockResolvedValue({
      userId: "user-1",
      integration: "legacy-app",
    });
    vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieIntegration);
    await expect(handlePluginCallback("legacy-app", "code", "state")).rejects.toThrow(
      "Integration not configured for OAuth"
    );
  });

  it("throws when creds not configured", async () => {
    delete process.env.GOOGLE_GMAIL_CLIENT_ID;
    delete process.env.GOOGLE_GMAIL_CLIENT_SECRET;
    await expect(handlePluginCallback("google-gmail", "code", "state")).rejects.toThrow(
      "OAuth client not configured for google-gmail"
    );
  });

  describe("slack user-token extraction", () => {
    beforeEach(() => {
        process.env.SLACK_CLIENT_ID = "slack-id";
      process.env.SLACK_CLIENT_SECRET = "slack-secret";
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockSlackIntegration);
      vi.spyOn(oauth, "verifyAuthState").mockResolvedValue({
        userId: "user-1",
        integration: "slack",
      });
    });

    it("stores the authed_user token, not the top-level bot token", async () => {
      vi.spyOn(oauth, "exchangeCode").mockResolvedValue({
        ok: true,
        access_token: "xoxb-bot-token",
        authed_user: {
          id: "U123",
          access_token: "xoxp-user-token",
          token_type: "user",
        },
      } as any);
      await handlePluginCallback("slack", "code", "state");
      expect(tokens.storeToken).toHaveBeenCalledWith(
        "user-1",
        "slack",
        expect.objectContaining({
          accessToken: "xoxp-user-token",
          refreshToken: undefined,
          expiresAt: undefined,
        })
      );
    });

    it("uses authed_user refresh_token and expires_in when token rotation is on", async () => {
      vi.spyOn(oauth, "exchangeCode").mockResolvedValue({
        ok: true,
        authed_user: {
          id: "U123",
          access_token: "xoxe.xoxp-user-token",
          refresh_token: "xoxe-refresh",
          expires_in: 43200,
        },
      } as any);
      const before = Math.floor(Date.now() / 1000);
      await handlePluginCallback("slack", "code", "state");
      const callArgs = (tokens.storeToken as any).mock.calls[0][2];
      expect(callArgs.accessToken).toBe("xoxe.xoxp-user-token");
      expect(callArgs.refreshToken).toBe("xoxe-refresh");
      expect(callArgs.expiresAt).toBeGreaterThanOrEqual(before + 43200);
    });

    it("throws when slack responds ok:false", async () => {
      vi.spyOn(oauth, "exchangeCode").mockResolvedValue({
        ok: false,
        error: "invalid_code",
      } as any);
      await expect(handlePluginCallback("slack", "code", "state")).rejects.toThrow(
        "invalid_code"
      );
    });

    it("throws when authed_user token is missing", async () => {
      vi.spyOn(oauth, "exchangeCode").mockResolvedValue({
        ok: true,
        access_token: "xoxb-bot-only",
      } as any);
      await expect(handlePluginCallback("slack", "code", "state")).rejects.toThrow(
        /user token/i
      );
    });
  });

  it("self-hosted: exchanges against the instance token URL and stores the config", async () => {
    process.env.GITLAB_CLIENT_ID = "gl-id";
    process.env.GITLAB_CLIENT_SECRET = "gl-secret";
    vi.spyOn(registry, "getIntegration").mockReturnValue(mockGitlabIntegration);
    vi.spyOn(oauth, "verifyAuthState").mockResolvedValue({
      userId: "user-1",
      integration: "gitlab",
      config: JSON.stringify({ instanceUrl: "https://gitlab.acme.com" }),
    });
    vi.spyOn(oauth, "exchangeCode").mockResolvedValue({ access_token: "a", refresh_token: "r" });
    await handlePluginCallback("gitlab", "code", "state");
    expect(oauth.exchangeCode).toHaveBeenCalledWith(
      "https://gitlab.acme.com/oauth/token",
      "gl-id",
      "gl-secret",
      "code",
      "http://localhost:3000/api/auth/plugin/gitlab/callback",
      undefined
    );
    expect(tokens.storeToken).toHaveBeenCalledWith(
      "user-1",
      "gitlab",
      expect.objectContaining({
        accessToken: "a",
        config: JSON.stringify({ instanceUrl: "https://gitlab.acme.com" }),
      })
    );
  });

  it("handles tokens without expires_in", async () => {
    vi.spyOn(oauth, "exchangeCode").mockResolvedValue({
      access_token: "access-123",
    });
    await handlePluginCallback("google-gmail", "code", "state");
    expect(tokens.storeToken).toHaveBeenCalledWith(
      "user-1",
      "google-gmail",
      expect.objectContaining({
        expiresAt: undefined,
      })
    );
  });
});
