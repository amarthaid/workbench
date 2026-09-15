import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config", () => ({
  config: { SESSION_SECRET: "test-session-secret-32-chars-long!!", SERVER_PUBLIC_URL: "http://localhost:3000", OAUTH_ACCESS_TOKEN_TTL_SECONDS: 3600, NODE_ENV: "test", DATABASE_URL: process.env.DATABASE_URL, ENCRYPTION_KEY: "0".repeat(64) },
}));

import { signAccessToken } from "../src/auth/oauth-server/tokens";
import { resolveMcpUser } from "../src/auth/oauth-server/resolve";

describe("resolveMcpUser", () => {
  it("accepts an OAuth access token via Bearer", async () => {
    const tok = await signAccessToken({ userId: "u-oauth", scope: "mcp", clientId: "c1" });
    expect(await resolveMcpUser({ authorization: `Bearer ${tok}` })).toBe("u-oauth");
  });

  it("returns null for no auth", async () => {
    expect(await resolveMcpUser({})).toBeNull();
  });

  it("returns null for a garbage bearer", async () => {
    expect(await resolveMcpUser({ authorization: "Bearer not-a-token" })).toBeNull();
  });
});
