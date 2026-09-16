import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) =>
    headers.authorization === "Bearer u1-token" ? "u1" : headers.authorization === "Bearer u2-token" ? "u2" : null
  ),
}));

import { registerVaultRoutes } from "../src/vault/routes";
import { putSecret, readSecretValue } from "../src/vault/store";
import { mintOtl, _setNowForTest } from "../src/vault/otl";
import { db } from "../src/db";

const U1 = { authorization: "Bearer u1-token" };
const U2 = { authorization: "Bearer u2-token" };
let app: FastifyInstance;
let logged: string[];

beforeEach(async () => {
  await db.run("DELETE FROM user_vaults");
  await db.run("DELETE FROM pending_auth");
  logged = [];
  app = Fastify({
    logger: {
      level: "info",
      stream: { write: (s: string) => { logged.push(s); } } as any,
    },
  });
  await registerVaultRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  _setNowForTest(() => Date.now());
});

describe("vault routes", () => {
  it("requires a bearer on list/put/delete", async () => {
    const get = await app.inject({ method: "GET", url: "/api/vault" });
    expect(get.statusCode).toBe(401);
    expect(get.headers["www-authenticate"]).toContain('Bearer realm="a-workbench"');
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", payload: { value: "x" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw" })).statusCode).toBe(401);
  });

  it("PUT creates then overwrites; GET lists without the value", async () => {
    const c = await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "hunter2", description: "d" } });
    expect(c.statusCode).toBe(201);
    const o = await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "hunter3" } });
    expect(o.statusCode).toBe(200);
    expect(await readSecretValue("u1", "pw")).toBe("hunter3");
    const l = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(l.statusCode).toBe(200);
    expect(l.json().secrets).toEqual([expect.objectContaining({ name: "pw" })]);
    expect(l.body).not.toContain("hunter");
    expect((await app.inject({ method: "GET", url: "/api/vault", headers: U2 })).json().secrets).toEqual([]);
  });

  it("PUT keeps the existing description when omitted, clears it with null", async () => {
    await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "hunter2", description: "d" } });
    await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "hunter3" } });
    let l = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(l.json().secrets[0].description).toBe("d");
    await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "hunter4", description: null } });
    l = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(l.json().secrets[0].description).toBeNull();
  });

  it("PUT validates", async () => {
    expect((await app.inject({ method: "PUT", url: "/api/vault/Bad", headers: U1, payload: { value: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "x".repeat(9000) } })).statusCode).toBe(413);
  });

  it("DELETE removes the secret and its outstanding links", async () => {
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw");
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: U1 })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: U1 })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` })).statusCode).toBe(404);
  });

  it("a user cannot delete another user's secret", async () => {
    await putSecret("u1", "pw", "hunter2");
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: U2 })).statusCode).toBe(404);
    expect(await readSecretValue("u1", "pw")).toBe("hunter2");
  });

  it("OTL redeems once as text/plain with no-store, then 404s", async () => {
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw");
    const r = await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("hunter2");
    expect(r.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-disposition"]).toContain("attachment");
    const again = await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` });
    expect(again.statusCode).toBe(404);
    expect(again.body).toBe("");
  });

  it("OTL 404s empty for junk, expired, and unknown alike", async () => {
    const t0 = Date.now();
    _setNowForTest(() => t0);
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw", 30);
    _setNowForTest(() => t0 + 31_000);
    for (const url of [`/api/vault/otl/${m.token}`, "/api/vault/otl/zz", `/api/vault/otl/${"0".repeat(32)}`]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe("");
    }
  });

  it("OTL route never reaches the request log", async () => {
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw");
    await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` });
    await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    const joined = logged.join("\n");
    expect(joined).not.toContain(m.token);
    expect(joined).toContain("/api/vault");
  });

  it("OTL redeem stamps last_used_at", async () => {
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw");
    await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` });
    const l = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(l.json().secrets[0].last_used_at).not.toBeNull();
  });
});
