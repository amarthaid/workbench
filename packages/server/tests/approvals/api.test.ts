import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

let tmp: string;
vi.mock("../../src/spaces/dir", () => ({ spacesRoot: () => tmp }));

import { config } from "../../src/config";
import { db } from "../../src/db";
import { installAuditContext } from "../../src/audit/context";
import { registerAdminRoutes } from "../../src/api/admin-routes";
import { registerApprovalRoutes } from "../../src/approvals/routes";
import { registerSpaceApiRoutes } from "../../src/spaces/api";
import { signSession } from "../../src/auth/session";
import { signAccessToken } from "../../src/auth/oauth-server/tokens";
import { setApiKey } from "../../src/auth/users";
import { getShares, setShares, upsertSpace, toolsHash, updateSpaceMeta } from "../../src/spaces/store";
import { ACCOUNT_ACTIVATE, SPACE_ACCESS_MAX_PER_SPACE_DAY } from "../../src/approvals/kinds";
import { resetSpacesDb, seedUser, writeSpaceFiles } from "../spaces/helpers";

let app: FastifyInstance;
const tokens: Record<string, string> = {};
const prevAdmins = config.ADMIN_EMAILS;
const USERS: Array<[string, string]> = [
  ["u-owner", "dev@example.com"],
  ["u-asker", "qa@example.com"],
  ["u-other", "other@example.com"],
  ["u-admin", "admin@example.com"],
];

function as(user: string) {
  return { authorization: `Bearer ${tokens[user]}` };
}

async function ask(user: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/approvals", headers: as(user), payload: body });
}

// Times are whole seconds, so rows made in the same second tie: prefer the open one.
async function pendingFor(subject: string, requester: string) {
  return db.get<{ id: string; status: string }>(
    "SELECT id, status FROM approval_requests WHERE subject = ? AND requester_id = ? ORDER BY (status = 'pending') DESC, created_at DESC, id DESC",
    [subject, requester]
  );
}

async function count() {
  return Number((await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM approval_requests"))?.n);
}

async function seedPendingSignup(id: string, email: string, createdAt: number) {
  await db.run("INSERT INTO users (id, email, status, disabled_at) VALUES (?, ?, 'pending', ?)", [id, email, createdAt]);
  await db.run(
    "INSERT INTO approval_requests (id, kind, subject, requester_id, message, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    [`req-${id}`, ACCOUNT_ACTIVATE, id, id, "let me in", createdAt]
  );
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approvals-api-"));
  await resetSpacesDb();
  config.ADMIN_EMAILS = ["admin@example.com"];
  for (const [id, email] of USERS) {
    await seedUser(id, email);
    tokens[id] = await signSession({ userId: id, email });
  }
  await upsertSpace({ name: "s1", ownerId: "u-owner", title: "Items", tools: ["acme_list_items"], visibility: "users" });
  await setShares("s1", "u-owner", ["other@example.com"]);
  writeSpaceFiles(tmp, "s1", { "index.html": "<p>s1</p>" });

  app = Fastify();
  installAuditContext(app);
  await registerAdminRoutes(app);
  await registerSpaceApiRoutes(app);
  await registerApprovalRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  config.ADMIN_EMAILS = prevAdmins;
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await resetSpacesDb();
});

describe("portal session guard", () => {
  it("refuses no credential, an API key, an OAuth access token and a junk bearer", async () => {
    const { apiKey } = await setApiKey("u-asker");
    const oauth = await signAccessToken({ userId: "u-asker", scope: "mcp", clientId: "c1" });
    const url = "/api/approvals?scope=mine";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { "x-workbench-api-key": apiKey } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${apiKey}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${oauth}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: as("u-asker") })).statusCode).toBe(200);
    // Every method is behind it.
    expect((await app.inject({ method: "POST", url: "/api/approvals", payload: { kind: "space.access", subject: "s1" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/approvals/x/approve" })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/api/approvals/x" })).statusCode).toBe(401);
  });

  it("refuses a disabled or pending user's session", async () => {
    await db.run("UPDATE users SET status = 'pending' WHERE id = ?", ["u-asker"]);
    expect((await app.inject({ method: "GET", url: "/api/approvals?scope=mine", headers: as("u-asker") })).statusCode).toBe(401);
  });
});

