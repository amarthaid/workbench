import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// jose stays real (sessions are signed with it); only the provider's ID token,
// the single string "google-id-token" / "keycloak-id-token", is faked.
const idToken = vi.hoisted(() => ({ payload: {} as Record<string, unknown> }));
vi.mock("jose", async (orig) => {
  const real = await orig<typeof import("jose")>();
  return {
    ...real,
    createRemoteJWKSet: vi.fn(() => "mock-jwks"),
    jwtVerify: vi.fn(async (token: string, ...rest: unknown[]) =>
      token === "google-id-token" || token === "keycloak-id-token"
        ? { payload: idToken.payload }
        : (real.jwtVerify as (...a: unknown[]) => Promise<unknown>)(token, ...rest)
    ),
  };
});

import { config } from "../../src/config";
import { db } from "../../src/db";
import { installAuditContext } from "../../src/audit/context";
import { registerApiRoutes } from "../../src/api/routes";
import { stopReaper } from "../../src/auth/connections";
import { buildAuthUrl as googleAuthUrl } from "../../src/auth/google";
import { buildAuthUrl as keycloakAuthUrl } from "../../src/auth/keycloak";
import { decide } from "../../src/approvals/engine";
import { ACCOUNT_ACTIVATE, PENDING_SIGNUP_CAP, accountActivate } from "../../src/approvals/kinds";
import { getUserStatus } from "../../src/auth/user-status";
import { verifySession } from "../../src/auth/session";
import { mintWaitingValue, _resetWaitingRateForTest } from "../../src/auth/waiting-cookie";

const ADMIN = { userId: "u-admin", email: "admin@example.com" };
const PORTAL = "http://localhost:5173";
const saved = {
  gid: config.GOOGLE_CLIENT_ID,
  gsecret: config.GOOGLE_CLIENT_SECRET,
  kcIssuer: config.KEYCLOAK_ISSUER_URL,
  kcId: config.KEYCLOAK_CLIENT_ID,
  kcSecret: config.KEYCLOAK_CLIENT_SECRET,
  admins: config.ADMIN_EMAILS,
  require: config.REQUIRE_SIGNUP_APPROVAL,
  portal: config.PORTAL_URL,
};

let app: FastifyInstance;

function mockProviders() {
  global.fetch = vi.fn((url: string | URL) => {
    const href = url.toString();
    if (href.includes("accounts.google.com/.well-known")) return Promise.resolve(new Response(JSON.stringify({ jwks_uri: "https://accounts.google.com/jwks" })));
    if (href.includes("keycloak.example.com") && href.includes(".well-known")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            authorization_endpoint: "https://keycloak.example.com/auth",
            token_endpoint: "https://keycloak.example.com/token",
            jwks_uri: "https://keycloak.example.com/certs",
            issuer: "https://keycloak.example.com/realms/test",
          })
        )
      );
    }
    if (href.includes("oauth2.googleapis.com")) return Promise.resolve(new Response(JSON.stringify({ id_token: "google-id-token" })));
    return Promise.resolve(new Response(JSON.stringify({ id_token: "keycloak-id-token" })));
  }) as typeof fetch;
}

/** Sign in through the real callback route; returns the redirect Location. */
async function signInGoogle(
  claims: { sub: string; email: string; email_verified?: boolean },
  extra: { ticket?: string; cookie?: string } = {}
) {
  const url = new URL(await googleAuthUrl(extra.ticket));
  const state = url.searchParams.get("state")!;
  idToken.payload = { ...claims, email_verified: claims.email_verified ?? true, nonce: url.searchParams.get("nonce") };
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
    headers: extra.cookie ? { cookie: extra.cookie } : {},
  });
  return res;
}

