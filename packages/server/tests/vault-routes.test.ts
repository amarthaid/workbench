import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) =>
    headers.authorization === "Bearer u1-token" ? "u1" : headers.authorization === "Bearer u2-token" ? "u2" : null
  ),
}));

vi.mock("../src/auth/session", () => ({
  verifySession: vi.fn(async (token: string) => {
    // Only the portal-session JWT verifies. An API-key / OAuth bearer
    // (`u1-token`) is a valid MCP credential and still not a session.
    const m = /^(u\d+)-session$/.exec(token);
    if (!m) throw new Error("Invalid session");
    return { userId: m[1], email: `${m[1]}@example.com` };
  }),
}));

import { registerVaultRoutes, OTL_PORTAL_DEFAULT_TTL_SECONDS } from "../src/vault/routes";
import { putSecret, readSecretValue } from "../src/vault/store";
import { mintOtl, _setNowForTest, OTL_MAX_TTL_SECONDS, OTL_SENTINEL } from "../src/vault/otl";
import { db } from "../src/db";

// Agent-style bearers: resolve to a user, are not a portal session.
const U1 = { authorization: "Bearer u1-token" };
const U2 = { authorization: "Bearer u2-token" };
// Portal-session bearers: the only thing that may write.
const P1 = { authorization: "Bearer u1-session" };
const P2 = { authorization: "Bearer u2-session" };
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

  it("refuses writes from an agent credential, allows them from a portal session", async () => {
    await putSecret("u1", "pw", "hunter2");

    // An API key / OAuth bearer resolves to u1 and still cannot write.
    const put = await app.inject({ method: "PUT", url: "/api/vault/pw", headers: U1, payload: { value: "rotated" } });
    expect(put.statusCode).toBe(403);
    expect(put.json().error).toBe("PORTAL_SESSION_REQUIRED");
    expect(await readSecretValue("u1", "pw")).toBe("hunter2");

    const del = await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: U1 });
    expect(del.statusCode).toBe(403);
    expect(del.json().error).toBe("PORTAL_SESSION_REQUIRED");
    expect(await readSecretValue("u1", "pw")).toBe("hunter2");

    // The same reads are fine on that bearer.
    const list = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(list.statusCode).toBe(200);
    expect(list.json().secrets).toEqual([expect.objectContaining({ name: "pw" })]);

    // A bearer that is neither a session nor a credential the server accepts
    // is a 401, not a 403: re-authenticating is exactly what would help, and
    // the portal clears its stored token on a 401. An expired session JWT
    // lands here too — verifySession rejects it and resolveMcpUser does not
    // know it.
    const junk = { authorization: "Bearer garbage" };
    const jput = await app.inject({ method: "PUT", url: "/api/vault/pw", headers: junk, payload: { value: "x" } });
    expect(jput.statusCode).toBe(401);
    expect(jput.headers["www-authenticate"]).toContain('Bearer realm="a-workbench"');
    const jdel = await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: junk });
    expect(jdel.statusCode).toBe(401);
    expect(jdel.headers["www-authenticate"]).toContain('Bearer realm="a-workbench"');
    expect(await readSecretValue("u1", "pw")).toBe("hunter2");

    // The portal session writes and deletes.
    expect(
      (await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: { value: "rotated" } })).statusCode
    ).toBe(200);
    expect(await readSecretValue("u1", "pw")).toBe("rotated");
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: P1 })).statusCode).toBe(204);
    expect(await readSecretValue("u1", "pw")).toBeNull();
  });

  it("PUT creates then overwrites; GET lists without the value", async () => {
    const c = await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: { value: "hunter2", description: "d" } });
    expect(c.statusCode).toBe(201);
    const o = await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: { value: "hunter3" } });
    expect(o.statusCode).toBe(200);
    expect(await readSecretValue("u1", "pw")).toBe("hunter3");
    const l = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(l.statusCode).toBe(200);
    expect(l.json().secrets).toEqual([expect.objectContaining({ name: "pw" })]);
    expect(l.body).not.toContain("hunter");
    expect((await app.inject({ method: "GET", url: "/api/vault", headers: U2 })).json().secrets).toEqual([]);
  });

  it("PUT keeps the existing description when omitted, clears it with null", async () => {
    await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: { value: "hunter2", description: "d" } });
    await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: { value: "hunter3" } });
    let l = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(l.json().secrets[0].description).toBe("d");
    await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: { value: "hunter4", description: null } });
    l = await app.inject({ method: "GET", url: "/api/vault", headers: U1 });
    expect(l.json().secrets[0].description).toBeNull();
  });

  it("PUT validates", async () => {
    expect((await app.inject({ method: "PUT", url: "/api/vault/Bad", headers: P1, payload: { value: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: { value: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: { value: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/vault/pw", headers: P1, payload: { value: "x".repeat(9000) } })).statusCode).toBe(413);
  });

  it("DELETE removes the secret and its outstanding links", async () => {
    await putSecret("u1", "pw", "hunter2");
    const m = await mintOtl("u1", "pw");
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: P1 })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: P1 })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/vault/otl/${m.token}` })).statusCode).toBe(404);
  });

  it("a user cannot delete another user's secret", async () => {
    await putSecret("u1", "pw", "hunter2");
    expect((await app.inject({ method: "DELETE", url: "/api/vault/pw", headers: P2 })).statusCode).toBe(404);
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

  describe("POST /api/vault/otl (one-time secret, never stored)", () => {
    it("is portal-only", async () => {
      const none = await app.inject({ method: "POST", url: "/api/vault/otl", payload: { value: "v" } });
      expect(none.statusCode).toBe(401);
      expect(none.headers["www-authenticate"]).toContain('Bearer realm="a-workbench"');
      const agent = await app.inject({ method: "POST", url: "/api/vault/otl", headers: U1, payload: { value: "v" } });
      expect(agent.statusCode).toBe(403);
      expect(agent.json().error).toBe("PORTAL_SESSION_REQUIRED");
      expect(await db.get("SELECT 1 FROM pending_auth WHERE integration = ?", [OTL_SENTINEL])).toBeFalsy();
    });

    it("mints, redeems once, stores nothing in the vault, logs nothing of the value", async () => {
      const t0 = Date.now();
      _setNowForTest(() => t0);
      const res = await app.inject({
        method: "POST",
        url: "/api/vault/otl",
        headers: P1,
        payload: { value: "ZZ-ONE-SHOT-7c2a" },
      });
      expect(res.statusCode).toBe(201);
      const { url, expires_at } = res.json();
      expect(url).toContain("/api/vault/otl/");
      expect(expires_at).toBe(Math.ceil((t0 + OTL_PORTAL_DEFAULT_TTL_SECONDS * 1000) / 1000));
      expect(res.body).not.toContain("ZZ-ONE-SHOT");
      expect(await db.get("SELECT 1 FROM user_vaults WHERE user_id = ?", ["u1"])).toBeFalsy();
      // A stored secret alongside is untouched by an ad hoc redeem: no last_used_at stamp.
      await putSecret("u1", "pw", "hunter2");

      const path = new URL(url).pathname;
      const first = await app.inject({ method: "GET", url: path });
      expect(first.statusCode).toBe(200);
      expect(first.body).toBe("ZZ-ONE-SHOT-7c2a");
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.headers["content-disposition"]).toContain("attachment");
      const second = await app.inject({ method: "GET", url: path });
      expect(second.statusCode).toBe(404);
      expect(second.body).toBe("");
      expect(logged.join("\n")).not.toContain("ZZ-ONE-SHOT");
      expect(logged.join("\n")).not.toContain(path.split("/").pop());
      const stored = await db.get<{ last_used_at: number | null }>(
        "SELECT last_used_at FROM user_vaults WHERE user_id = ? AND name = ?",
        ["u1", "pw"]
      );
      expect(stored?.last_used_at).toBeNull();
    });

    it("validates value and ttl", async () => {
      const bad = async (payload: unknown) =>
        (await app.inject({ method: "POST", url: "/api/vault/otl", headers: P1, payload: payload as any })).json();
      expect(await bad({})).toEqual({ error: "INVALID_VALUE" });
      expect(await bad({ value: 1 })).toEqual({ error: "INVALID_VALUE" });
      expect(await bad({ value: "" })).toEqual({ error: "EMPTY_VALUE" });
      expect(await bad({ value: "x".repeat(8193) })).toEqual({ error: "TOO_LARGE" });
      expect(await bad({ value: "v", ttl_seconds: 0 })).toEqual({ error: "INVALID_TTL" });
      expect(await bad({ value: "v", ttl_seconds: "60" })).toEqual({ error: "INVALID_TTL" });
    });

    it("clamps ttl to the ceiling and honours a shorter one", async () => {
      const t0 = Date.now();
      _setNowForTest(() => t0);
      const long = await app.inject({ method: "POST", url: "/api/vault/otl", headers: P1, payload: { value: "v", ttl_seconds: 99999 } });
      expect(long.json().expires_at).toBe(Math.ceil((t0 + OTL_MAX_TTL_SECONDS * 1000) / 1000));
      const short = await app.inject({ method: "POST", url: "/api/vault/otl", headers: P1, payload: { value: "v", ttl_seconds: 60 } });
      expect(short.json().expires_at).toBe(Math.ceil((t0 + 60_000) / 1000));
      _setNowForTest(() => t0 + 61_000);
      expect((await app.inject({ method: "GET", url: new URL(short.json().url).pathname })).statusCode).toBe(404);
    });
  });
});