describe("POST /api/approvals", () => {
  it("answers one fixed 202 body whatever the Space is, and stores a request only for a real one", async () => {
    await upsertSpace({ name: "priv", ownerId: "u-owner", title: "P", tools: [], visibility: "private" });
    writeSpaceFiles(tmp, "priv", { "index.html": "x" });
    await upsertSpace({ name: "org", ownerId: "u-owner", title: "O", tools: [], visibility: "org" });
    writeSpaceFiles(tmp, "org", { "index.html": "x" });
    const bodies = new Set<string>();
    for (const subject of ["s1", "missing", "priv", "org", "Bad Name!"]) {
      const res = await ask("u-asker", { kind: "space.access", subject, message: "hello" });
      expect(res.statusCode).toBe(202);
      bodies.add(res.body);
    }
    // Already on the list: the same answer.
    const onList = await ask("u-other", { kind: "space.access", subject: "s1" });
    expect(onList.statusCode).toBe(202);
    bodies.add(onList.body);
    expect([...bodies]).toEqual(['{"accepted":true}']);
    expect(await count()).toBe(1);
    expect(await pendingFor("s1", "u-asker")).toMatchObject({ status: "pending" });
  });

  it("400s for account.activate, an unknown kind and a missing subject", async () => {
    expect((await ask("u-asker", { kind: "account.activate", subject: "u-asker" })).statusCode).toBe(400);
    expect((await ask("u-asker", { kind: "nope", subject: "s1" })).statusCode).toBe(400);
    expect((await ask("u-asker", { kind: "space.access" })).statusCode).toBe(400);
    expect((await ask("u-asker", { kind: "space.access", subject: "" })).statusCode).toBe(400);
    expect((await ask("u-asker", { kind: "space.access", subject: 5 })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/approvals", headers: as("u-asker") })).statusCode).toBe(400);
    expect(await count()).toBe(0);
  });

  it("429s past the per-Space limit, with a body that does not mention the Space", async () => {
    for (let i = 0; i < SPACE_ACCESS_MAX_PER_SPACE_DAY; i++) {
      expect((await ask("u-asker", { kind: "space.access", subject: "s1" })).statusCode).toBe(202);
      const row = await pendingFor("s1", "u-asker");
      await app.inject({ method: "DELETE", url: `/api/approvals/${row!.id}`, headers: as("u-asker") });
    }
    const res = await ask("u-asker", { kind: "space.access", subject: "s1" });
    expect(res.statusCode).toBe(429);
    expect(res.body).not.toContain("s1");
  });
});

describe("GET /api/approvals", () => {
  it("inbox: the owner sees the request with the asker's email, the delegated flag and the message", async () => {
    await ask("u-asker", { kind: "space.access", subject: "s1", message: "from the QA team" });
    const res = await app.inject({ method: "GET", url: "/api/approvals?scope=inbox", headers: as("u-owner") });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: expect.any(String),
      kind: "space.access",
      subject: "s1",
      subject_label: "s1",
      requester_email: "qa@example.com",
      message: "from the QA team",
      status: "pending",
      created_at: expect.any(Number),
      delegated: false,
    });
    // Nobody else's inbox has it, the admin's included.
    for (const u of ["u-asker", "u-other", "u-admin"]) {
      const r = await app.inject({ method: "GET", url: "/api/approvals?scope=inbox", headers: as(u) });
      expect(r.json().items).toEqual([]);
    }
  });

  it("inbox: flags a delegated Space", async () => {
    await updateSpaceMeta("s1", "u-owner", { accessMode: "owner", confirmDelegation: true, expectedToolsHash: toolsHash(["acme_list_items"]) });
    await ask("u-asker", { kind: "space.access", subject: "s1" });
    const { items } = (await app.inject({ method: "GET", url: "/api/approvals?scope=inbox", headers: as("u-owner") })).json();
    expect(items[0].delegated).toBe(true);
  });

  it("mine: my own requests of any status, newest first, with no requester email; account.activate never appears", async () => {
    await upsertSpace({ name: "s2", ownerId: "u-owner", title: "Two", tools: [], visibility: "users" });
    writeSpaceFiles(tmp, "s2", { "index.html": "x" });
    await ask("u-asker", { kind: "space.access", subject: "s1" });
    await ask("u-asker", { kind: "space.access", subject: "s2" });
    const s1 = await pendingFor("s1", "u-asker");
    await db.run("UPDATE approval_requests SET created_at = created_at - 100 WHERE id = ?", [s1!.id]);
    await app.inject({ method: "POST", url: `/api/approvals/${(await pendingFor("s2", "u-asker"))!.id}/reject`, headers: as("u-owner"), payload: { note: "later" } });
    // The asker's own signup request, as a row (a real one only exists before they could sign in).
    await db.run(
      "INSERT INTO approval_requests (id, kind, subject, requester_id, status, created_at) VALUES ('su', ?, 'u-asker', 'u-asker', 'pending', ?)",
      [ACCOUNT_ACTIVATE, Math.floor(Date.now() / 1000) + 50]
    );
    const { items } = (await app.inject({ method: "GET", url: "/api/approvals?scope=mine", headers: as("u-asker") })).json();
    expect(items.map((i: { subject: string; status: string }) => [i.subject, i.status])).toEqual([
      ["s2", "rejected"],
      ["s1", "pending"],
    ]);
    expect(items.every((i: { requester_email: unknown; kind: string }) => i.requester_email === null && i.kind === "space.access")).toBe(true);
    // The rejection note is not in the requester's list.
    expect(JSON.stringify(items)).not.toContain("later");
  });

  it("400s without a valid scope", async () => {
    expect((await app.inject({ method: "GET", url: "/api/approvals", headers: as("u-owner") })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/approvals?scope=all", headers: as("u-owner") })).statusCode).toBe(400);
  });
});

describe("approve, reject and cancel", () => {
  async function opened() {
    await ask("u-asker", { kind: "space.access", subject: "s1", message: "hi" });
    return (await pendingFor("s1", "u-asker"))!.id;
  }

  it("the owner approves: {ok:true}, the asker can then open the Space", async () => {
    const id = await opened();
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u-asker") })).statusCode).toBe(404);
    const res = await app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, headers: as("u-owner") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await getShares("s1")).toEqual(["other@example.com", "qa@example.com"]);
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u-asker") })).statusCode).toBe(200);
    // A second decision on a decided request is 404.
    expect((await app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, headers: as("u-owner") })).statusCode).toBe(404);
  });

  it("the owner rejects with a note: {ok:true}, nothing is shared", async () => {
    const id = await opened();
    const res = await app.inject({ method: "POST", url: `/api/approvals/${id}/reject`, headers: as("u-owner"), payload: { note: "not now" } });
    expect(res.json()).toEqual({ ok: true });
    expect(await getShares("s1")).toEqual(["other@example.com"]);
    expect((await pendingFor("s1", "u-asker"))?.status).toBe("rejected");
  });

  it("404 for a stranger, an admin, the asker themselves and an unknown id (never 403)", async () => {
    const id = await opened();
    for (const u of ["u-other", "u-admin", "u-asker"]) {
      for (const action of ["approve", "reject"]) {
        const res = await app.inject({ method: "POST", url: `/api/approvals/${id}/${action}`, headers: as(u) });
        expect(res.statusCode).toBe(404);
      }
    }
    expect((await app.inject({ method: "POST", url: "/api/approvals/nope/approve", headers: as("u-owner") })).statusCode).toBe(404);
    expect((await pendingFor("s1", "u-asker"))?.status).toBe("pending");
  });

  it("the asker cancels their own; nobody else can", async () => {
    const id = await opened();
    expect((await app.inject({ method: "DELETE", url: `/api/approvals/${id}`, headers: as("u-owner") })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/approvals/${id}`, headers: as("u-other") })).statusCode).toBe(404);
    const res = await app.inject({ method: "DELETE", url: `/api/approvals/${id}`, headers: as("u-asker") });
    expect(res.json()).toEqual({ ok: true });
    expect((await pendingFor("s1", "u-asker"))?.status).toBe("cancelled");
    expect((await app.inject({ method: "DELETE", url: `/api/approvals/${id}`, headers: as("u-asker") })).statusCode).toBe(404);
  });

  it("refuses account.activate rows on every portal endpoint, even for an admin", async () => {
    await seedPendingSignup("u-new", "new@example.com", 100);
    // The requester has no session at all (pending users get none): 401. An admin gets 404 here.
    const u = "u-admin";
    expect((await app.inject({ method: "POST", url: "/api/approvals/req-u-new/approve", headers: as(u) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/approvals/req-u-new/reject", headers: as(u) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/approvals/req-u-new", headers: as(u) })).statusCode).toBe(404);
    const row = await db.get<{ status: string }>("SELECT status FROM users WHERE id = 'u-new'");
    expect(row?.status).toBe("pending");
  });
});

describe("GET /api/spaces gains pending_requests for the owner", () => {
  it("counts open requests on the owner's Space; others see no such field", async () => {
    await ask("u-asker", { kind: "space.access", subject: "s1" });
    const owned = (await app.inject({ method: "GET", url: "/api/spaces", headers: as("u-owner") })).json().spaces;
    expect(owned.find((s: { name: string }) => s.name === "s1").pending_requests).toBe(1);
    const seen = (await app.inject({ method: "GET", url: "/api/spaces", headers: as("u-other") })).json().spaces;
    expect(seen.find((s: { name: string }) => s.name === "s1")).not.toHaveProperty("pending_requests");
    const id = (await pendingFor("s1", "u-asker"))!.id;
    await app.inject({ method: "POST", url: `/api/approvals/${id}/reject`, headers: as("u-owner") });
    const after = (await app.inject({ method: "GET", url: "/api/spaces", headers: as("u-owner") })).json().spaces;
    expect(after.find((s: { name: string }) => s.name === "s1").pending_requests).toBe(0);
  });
});

describe("/api/admin/approvals (account.activate, behind the admin gate)", () => {
  const admin = () => ({ authorization: `Bearer ${tokens["u-admin"]}` });

  it("refuses no credential, a non-admin session, and an admin's API key or OAuth token", async () => {
    await seedPendingSignup("u-new", "new@example.com", 100);
    const { apiKey } = await setApiKey("u-admin");
    const oauth = await signAccessToken({ userId: "u-admin", scope: "mcp", clientId: "c1" });
    const targets = [
      { method: "GET", url: "/api/admin/approvals" },
      { method: "POST", url: "/api/admin/approvals/req-u-new/approve" },
      { method: "POST", url: "/api/admin/approvals/req-u-new/reject" },
    ] as const;
    for (const t of targets) {
      expect((await app.inject({ ...t })).statusCode).toBe(401);
      expect((await app.inject({ ...t, headers: { "x-workbench-api-key": apiKey } })).statusCode).toBe(401);
      expect((await app.inject({ ...t, headers: { authorization: `Bearer ${apiKey}` } })).statusCode).toBe(401);
      expect((await app.inject({ ...t, headers: { authorization: `Bearer ${oauth}` } })).statusCode).toBe(401);
      expect((await app.inject({ ...t, headers: as("u-owner") })).statusCode).toBe(403);
    }
    const row = await db.get<{ status: string }>("SELECT status FROM users WHERE id = 'u-new'");
    expect(row?.status).toBe("pending");
  });

  it("lists pending sign-ups newest first with the total, and pages with a cursor", async () => {
    await seedPendingSignup("u-n1", "n1@example.com", 100);
    await seedPendingSignup("u-n2", "n2@example.com", 200);
    await seedPendingSignup("u-n3", "n3@example.com", 300);
    // A decided one is not listed and not counted.
    await seedPendingSignup("u-n4", "n4@example.com", 400);
    await db.run("UPDATE approval_requests SET status = 'rejected' WHERE id = 'req-u-n4'");

    const first = (await app.inject({ method: "GET", url: "/api/admin/approvals?limit=2", headers: admin() })).json();
    expect(first.pending_total).toBe(3);
    expect(first.items).toEqual([
      { id: "req-u-n3", kind: "account.activate", requester_email: "n3@example.com", message: "let me in", created_at: 300 },
      { id: "req-u-n2", kind: "account.activate", requester_email: "n2@example.com", message: "let me in", created_at: 200 },
    ]);
    expect(typeof first.next_cursor).toBe("string");
    const second = (await app.inject({ method: "GET", url: `/api/admin/approvals?limit=2&cursor=${first.next_cursor}`, headers: admin() })).json();
    expect(second.items.map((i: { id: string }) => i.id)).toEqual(["req-u-n1"]);
    expect(second.next_cursor).toBeNull();
    // space.access requests never show here.
    await ask("u-asker", { kind: "space.access", subject: "s1" });
    const all = (await app.inject({ method: "GET", url: "/api/admin/approvals", headers: admin() })).json();
    expect(all.items.every((i: { kind: string }) => i.kind === "account.activate")).toBe(true);
    expect(all.pending_total).toBe(3);
  });

  it("approve activates the user and answers {ok:true}; a second approve is 404", async () => {
    await seedPendingSignup("u-new", "new@example.com", 100);
    const res = await app.inject({ method: "POST", url: "/api/admin/approvals/req-u-new/approve", headers: admin() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await db.get("SELECT 1 AS n FROM users WHERE id = 'u-new' AND status = 'active' AND disabled_at IS NULL")).toBeTruthy();
    expect((await app.inject({ method: "POST", url: "/api/admin/approvals/req-u-new/approve", headers: admin() })).statusCode).toBe(404);
  });

  it("reject keeps the user pending, takes a note, and answers {ok:true}", async () => {
    await seedPendingSignup("u-new", "new@example.com", 100);
    const res = await app.inject({ method: "POST", url: "/api/admin/approvals/req-u-new/reject", headers: admin(), payload: { note: "not on the list" } });
    expect(res.json()).toEqual({ ok: true });
    const user = await db.get<{ status: string }>("SELECT status FROM users WHERE id = 'u-new'");
    expect(user?.status).toBe("pending");
    const req = await db.get<{ status: string; decision_note: string; decided_by: string }>(
      "SELECT status, decision_note, decided_by FROM approval_requests WHERE id = 'req-u-new'"
    );
    expect(req).toEqual({ status: "rejected", decision_note: "not on the list", decided_by: "u-admin" });
  });

  it("404 for an unknown id and for a space.access request, even for an admin", async () => {
    await ask("u-asker", { kind: "space.access", subject: "s1" });
    const spaceReq = (await pendingFor("s1", "u-asker"))!.id;
    for (const id of ["nope", spaceReq]) {
      expect((await app.inject({ method: "POST", url: `/api/admin/approvals/${id}/approve`, headers: admin() })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `/api/admin/approvals/${id}/reject`, headers: admin() })).statusCode).toBe(404);
    }
    expect((await pendingFor("s1", "u-asker"))?.status).toBe("pending");
  });
});
