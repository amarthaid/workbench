import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Fastify from "fastify";

// Real verifySession here (no mock): disabled users must be refused.
import { registerApiRoutes } from "../src/api/routes";
import { stopReaper } from "../src/auth/connections";
import { registry } from "../src/plugins/registry";
import { storeCookies } from "../src/auth/cookie";
import { createUser } from "../src/auth/users";
import { signSession } from "../src/auth/session";
import { setUserDisabled } from "../src/auth/user-status";
import { getReconnectState } from "../src/auth/reconnect/state";
import { putSecret } from "../src/vault/store";
import { db } from "../src/db";

const USER = "user-rc-sess";
const acme = {
  name: "acme", version: "1", displayName: "Acme", description: "d", categories: [],
  auth: {
    type: "cookie", loginUrl: "https://app.example.com/login", targetDomain: "app.example.com",
    cookieDomains: ["app.example.com"],
    reconnect: { credentials: [{ key: "password", label: "Password", secret: true }], steps: [{ goto: "loginUrl" }] },
  },
} as any;

beforeEach(async () => {
  await db.run("DELETE FROM connections WHERE user_id = ?", [USER]);
  await db.run("DELETE FROM user_vaults WHERE user_id = ?", [USER]);
  await db.run("DELETE FROM users WHERE id = ?", [USER]);
  vi.spyOn(registry, "getIntegration").mockImplementation((n: string) => (n === "acme" ? acme : undefined));
  vi.spyOn(registry, "listIntegrations").mockReturnValue([acme]);
});
afterAll(() => stopReaper());

describe("PUT /api/connections/:integration/reconnect session checks", () => {
  it("accepts a real session, then 401s once the user is disabled, and rejects a garbage token", async () => {
    await createUser(USER);
    await putSecret(USER, "acme_pw", "pw-abc");
    await storeCookies(USER, "acme", {
      domain: "app.example.com",
      cookies: [{ name: "sid", value: "tok-abc", domain: "app.example.com", path: "/", expires: 9999999999 }],
      capturedAt: 1,
    });
    const app = Fastify();
    await registerApiRoutes(app);
    await app.ready();
    const token = await signSession({ userId: USER, email: "dev@example.com" });
    const put = (t: string) =>
      app.inject({
        method: "PUT", url: "/api/connections/acme/reconnect",
        headers: { authorization: `Bearer ${t}` }, payload: { bindings: { password: "acme_pw" } },
      });

    expect((await put("not-a-jwt")).statusCode).toBe(401);
    await setUserDisabled(USER, true);
    expect((await put(token)).statusCode).toBe(401);
    expect((await getReconnectState(USER, "acme")).bindings).toBeUndefined();
    await setUserDisabled(USER, false);
    expect((await put(token)).statusCode).toBe(200);
  });
});
