import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { createUser, verifyApiKey } from "../src/auth/users";
import { signSession, verifySession } from "../src/auth/session";
import { signAccessToken, verifyAccessToken } from "../src/auth/oauth-server/tokens";
import { signCurlToken, verifyCurlToken } from "../src/auth/curl-session";
import { resolveMcpUser } from "../src/auth/oauth-server/resolve";
import { setUserDisabled } from "../src/auth/user-status";

beforeEach(async () => {
  await db.exec("DELETE FROM users");
});

async function seed(id: string): Promise<string> {
  const { apiKey } = await createUser(id);
  return apiKey;
}

describe("a disabled user is refused by every credential verifier", () => {
  it("API key: null while disabled, valid again once enabled", async () => {
    const key = await seed("u-key");
    expect(await verifyApiKey(key)).toBe("u-key");
    await setUserDisabled("u-key", true);
    expect(await verifyApiKey(key)).toBeNull();
    await setUserDisabled("u-key", false);
    expect(await verifyApiKey(key)).toBe("u-key");
  });

  it("portal session JWT", async () => {
    await seed("u-sess");
    const token = await signSession({ userId: "u-sess", email: "dev@example.com" });
    expect((await verifySession(token)).userId).toBe("u-sess");
    await setUserDisabled("u-sess", true);
    await expect(verifySession(token)).rejects.toThrow("User disabled");
    await setUserDisabled("u-sess", false);
    expect((await verifySession(token)).userId).toBe("u-sess");
  });

  it("OAuth access token", async () => {
    await seed("u-oauth");
    const token = await signAccessToken({ userId: "u-oauth", scope: "mcp", clientId: "c1" });
    expect((await verifyAccessToken(token)).userId).toBe("u-oauth");
    await setUserDisabled("u-oauth", true);
    await expect(verifyAccessToken(token)).rejects.toThrow("User disabled");
  });

  it("curl session token", async () => {
    await seed("u-curl");
    const token = await signCurlToken("u-curl", ["acme"]);
    expect((await verifyCurlToken(token)).userId).toBe("u-curl");
    await setUserDisabled("u-curl", true);
    await expect(verifyCurlToken(token)).rejects.toThrow("User disabled");
  });

  it("/mcp resolution: API key, OAuth bearer and session bearer are all refused", async () => {
    const key = await seed("u-mcp");
    const oauth = await signAccessToken({ userId: "u-mcp", scope: "mcp", clientId: "c1" });
    const session = await signSession({ userId: "u-mcp", email: "dev@example.com" });
    expect(await resolveMcpUser({ "x-workbench-api-key": key })).toBe("u-mcp");
    expect(await resolveMcpUser({ authorization: `Bearer ${oauth}` })).toBe("u-mcp");
    expect(await resolveMcpUser({ authorization: `Bearer ${session}` })).toBe("u-mcp");
    await setUserDisabled("u-mcp", true);
    expect(await resolveMcpUser({ "x-workbench-api-key": key })).toBeNull();
    expect(await resolveMcpUser({ authorization: `Bearer ${oauth}` })).toBeNull();
    expect(await resolveMcpUser({ authorization: `Bearer ${session}` })).toBeNull();
  });

  it("a user with no row is not treated as disabled", async () => {
    const token = await signSession({ userId: "never-seen", email: "dev@example.com" });
    expect((await verifySession(token)).userId).toBe("never-seen");
  });

  it("disabling one user does not affect another", async () => {
    const keyA = await seed("u-a");
    const keyB = await seed("u-b");
    await setUserDisabled("u-a", true);
    expect(await verifyApiKey(keyA)).toBeNull();
    expect(await verifyApiKey(keyB)).toBe("u-b");
  });
});
