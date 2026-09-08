import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildAuthUrl, handleCallback } from "../src/auth/keycloak";
import { db } from "../src/db";
import { jwtVerify, createRemoteJWKSet } from "jose";

vi.mock("../src/config", () => ({
  config: {
    KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/test",
    KEYCLOAK_CLIENT_ID: "test-keycloak-client-id",
    KEYCLOAK_CLIENT_SECRET: "test-keycloak-client-secret",
    PORTAL_URL: "http://localhost:5173",
    SERVER_PUBLIC_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: "./data/tokens.db",
    PLUGINS_DIR: "./plugins",
    AUDIT_LOG_DEST: "sqlite",
    AUDIT_LOG_KAFKA_TOPIC: "audit-log",
  },
}));

vi.mock("jose", () => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(() => "mock-jwks"),
}));

const discoveryDoc = {
  authorization_endpoint: "https://keycloak.example.com/realms/test/protocol/openid-connect/auth",
  token_endpoint: "https://keycloak.example.com/realms/test/protocol/openid-connect/token",
  jwks_uri: "https://keycloak.example.com/realms/test/protocol/openid-connect/certs",
  issuer: "https://keycloak.example.com/realms/test",
};

// The discovery document is cached at module scope in src/auth/keycloak.ts,
// so it may or may not be re-fetched depending on test order (and it's always
// re-fetched after vi.resetModules()). Route by URL instead of relying on call
// order so tests don't depend on that cache's state.
function mockFetchRouting(tokenResponseBody: unknown): void {
  global.fetch = vi.fn((url: string | URL) => {
    const href = url.toString();
    if (href.includes(".well-known")) {
      return Promise.resolve(new Response(JSON.stringify(discoveryDoc)));
    }
    return Promise.resolve(new Response(JSON.stringify(tokenResponseBody)));
  }) as any;
}

beforeEach(async () => {
  await db.exec("DELETE FROM users");
  await db.exec("DELETE FROM pending_auth");
  vi.restoreAllMocks();
  mockFetchRouting({});
});

async function getStateAndNonce(buildFn: typeof buildAuthUrl = buildAuthUrl) {
  const url = await buildFn();
  const parsed = new URL(url);
  return {
    state: parsed.searchParams.get("state")!,
    nonce: parsed.searchParams.get("nonce")!,
  };
}

describe("keycloak auth", () => {
  it("builds auth URL with correct params", async () => {
    const url = await buildAuthUrl();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://keycloak.example.com/realms/test/protocol/openid-connect/auth"
    );
    expect(parsed.searchParams.get("client_id")).toBe("test-keycloak-client-id");
    expect(parsed.searchParams.get("state")).toBeTruthy();
    expect(parsed.searchParams.get("nonce")).toBeTruthy();
    expect(parsed.searchParams.get("scope")).toContain("openid");
  });

  it("rejects invalid state in callback", async () => {
    await expect(handleCallback("code", "invalid-state")).rejects.toThrow("Invalid state");
  });
});

describe("handleCallback", () => {
  it("creates new user on first login", async () => {
    const { state, nonce } = await getStateAndNonce();

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: "kc-123", email: "new@example.com", email_verified: true, nonce },
    } as any);
    mockFetchRouting({ id_token: "id-123", access_token: "acc-456", expires_in: 3600 });

    const result = await handleCallback("code", state);
    expect(result.email).toBe("new@example.com");
    expect(result.userId).toBeTruthy();
  });

  it("links existing user by email", async () => {
    await db.run("INSERT INTO users (id, email, keycloak_sub) VALUES (?, ?, ?)", [
      "user-1",
      "existing@example.com",
      null,
    ]);

    const { state, nonce } = await getStateAndNonce();

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: "kc-456", email: "existing@example.com", email_verified: true, nonce },
    } as any);
    mockFetchRouting({ id_token: "id-123", access_token: "acc-456", expires_in: 3600 });

    const result = await handleCallback("code", state);
    expect(result.userId).toBe("user-1");
    expect(result.email).toBe("existing@example.com");

    const row = await db.get<{ keycloak_sub: string }>("SELECT keycloak_sub FROM users WHERE id = ?", ["user-1"]);
    expect(row?.keycloak_sub).toBe("kc-456");
  });

  it("throws when email not verified", async () => {
    const { state, nonce } = await getStateAndNonce();

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: "kc-789", email: "unverified@example.com", email_verified: false, nonce },
    } as any);
    mockFetchRouting({ id_token: "id-123", access_token: "acc-456", expires_in: 3600 });

    await expect(handleCallback("code", state)).rejects.toThrow("Email not verified");
  });

  it("consumes the pending_auth row: a second callback with the same state fails", async () => {
    const { state, nonce } = await getStateAndNonce();

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: "kc-777", email: "once@example.com", email_verified: true, nonce },
    } as any);
    mockFetchRouting({ id_token: "id-123", access_token: "acc-456", expires_in: 3600 });

    const result = await handleCallback("code", state);
    expect(result.email).toBe("once@example.com");

    await expect(handleCallback("code", state)).rejects.toThrow("Invalid state");
  });

  it("rejects a callback whose ID token nonce doesn't match the stored one", async () => {
    const { state } = await getStateAndNonce();

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: "kc-888", email: "mismatch@example.com", email_verified: true, nonce: "not-the-right-nonce" },
    } as any);
    mockFetchRouting({ id_token: "id-123", access_token: "acc-456", expires_in: 3600 });

    await expect(handleCallback("code", state)).rejects.toThrow("Invalid nonce");
  });

  it("succeeds when the callback is handled by a different server instance (nonce read back from the DB)", async () => {
    const { state, nonce } = await getStateAndNonce();

    // Simulate a restart / a second server instance: drop every module
    // (including src/db) and re-import auth/keycloak fresh. The nonce must
    // survive because it lives in the pending_auth row, not an in-process Map.
    vi.resetModules();
    const freshKeycloak = await import("../src/auth/keycloak");

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: "kc-999", email: "restarted@example.com", email_verified: true, nonce },
    } as any);
    mockFetchRouting({ id_token: "id-123", access_token: "acc-456", expires_in: 3600 });

    const result = await freshKeycloak.handleCallback("code", state);
    expect(result.email).toBe("restarted@example.com");
  });
});
