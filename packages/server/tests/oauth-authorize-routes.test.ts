import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    GOOGLE_CLIENT_ID: "test-gid", GOOGLE_CLIENT_SECRET: "test-gsecret",
    PORTAL_URL: "http://localhost:5173", SERVER_PUBLIC_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-32-chars-long!!", NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts OAUTH_ACCESS_TOKEN_TTL_SECONDS: 3600,
  },
}));

import { registerOAuthRoutes } from "../src/api/oauth-routes";
import { registerClient } from "../src/auth/oauth-server/clients";
import { db } from "../src/db";
import { signSession } from "../src/auth/session";

beforeEach(async () => {
  await db.exec("DELETE FROM oauth_clients");
  await db.exec("DELETE FROM pending_auth");
});

async function app() { const a = Fastify(); await registerOAuthRoutes(a); return a; }

describe("/authorize", () => {
  it("302s to the portal's provider-choice landing page and stores the pending request", async () => {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1:33418/cb"] });
    const a = await app();
    const qs = new URLSearchParams({
      response_type: "code", client_id: c.client_id, redirect_uri: "http://127.0.0.1:33418/cb",
      code_challenge: "abc", code_challenge_method: "S256", scope: "mcp", state: "xyz",
    });
    const res = await a.inject({ method: "GET", url: `/authorize?${qs}` });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe("http://localhost:5173/authorize/choose");
    // a pending authorize row was stored, and its ticket is the one handed to the browser
    const row = await db.get<{ state: string }>(
      "SELECT state FROM pending_auth WHERE integration = '__oauth_authorize__'"
    );
    expect(row?.state).toBe(location.searchParams.get("ticket"));
    // The redirect must carry nothing beyond the ticket: the resume form on
    // the choice page posts a live session token, and its target must never
    // be influenced by a URL an attacker could craft (see the ticket=-only
    // assertion above — no `resume` or other extra param).
    expect([...location.searchParams.keys()]).toEqual(["ticket"]);
  });

  it("still sets the login-CSRF binding cookie on the way to the choice page", async () => {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1:33418/cb"] });
    const a = await app();
    const qs = new URLSearchParams({
      response_type: "code", client_id: c.client_id, redirect_uri: "http://127.0.0.1:33418/cb",
      code_challenge: "abc", code_challenge_method: "S256",
    });
    const res = await a.inject({ method: "GET", url: `/authorize?${qs}` });
    expect(res.headers["set-cookie"]).toMatch(/^awb_oauth_binding=/);
  });

  it("400s on an unregistered client", async () => {
    const a = await app();
    const qs = new URLSearchParams({
      response_type: "code", client_id: "nope", redirect_uri: "http://127.0.0.1/cb",
      code_challenge: "abc", code_challenge_method: "S256",
    });
    const res = await a.inject({ method: "GET", url: `/authorize?${qs}` });
    expect(res.statusCode).toBe(400);
  });

  it("400s when redirect_uri is not registered for the client", async () => {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1:33418/cb"] });
    const a = await app();
    const qs = new URLSearchParams({
      response_type: "code", client_id: c.client_id, redirect_uri: "http://evil/cb",
      code_challenge: "abc", code_challenge_method: "S256",
    });
    const res = await a.inject({ method: "GET", url: `/authorize?${qs}` });
    expect(res.statusCode).toBe(400);
  });

  it("400s without PKCE S256", async () => {
    const c = await registerClient({ redirect_uris: ["http://127.0.0.1:33418/cb"] });
    const a = await app();
    const qs = new URLSearchParams({
      response_type: "code", client_id: c.client_id, redirect_uri: "http://127.0.0.1:33418/cb",
    });
    const res = await a.inject({ method: "GET", url: `/authorize?${qs}` });
    expect(res.statusCode).toBe(400);
  });
});

