import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import Fastify from "fastify";
import { registerOAuthRoutes } from "../src/api/oauth-routes";
import { registerClient } from "../src/auth/oauth-server/clients";
import { issueCode } from "../src/auth/oauth-server/codes";
import { verifyAccessToken } from "../src/auth/oauth-server/tokens";
import { db } from "../src/db";

beforeEach(async () => {
  await db.exec("DELETE FROM oauth_clients");
  await db.exec("DELETE FROM oauth_auth_codes");
  await db.exec("DELETE FROM oauth_refresh_tokens");
});

async function app() { const a = Fastify(); await registerOAuthRoutes(a); return a; }

describe("POST /token", () => {
  it("exchanges a PKCE code for access + refresh tokens", async () => {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1/cb"] });
    const code = await issueCode({
      clientId: c.client_id, userId: "u1", redirectUri: "http://127.0.0.1/cb",
      codeChallenge: crypto.createHash("sha256").update("verifier").digest("base64url"),
      scope: "mcp", resource: "http://x/mcp",
    });
    const a = await app();
    const res = await a.inject({
      method: "POST", url: "/token",
      payload: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: c.client_id,
        redirect_uri: "http://127.0.0.1/cb", code_verifier: "verifier",
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token_type).toBe("Bearer");
    expect(body.refresh_token).toBeTruthy();
    expect((await verifyAccessToken(body.access_token)).userId).toBe("u1");
  });

  it("rejects a bad PKCE verifier", async () => {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1/cb"] });
    const code = await issueCode({
      clientId: c.client_id, userId: "u1", redirectUri: "http://127.0.0.1/cb",
      codeChallenge: crypto.createHash("sha256").update("right").digest("base64url"),
      scope: "mcp", resource: "http://x/mcp",
    });
    const a = await app();
    const res = await a.inject({
      method: "POST", url: "/token",
      payload: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: c.client_id,
        redirect_uri: "http://127.0.0.1/cb", code_verifier: "wrong",
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refreshes with a refresh_token", async () => {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1/cb"] });
    const code = await issueCode({
      clientId: c.client_id, userId: "u1", redirectUri: "http://127.0.0.1/cb",
      codeChallenge: crypto.createHash("sha256").update("v").digest("base64url"),
      scope: "mcp", resource: "http://x/mcp",
    });
    const a = await app();
    const first = JSON.parse((await a.inject({
      method: "POST", url: "/token",
      payload: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: c.client_id,
        redirect_uri: "http://127.0.0.1/cb", code_verifier: "v",
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })).body);
    const res = await a.inject({
      method: "POST", url: "/token",
      payload: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).access_token).toBeTruthy();
  });

  it("rejects an unknown grant_type", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST", url: "/token",
      payload: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unsupported_grant_type");
  });

  it("rejects a missing grant_type", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST", url: "/token",
      payload: new URLSearchParams({}).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unsupported_grant_type");
  });

  it("rejects an invalid/unknown refresh_token", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST", url: "/token",
      payload: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: "nope", client_id: "c1",
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("rejects an authorization_code grant with an unknown code", async () => {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1/cb"] });
    const a = await app();
    const res = await a.inject({
      method: "POST", url: "/token",
      payload: new URLSearchParams({
        grant_type: "authorization_code", code: "bogus", client_id: c.client_id,
        redirect_uri: "http://127.0.0.1/cb", code_verifier: "v",
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });
});

describe("POST /token for a disabled user", () => {
  beforeEach(async () => {
    await db.exec("DELETE FROM users");
  });

  async function codeFor(userId: string) {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1/cb"] });
    const code = await issueCode({
      clientId: c.client_id, userId, redirectUri: "http://127.0.0.1/cb",
      codeChallenge: crypto.createHash("sha256").update("v").digest("base64url"),
      scope: "mcp", resource: "http://x/mcp",
    });
    return { c, code };
  }

  function form(o: Record<string, string>) {
    return {
      payload: new URLSearchParams(o).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    };
  }

  it("refuses the authorization_code grant", async () => {
    await db.run("INSERT INTO users (id, email, disabled_at) VALUES (?, ?, ?)", ["u-off", "off@example.com", 1700000000]);
    const { c, code } = await codeFor("u-off");
    const a = await app();
    const res = await a.inject({
      method: "POST", url: "/token",
      ...form({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "http://127.0.0.1/cb", code_verifier: "v" }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_grant" });
  });

  it("refuses the refresh_token grant once the user is disabled, and does not mint a new token", async () => {
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u-on", "on@example.com"]);
    const { c, code } = await codeFor("u-on");
    const a = await app();
    const first = JSON.parse((await a.inject({
      method: "POST", url: "/token",
      ...form({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "http://127.0.0.1/cb", code_verifier: "v" }),
    })).body);
    expect(first.refresh_token).toBeTruthy();

    await db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [1700000000, "u-on"]);
    const res = await a.inject({
      method: "POST", url: "/token",
      ...form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_grant" });
  });
});