async function signInKeycloak(claims: { sub: string; email: string; email_verified?: boolean }) {
  const url = new URL(await keycloakAuthUrl());
  idToken.payload = { ...claims, email_verified: claims.email_verified ?? true, nonce: url.searchParams.get("nonce") };
  return app.inject({
    method: "GET",
    url: `/api/auth/keycloak/callback?code=c&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
  });
}

async function userByEmail(email: string) {
  return db.get<{ id: string; status: string; disabled_at: number | string | null }>(
    "SELECT id, status, disabled_at FROM users WHERE email = ?",
    [email]
  );
}

async function requestsFor(userId: string) {
  return db.all<{ id: string; status: string; kind: string; requester_id: string }>(
    "SELECT id, status, kind, requester_id FROM approval_requests WHERE subject = ? ORDER BY created_at, id",
    [userId]
  );
}

async function tableCount(table: string) {
  return Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n);
}

beforeAll(async () => {
  config.GOOGLE_CLIENT_ID = "gid";
  config.GOOGLE_CLIENT_SECRET = "gsecret";
  config.KEYCLOAK_ISSUER_URL = "https://keycloak.example.com/realms/test";
  config.KEYCLOAK_CLIENT_ID = "kcid";
  config.KEYCLOAK_CLIENT_SECRET = "kcsecret";
  config.PORTAL_URL = PORTAL;
  app = Fastify();
  installAuditContext(app);
  await registerApiRoutes(app);
  await app.ready();
});

afterAll(async () => {
  stopReaper();
  await app.close();
  Object.assign(config, {
    GOOGLE_CLIENT_ID: saved.gid,
    GOOGLE_CLIENT_SECRET: saved.gsecret,
    KEYCLOAK_ISSUER_URL: saved.kcIssuer,
    KEYCLOAK_CLIENT_ID: saved.kcId,
    KEYCLOAK_CLIENT_SECRET: saved.kcSecret,
    ADMIN_EMAILS: saved.admins,
    REQUIRE_SIGNUP_APPROVAL: saved.require,
    PORTAL_URL: saved.portal,
  });
  for (const t of ["approval_requests", "pending_auth", "oauth_auth_codes", "audit_log", "users"]) await db.exec(`DELETE FROM ${t}`);
});

beforeEach(async () => {
  for (const t of ["approval_requests", "pending_auth", "oauth_auth_codes", "audit_log", "users"]) await db.exec(`DELETE FROM ${t}`);
  config.ADMIN_EMAILS = ["admin@example.com"];
  config.REQUIRE_SIGNUP_APPROVAL = true;
  await db.run("INSERT INTO users (id, email) VALUES (?, ?)", [ADMIN.userId, ADMIN.email]);
  mockProviders();
});

afterEach(() => vi.restoreAllMocks());

describe("sign-up with REQUIRE_SIGNUP_APPROVAL off", () => {
  it("creates an active user and signs them in, as before", async () => {
    config.REQUIRE_SIGNUP_APPROVAL = false;
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toMatch(/^http:\/\/localhost:5173\/#token=/);
    expect(await userByEmail("new@example.com")).toMatchObject({ status: "active", disabled_at: null });
    expect(await tableCount("approval_requests")).toBe(0);
  });
});

describe("sign-up with REQUIRE_SIGNUP_APPROVAL on", () => {
  it("creates a pending user and one request, issues no session, and redirects to the waiting room", async () => {
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${PORTAL}/waiting`);
    expect(res.headers.location as string).not.toContain("token");
    const user = await userByEmail("new@example.com");
    // Dual write: the old column is set too, for workers that only read it.
    expect(user).toMatchObject({ status: "pending" });
    expect(user?.disabled_at).not.toBeNull();
    expect(await requestsFor(user!.id)).toEqual([
      expect.objectContaining({ kind: ACCOUNT_ACTIVATE, status: "pending", requester_id: user!.id }),
    ]);
  });

  it("a repeat sign-in while pending adds no second request", async () => {
    await signInGoogle({ sub: "g-1", email: "new@example.com" });
    const again = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    expect(again.headers.location).toBe(`${PORTAL}/waiting`);
    const user = await userByEmail("new@example.com");
    expect(await requestsFor(user!.id)).toHaveLength(1);
  });

  it("an email on ADMIN_EMAILS is never held, and gets no request", async () => {
    const res = await signInGoogle({ sub: "g-admin", email: "ADMIN@example.com" });
    expect(res.headers.location as string).toMatch(/#token=/);
    const row = await db.get<{ status: string }>("SELECT status FROM users WHERE google_sub = 'g-admin'");
    expect(row?.status).toBe("active");
    expect(await tableCount("approval_requests")).toBe(0);
  });

  it("an existing user is never moved to pending by turning the setting on", async () => {
    await db.run("INSERT INTO users (id, email, google_sub) VALUES (?, ?, ?)", ["u-old", "old@example.com", "g-old"]);
    const res = await signInGoogle({ sub: "g-old", email: "old@example.com" });
    expect(res.headers.location as string).toMatch(/#token=/);
    expect((await userByEmail("old@example.com"))?.status).toBe("active");
    expect(await tableCount("approval_requests")).toBe(0);
  });

  it("an admin who was added to ADMIN_EMAILS after signing up is activated at the next sign-in, and the request closes", async () => {
    config.ADMIN_EMAILS = ["somebody@example.com"];
    await signInGoogle({ sub: "g-late", email: "late@example.com" });
    const user = await userByEmail("late@example.com");
    expect(user?.status).toBe("pending");
    config.ADMIN_EMAILS = ["late@example.com"];
    const res = await signInGoogle({ sub: "g-late", email: "late@example.com" });
    expect(res.headers.location as string).toMatch(/#token=/);
    expect(await userByEmail("late@example.com")).toMatchObject({ status: "active", disabled_at: null });
    expect((await requestsFor(user!.id)).map((r) => r.status)).toEqual(["approved"]);
  });

  it("self-heals: a pending user whose request is missing gets one at the next sign-in", async () => {
    await db.run("INSERT INTO users (id, email, google_sub, status, disabled_at) VALUES (?, ?, ?, 'pending', ?)", [
      "u-orphan", "orphan@example.com", "g-orphan", 1,
    ]);
    const res = await signInGoogle({ sub: "g-orphan", email: "orphan@example.com" });
    expect(res.headers.location).toBe(`${PORTAL}/waiting`);
    expect((await requestsFor("u-orphan")).map((r) => r.status)).toEqual(["pending"]);
  });

  it("holds Keycloak sign-ups the same way", async () => {
    const res = await signInKeycloak({ sub: "kc-1", email: "kc@example.com" });
    expect(res.headers.location).toBe(`${PORTAL}/waiting`);
    const user = await userByEmail("kc@example.com");
    expect(user?.status).toBe("pending");
    expect(await requestsFor(user!.id)).toHaveLength(1);
  });

  it("past the pending cap nothing is created and the person still sees the pending message", async () => {
    const now = Math.floor(Date.now() / 1000);
    await db.transaction(async (tx) => {
      for (let i = 0; i < PENDING_SIGNUP_CAP; i++) {
        await tx.run(
          "INSERT INTO approval_requests (id, kind, subject, requester_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
          [`cap-${i}`, ACCOUNT_ACTIVATE, `ghost-${i}`, `ghost-${i}`, now]
        );
      }
    });
    const res = await signInGoogle({ sub: "g-cap", email: "cap@example.com" });
    expect(res.headers.location).toBe(`${PORTAL}/login?error=account_pending`);
    expect(await userByEmail("cap@example.com")).toBeUndefined();
    expect(await tableCount("approval_requests")).toBe(PENDING_SIGNUP_CAP);
  });
});

describe("a pending user's callback never issues a session or an authorization code", () => {
  async function seedTicket(ticket: string, binding: string) {
    await db.run("INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?,?,?,?,?)", [
      ticket,
      "",
      "__oauth_authorize__",
      Math.floor(Date.now() / 1000) + 600,
      JSON.stringify({
        clientId: "c1",
        redirectUri: "http://127.0.0.1/cb",
        codeChallenge: "abc",
        scope: "mcp",
        state: "st",
        resource: "http://x/mcp",
        binding,
      }),
    ]);
  }

  it("with a /authorize ticket and a matching binding: no code, ticket not consumed", async () => {
    await signInGoogle({ sub: "g-1", email: "new@example.com" }); // now pending
    await seedTicket("tkt-pend", "bind-secret");
    const res = await signInGoogle(
      { sub: "g-1", email: "new@example.com" },
      { ticket: "tkt-pend", cookie: "awb_oauth_binding=bind-secret" }
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${PORTAL}/waiting`);
    expect(await tableCount("oauth_auth_codes")).toBe(0);
    const ticket = await db.get("SELECT state FROM pending_auth WHERE state = 'tkt-pend'");
    expect(ticket).toBeTruthy();
  });

  it("the same ticket works for an active user (the control)", async () => {
    config.REQUIRE_SIGNUP_APPROVAL = false;
    await db.run("INSERT INTO users (id, email, google_sub) VALUES (?, ?, ?)", ["u-ok", "ok@example.com", "g-ok"]);
    await seedTicket("tkt-ok", "bind-secret");
    const res = await signInGoogle(
      { sub: "g-ok", email: "ok@example.com" },
      { ticket: "tkt-ok", cookie: "awb_oauth_binding=bind-secret" }
    );
    expect(res.headers.location as string).toMatch(/^http:\/\/127\.0\.0\.1\/cb\?code=/);
    expect(await tableCount("oauth_auth_codes")).toBe(1);
  });
});

describe("deciding", () => {
  async function newPending(email = "new@example.com", sub = "g-1") {
    await signInGoogle({ sub, email });
    const user = (await userByEmail(email))!;
    const request = (await requestsFor(user.id))[0];
    return { user, request };
  }

  it("approve activates the user, and the next sign-in issues a session", async () => {
    const { user, request } = await newPending();
    const r = await decide(ADMIN, request.id, "approve", { kinds: [ACCOUNT_ACTIVATE] });
    expect(r).toMatchObject({ ok: true, outcome: "approved" });
    expect(await getUserStatus(user.id)).toBe("active");
    expect(await userByEmail("new@example.com")).toMatchObject({ disabled_at: null });
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    const token = new URL(res.headers.location as string).hash.match(/token=([^&]+)/)![1];
    expect((await verifySession(token)).userId).toBe(user.id);
  });

  it("only an admin may decide; anyone else gets not found", async () => {
    const { request } = await newPending();
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u-dev", "dev@example.com"]);
    expect(await decide({ userId: "u-dev", email: "dev@example.com" }, request.id, "approve", { kinds: [ACCOUNT_ACTIVATE] })).toEqual({ ok: false });
    expect(await decide({ userId: "u-dev", email: null }, request.id, "approve", { kinds: [ACCOUNT_ACTIVATE] })).toEqual({ ok: false });
  });

  it("reject leaves the user blocked; a sign-in soon after shows declined and opens no new request", async () => {
    const { user, request } = await newPending();
    await decide(ADMIN, request.id, "reject", { kinds: [ACCOUNT_ACTIVATE], note: "private reason" });
    expect(await getUserStatus(user.id)).toBe("pending");
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    expect(res.headers.location).toBe(`${PORTAL}/waiting`);
    // The note is not part of the redirect.
    expect(res.headers.location as string).not.toContain("private");
    expect((await requestsFor(user.id)).map((r) => r.status)).toEqual(["rejected"]);
  });

  it("a sign-in more than 24 hours after a rejection opens a fresh request", async () => {
    const { user, request } = await newPending();
    await decide(ADMIN, request.id, "reject", { kinds: [ACCOUNT_ACTIVATE] });
    await db.run("UPDATE approval_requests SET decided_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000) - 25 * 3600, request.id]);
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    expect(res.headers.location).toBe(`${PORTAL}/waiting`);
    expect((await requestsFor(user.id)).map((r) => r.status).sort()).toEqual(["pending", "rejected"]);
  });

  it("an admin disabling the user between validate and apply closes the request as rejected and applies nothing", async () => {
    const { user, request } = await newPending();
    const realValidate = accountActivate.validate.bind(accountActivate);
    vi.spyOn(accountActivate, "validate").mockImplementation(async (r) => {
      const v = await realValidate(r);
      // The window the guarded transition closes.
      await db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
      return v;
    });
    const r = await decide(ADMIN, request.id, "approve", { kinds: [ACCOUNT_ACTIVATE] });
    expect(r).toMatchObject({ ok: true, outcome: "auto_rejected" });
    expect(await getUserStatus(user.id)).toBe("disabled");
    expect((await requestsFor(user.id)).map((x) => x.status)).toEqual(["rejected"]);
  });

  it("a user who is already active is approved as a no-op", async () => {
    const { user, request } = await newPending();
    await db.run("UPDATE users SET status = 'active', disabled_at = NULL WHERE id = ?", [user.id]);
    const r = await decide(ADMIN, request.id, "approve", { kinds: [ACCOUNT_ACTIVATE] });
    expect(r).toMatchObject({ ok: true, outcome: "already_satisfied" });
  });

  it("the audit row is the new user's, with the admin as actor, and carries no message or note", async () => {
    const { user, request } = await newPending();
    await decide(ADMIN, request.id, "approve", { kinds: [ACCOUNT_ACTIVATE], note: "welcome aboard secret-note" });
    const rows = await db.all<{ user_id: string; actor_user_id: string | null; action: string; tool: string }>(
      "SELECT user_id, actor_user_id, action, tool FROM audit_log ORDER BY id"
    );
    expect(rows.map((r) => [r.action, r.user_id, r.actor_user_id])).toEqual([
      ["APPROVAL_REQUEST", user.id, null],
      ["APPROVAL_APPROVE", user.id, ADMIN.userId],
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret-note");
  });
});

describe("waiting room cookie and state endpoint", () => {
  function waitingCookie(res: { headers: Record<string, unknown> }): string {
    const raw = ([] as string[]).concat(res.headers["set-cookie"] as string | string[]).find((c) => c.startsWith("awb_waiting="));
    expect(raw).toBeTruthy();
    return raw as string;
  }
  async function poll(cookie?: string) {
    return app.inject({ method: "GET", url: "/api/auth/waiting", headers: cookie ? { cookie } : {} });
  }
  const pair = (setCookie: string) => setCookie.split(";")[0];

  beforeEach(() => _resetWaitingRateForTest());

  it("sets a signed, httpOnly, Lax, path-scoped 7 day cookie on the pending redirect (google)", async () => {
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    const c = waitingCookie(res);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/api/auth");
    expect(c).toContain(`Max-Age=${7 * 24 * 3600}`);
    expect(c).not.toContain("new@example.com");
  });

  it("sets the cookie for keycloak and reports that provider", async () => {
    const res = await signInKeycloak({ sub: "kc-1", email: "kc@example.com" });
    const out = await poll(pair(waitingCookie(res)));
    expect(out.json()).toEqual({ state: "pending", provider: "keycloak" });
  });

  it("reports pending, then active after approval, then declined after rejection", async () => {
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    const cookie = pair(waitingCookie(res));
    const out = await poll(cookie);
    expect(out.statusCode).toBe(200);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(out.json()).toEqual({ state: "pending", provider: "google" });
    const user = (await userByEmail("new@example.com"))!;
    const [req] = await requestsFor(user.id);
    await decide(ADMIN, req.id, "approve", { kinds: [ACCOUNT_ACTIVATE] });
    expect((await poll(cookie)).json()).toEqual({ state: "active", provider: "google" });
  });

  it("reports declined (never the note) and opens no new request", async () => {
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    const user = (await userByEmail("new@example.com"))!;
    const [req] = await requestsFor(user.id);
    await decide(ADMIN, req.id, "reject", { kinds: [ACCOUNT_ACTIVATE], note: "private reason" });
    const out = await poll(pair(waitingCookie(res)));
    expect(out.json()).toEqual({ state: "declined", provider: "google" });
    expect(out.body).not.toContain("private");
    expect((await requestsFor(user.id)).map((r) => r.status)).toEqual(["rejected"]);
  });

  it("returns none for a missing, tampered, forged-for-another-secret or expired cookie", async () => {
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    const good = pair(waitingCookie(res));
    expect((await poll()).json()).toEqual({ state: "none", provider: null });
    const [body, sig] = good.slice("awb_waiting=".length).split(".");
    const other = Buffer.from(JSON.stringify({ u: "someone-else", p: "google", e: 9999999999 })).toString("base64url");
    expect((await poll(`awb_waiting=${other}.${sig}`)).json().state).toBe("none");
    expect((await poll(`awb_waiting=${body}.${sig.slice(0, -2)}xx`)).json().state).toBe("none");
    expect((await poll("awb_waiting=garbage")).json().state).toBe("none");
    const user = (await userByEmail("new@example.com"))!;
    const expired = mintWaitingValue(user.id, "google", Date.now() - 8 * 24 * 3600 * 1000);
    expect((await poll(`awb_waiting=${expired}`)).json().state).toBe("none");
  });

  it("returns none for a disabled or missing user, and leaks nothing but state and provider", async () => {
    const res = await signInGoogle({ sub: "g-1", email: "new@example.com" });
    const cookie = pair(waitingCookie(res));
    const user = (await userByEmail("new@example.com"))!;
    const pending = await poll(cookie);
    expect(Object.keys(pending.json()).sort()).toEqual(["provider", "state"]);
    expect(pending.body).not.toContain(user.id);
    expect(pending.body).not.toContain("example.com");
    await db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    expect((await poll(cookie)).json()).toEqual({ state: "none", provider: null });
    await db.run("DELETE FROM approval_requests");
    await db.run("DELETE FROM users WHERE id = ?", [user.id]);
    expect((await poll(cookie)).json()).toEqual({ state: "none", provider: null });
  });

  it("rate limits a flood from one address", async () => {
    let last = 200;
    for (let i = 0; i < 70; i++) last = (await poll()).statusCode;
    expect(last).toBe(429);
  });
});