// Starts a real /authorize flow and returns the minted ticket plus the
// awb_oauth_binding cookie the browser would be carrying into /authorize/resume.
async function startAuthorize(a: Awaited<ReturnType<typeof app>>, redirectUri: string) {
  const c = await registerClient({ redirect_uris: [redirectUri] });
  const qs = new URLSearchParams({
    response_type: "code", client_id: c.client_id, redirect_uri: redirectUri,
    code_challenge: "abc", code_challenge_method: "S256", scope: "mcp", state: "xyz",
  });
  const res = await a.inject({ method: "GET", url: `/authorize?${qs}` });
  const ticket = new URL(res.headers.location as string).searchParams.get("ticket")!;
  const setCookie = res.headers["set-cookie"] as string;
  const cookie = setCookie.split(";")[0]; // "awb_oauth_binding=<value>"
  return { ticket, cookie };
}

describe("/authorize/resume", () => {
  it("redeems an already-signed-in session and redirects to the client's redirect_uri", async () => {
    const a = await app();
    const { ticket, cookie } = await startAuthorize(a, "http://127.0.0.1:33418/cb");
    const token = await signSession({ userId: "user-1", email: "dev@example.com" });

    const res = await a.inject({
      method: "POST",
      url: "/authorize/resume",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${ticket}&token=${token}`,
    });

    expect(res.statusCode).toBe(302);
    const redirect = new URL(res.headers.location as string);
    expect(redirect.origin + redirect.pathname).toBe("http://127.0.0.1:33418/cb");
    expect(redirect.searchParams.get("code")).toBeTruthy();
  });

  it("sends the human back to the choice page when the session token is invalid", async () => {
    const a = await app();
    const { ticket, cookie } = await startAuthorize(a, "http://127.0.0.1:33418/cb");

    const res = await a.inject({
      method: "POST",
      url: "/authorize/resume",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${ticket}&token=not-a-real-token`,
    });

    expect(res.statusCode).toBe(302);
    const redirect = new URL(res.headers.location as string);
    expect(redirect.origin + redirect.pathname).toBe("http://localhost:5173/authorize/choose");
    expect(redirect.searchParams.get("ticket")).toBe(ticket);
    expect(redirect.searchParams.get("error")).toBeTruthy();
  });

  it("sends the human back to the choice page when the binding cookie is missing (login-CSRF)", async () => {
    const a = await app();
    const { ticket } = await startAuthorize(a, "http://127.0.0.1:33418/cb");
    const token = await signSession({ userId: "user-1", email: "dev@example.com" });

    const res = await a.inject({
      method: "POST",
      url: "/authorize/resume",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${ticket}&token=${token}`,
    });

    expect(res.statusCode).toBe(302);
    const redirect = new URL(res.headers.location as string);
    expect(redirect.origin + redirect.pathname).toBe("http://localhost:5173/authorize/choose");
    expect(redirect.searchParams.get("error")).toBeTruthy();
    // single-use: the pending row must be gone even though resume failed
    const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending_auth WHERE state = ?", [ticket]);
    expect(Number(row?.n)).toBe(0);
  });

  it("400s when the ticket is missing entirely", async () => {
    const a = await app();
    const token = await signSession({ userId: "user-1", email: "dev@example.com" });
    const res = await a.inject({
      method: "POST",
      url: "/authorize/resume",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${token}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("is single-use: a second resume with the same ticket fails even with a fresh valid session", async () => {
    const a = await app();
    const { ticket, cookie } = await startAuthorize(a, "http://127.0.0.1:33418/cb");
    const token = await signSession({ userId: "user-1", email: "dev@example.com" });

    const first = await a.inject({
      method: "POST", url: "/authorize/resume",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${ticket}&token=${token}`,
    });
    expect(first.statusCode).toBe(302);
    expect(new URL(first.headers.location as string).searchParams.get("code")).toBeTruthy();

    const second = await a.inject({
      method: "POST", url: "/authorize/resume",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${ticket}&token=${token}`,
    });
    expect(second.statusCode).toBe(302);
    const secondRedirect = new URL(second.headers.location as string);
    expect(secondRedirect.origin + secondRedirect.pathname).toBe("http://localhost:5173/authorize/choose");
  });
});
