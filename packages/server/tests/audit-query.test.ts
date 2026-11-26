import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import {
  encodeCursor,
  decodeCursor,
  listAllAuditEvents,
  listAuditEvents,
  listActivityPeople,
  parseAuditFilters,
  summarizeAudit,
} from "../src/audit/query";

const NOW = Math.floor(Date.now() / 1000);

// Insert one audit row. `success` is a real boolean: the column is BOOLEAN and
// PostgreSQL rejects 1/0 for it; the SQLite adapter converts on the way in.
async function seed(o: {
  userId: string;
  integration?: string | null;
  tool?: string;
  success?: boolean;
  error?: string | null;
  durationMs?: number | null;
  createdAt?: number;
  userEmail?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  clientName?: string | null;
  authMethod?: string | null;
  sourceIp?: string | null;
  userAgent?: string | null;
}) {
  await db.run(
    `INSERT INTO audit_log (user_id, integration, tool, action, success, error, duration_ms, created_at,
                            user_email, actor_user_id, actor_email, client_name,
                            auth_method, source_ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      o.userId,
      o.integration === undefined ? "acme" : o.integration,
      o.tool ?? "acme_search",
      "EXECUTE",
      o.success ?? true,
      o.error ?? null,
      o.durationMs ?? 100,
      o.createdAt ?? NOW,
      o.userEmail ?? null,
      o.actorUserId ?? null,
      o.actorEmail ?? null,
      o.clientName ?? null,
      o.authMethod ?? null,
      o.sourceIp ?? null,
      o.userAgent ?? null,
    ]
  );
}

// Synthetic people for the delegation cases: the owner lends access through a
// Space, the viewer calls with it, the bystander is neither.
const OWNER = { id: "dlg-owner", email: "dev@example.com" };
const VIEWER = { id: "dlg-viewer", email: "qa@example.com" };
const BYSTANDER = { id: "dlg-bystander", email: "ops@example.com" };

async function seedUsers() {
  for (const u of [OWNER, VIEWER, BYSTANDER]) {
    // Other test files share this database and may leave a user with the same
    // email behind (users.email is unique), so clear by id and by email first.
    await db.run("DELETE FROM users WHERE id = ? OR email = ?", [u.id, u.email]);
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", [u.id, u.email]);
  }
}

// One delegated Space call, as the call path writes it: the owner's access ran,
// the viewer triggered it.
async function seedDelegated(o: { tool?: string; createdAt?: number } = {}) {
  await seed({
    userId: OWNER.id,
    userEmail: OWNER.email,
    actorUserId: VIEWER.id,
    actorEmail: VIEWER.email,
    clientName: "space:team-dash",
    tool: o.tool ?? "acme_search",
    createdAt: o.createdAt,
  });
}

beforeEach(async () => {
  await db.exec("DELETE FROM audit_log");
  await db.run("DELETE FROM users WHERE id IN (?, ?, ?)", [OWNER.id, VIEWER.id, BYSTANDER.id]);
});

describe("cursor encoding", () => {
  it("round-trips a position", () => {
    const c = encodeCursor(1757001600, 8814);
    expect(decodeCursor(c)).toEqual({ createdAt: 1757001600, id: 8814 });
  });

  it("rejects a cursor that is not the expected shape", () => {
    expect(decodeCursor("not-base64-of-anything-useful")).toBeNull();
    expect(decodeCursor(Buffer.from("nope").toString("base64url"))).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("listAuditEvents", () => {
  it("returns only the requested user's rows, newest first", async () => {
    await seed({ userId: "user-1", tool: "older", createdAt: NOW - 60 });
    await seed({ userId: "user-1", tool: "newer", createdAt: NOW });
    await seed({ userId: "user-2", tool: "other-user" });

    const rows = await listAuditEvents({ userId: "user-1", limit: 10 });
    expect(rows.map((r) => r.tool)).toEqual(["newer", "older"]);
  });

  it("normalizes success into a real boolean", async () => {
    await seed({ userId: "user-1", success: false, error: "boom" });
    const [row] = await listAuditEvents({ userId: "user-1", limit: 10 });
    expect(row.success).toBe(false);
    expect(row.error).toBe("boom");
  });

  it("filters by integration", async () => {
    await seed({ userId: "user-1", integration: "acme" });
    await seed({ userId: "user-1", integration: "demo-repo" });
    const rows = await listAuditEvents({ userId: "user-1", limit: 10, integration: "demo-repo" });
    expect(rows).toHaveLength(1);
    expect(rows[0].integration).toBe("demo-repo");
  });

  it("filters by status", async () => {
    await seed({ userId: "user-1", tool: "ok_tool", success: true });
    await seed({ userId: "user-1", tool: "bad_tool", success: false });

    const failures = await listAuditEvents({ userId: "user-1", limit: 10, status: "error" });
    expect(failures.map((r) => r.tool)).toEqual(["bad_tool"]);

    const wins = await listAuditEvents({ userId: "user-1", limit: 10, status: "success" });
    expect(wins.map((r) => r.tool)).toEqual(["ok_tool"]);
  });

  it("pages past rows that share a created_at, without repeating or skipping", async () => {
    // Three rows on the same second: only the id tiebreak keeps paging correct.
    await seed({ userId: "user-1", tool: "a", createdAt: NOW });
    await seed({ userId: "user-1", tool: "b", createdAt: NOW });
    await seed({ userId: "user-1", tool: "c", createdAt: NOW });

    const first = await listAuditEvents({ userId: "user-1", limit: 2 });
    expect(first).toHaveLength(2);

    const last = first[first.length - 1];
    const second = await listAuditEvents({
      userId: "user-1",
      limit: 2,
      cursor: { createdAt: last.created_at, id: last.id },
    });

    const seen = [...first, ...second].map((r) => r.tool);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("listAuditEvents with delegated calls", () => {
  beforeEach(seedUsers);

  it("shows the owner the row as for_me, naming the viewer", async () => {
    await seedDelegated();
    const rows = await listAuditEvents({ userId: OWNER.id, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].delegation).toEqual({ direction: "for_me", other_email: VIEWER.email, space: "team-dash" });
  });

  it("shows the viewer the same row as by_me, naming the owner", async () => {
    await seedDelegated();
    const owner = await listAuditEvents({ userId: OWNER.id, limit: 10 });
    const viewer = await listAuditEvents({ userId: VIEWER.id, limit: 10 });
    expect(viewer).toHaveLength(1);
    expect(viewer[0].id).toBe(owner[0].id);
    expect(viewer[0].delegation).toEqual({ direction: "by_me", other_email: OWNER.email, space: "team-dash" });
  });

  it("shows a third user nothing", async () => {
    await seedDelegated();
    expect(await listAuditEvents({ userId: BYSTANDER.id, limit: 10 })).toEqual([]);
  });

  it("never exposes the other person's user id", async () => {
    await seedDelegated();
    const [viewerRow] = await listAuditEvents({ userId: VIEWER.id, limit: 10 });
    const [ownerRow] = await listAuditEvents({ userId: OWNER.id, limit: 10 });
    expect(JSON.stringify(viewerRow)).not.toContain(OWNER.id);
    expect(JSON.stringify(ownerRow)).not.toContain(VIEWER.id);
  });

  it("gives ordinary rows a null delegation", async () => {
    await seed({ userId: OWNER.id, tool: "own_call" });
    const [row] = await listAuditEvents({ userId: OWNER.id, limit: 10 });
    expect(row.tool).toBe("own_call");
    expect(row.delegation).toBeNull();
  });

  it("uses the other person's current email, falling back to the stored one", async () => {
    await seedDelegated();
    await db.run("UPDATE users SET email = ? WHERE id = ?", ["qa2@example.com", VIEWER.id]);
    const [renamed] = await listAuditEvents({ userId: OWNER.id, limit: 10 });
    expect(renamed.delegation?.other_email).toBe("qa2@example.com");

    await db.run("DELETE FROM users WHERE id = ?", [OWNER.id]);
    const [gone] = await listAuditEvents({ userId: VIEWER.id, limit: 10 });
    expect(gone.delegation?.other_email).toBe(OWNER.email);
  });

  it("leaves space null when the client is not a Space", async () => {
    await seed({ userId: OWNER.id, actorUserId: VIEWER.id, actorEmail: VIEWER.email, clientName: "cli" });
    const [row] = await listAuditEvents({ userId: VIEWER.id, limit: 10 });
    expect(row.delegation).toEqual({ direction: "by_me", other_email: OWNER.email, space: null });
  });

  it("keeps the integration and status filters inside the OR", async () => {
    await seedDelegated({ tool: "delegated_ok" });
    await seed({ userId: BYSTANDER.id, integration: "demo-repo", success: false, tool: "not_mine" });
    await seed({ userId: VIEWER.id, integration: "demo-repo", success: false, tool: "mine_bad" });

    const bad = await listAuditEvents({ userId: VIEWER.id, limit: 10, status: "error" });
    expect(bad.map((r) => r.tool)).toEqual(["mine_bad"]);
    const acme = await listAuditEvents({ userId: VIEWER.id, limit: 10, integration: "acme" });
    expect(acme.map((r) => r.tool)).toEqual(["delegated_ok"]);
  });

  it("pages correctly across a mix of own and delegated rows", async () => {
    await seed({ userId: VIEWER.id, tool: "own-a", createdAt: NOW });
    await seedDelegated({ tool: "dlg-b", createdAt: NOW });
    await seed({ userId: BYSTANDER.id, tool: "other", createdAt: NOW });
    await seed({ userId: VIEWER.id, tool: "own-c", createdAt: NOW - 1 });
    await seedDelegated({ tool: "dlg-d", createdAt: NOW - 2 });

    const seen: string[] = [];
    let cursor: { createdAt: number; id: number } | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await listAuditEvents({ userId: VIEWER.id, limit: 2, cursor });
      seen.push(...page.map((r) => r.tool ?? ""));
      if (page.length < 2) break;
      const last = page[page.length - 1];
      cursor = { createdAt: last.created_at, id: last.id };
    }
    expect(seen).toEqual(["dlg-b", "own-a", "own-c", "dlg-d"]);
  });
});

describe("listAllAuditEvents with delegated calls", () => {
  beforeEach(seedUsers);

  it("shows one row naming both people", async () => {
    await seedDelegated();
    const rows = await listAllAuditEvents({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: OWNER.id,
      user_email: OWNER.email,
      actor_user_id: VIEWER.id,
      actor_email: VIEWER.email,
      client_name: "space:team-dash",
    });
  });

  it("has a null actor on ordinary rows", async () => {
    await seed({ userId: OWNER.id });
    const [row] = await listAllAuditEvents({ limit: 10 });
    expect(row.actor_user_id).toBeNull();
    expect(row.actor_email).toBeNull();
  });

  it("matches the email filter on either person, case-insensitively", async () => {
    await seedDelegated({ tool: "delegated" });
    await seed({ userId: BYSTANDER.id, tool: "unrelated" });

    const byViewer = await listAllAuditEvents({ limit: 10, email: "QA@example.com" });
    expect(byViewer.map((r) => r.tool)).toEqual(["delegated"]);
    const byOwner = await listAllAuditEvents({ limit: 10, email: OWNER.email });
    expect(byOwner.map((r) => r.tool)).toEqual(["delegated"]);
  });

  it("matches the viewer's stored email after their user row is gone", async () => {
    await seedDelegated();
    await db.run("DELETE FROM users WHERE id = ?", [VIEWER.id]);
    const rows = await listAllAuditEvents({ limit: 10, email: VIEWER.email });
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_email).toBe(VIEWER.email);
  });
});

describe("summarizeAudit", () => {
  it("reports zero calls and a null rate on an empty window", async () => {
    const s = await summarizeAudit("user-1", 30);
    expect(s).toEqual({ toolCalls: 0, successRate: null, mostUsedIntegration: null });
  });

  it("counts calls and computes the success rate", async () => {
    await seed({ userId: "user-1", success: true });
    await seed({ userId: "user-1", success: true });
    await seed({ userId: "user-1", success: true });
    await seed({ userId: "user-1", success: false });

    const s = await summarizeAudit("user-1", 30);
    expect(s.toolCalls).toBe(4);
    expect(s.successRate).toBe(0.75);
  });

  it("ignores rows outside the window and rows belonging to other users", async () => {
    await seed({ userId: "user-1", createdAt: NOW });
    await seed({ userId: "user-1", createdAt: NOW - 40 * 86400 });
    await seed({ userId: "user-2", createdAt: NOW });

    const s = await summarizeAudit("user-1", 30);
    expect(s.toolCalls).toBe(1);
  });

  it("names the most-used integration, ignoring rows that have none", async () => {
    await seed({ userId: "user-1", integration: "acme" });
    await seed({ userId: "user-1", integration: "acme" });
    await seed({ userId: "user-1", integration: "demo-repo" });
    await seed({ userId: "user-1", integration: null });

    const s = await summarizeAudit("user-1", 30);
    expect(s.mostUsedIntegration).toBe("acme");
  });

  it("counts calls on your own access only: a viewer's delegated call is the owner's", async () => {
    await seedDelegated();
    expect((await summarizeAudit(OWNER.id, 30)).toolCalls).toBe(1);
    expect((await summarizeAudit(VIEWER.id, 30)).toolCalls).toBe(0);
  });
});


describe("audit filters", () => {
  const T = NOW - 10 * 86400;

  async function seedMix() {
    await seed({ userId: "u1", tool: "old", createdAt: T - 100, authMethod: "api_key" });
    await seed({ userId: "u1", tool: "mid", createdAt: T, authMethod: "oauth" });
    await seed({ userId: "u1", tool: "new", createdAt: T + 100, authMethod: "session" });
    await seed({ userId: "u1", tool: "curl", createdAt: T + 200, authMethod: "curl_token" });
    await seed({
      userId: "u1",
      tool: "viaspace",
      createdAt: T + 300,
      authMethod: "oauth",
      clientName: "space:team-dash",
      actorUserId: "u2",
      actorEmail: "qa@example.com",
    });
    await seed({
      userId: "u1",
      tool: "otherspace",
      createdAt: T + 400,
      authMethod: "api_key",
      clientName: "space:other",
      actorUserId: "u2",
      actorEmail: "qa@example.com",
    });
  }
  const tools = (rows: { tool: string | null }[]) => rows.map((r) => r.tool).sort();

  for (const [name, list] of [
    ["listAuditEvents", (f: object) => listAuditEvents({ userId: "u1", limit: 50, ...f })],
    ["listAllAuditEvents", (f: object) => listAllAuditEvents({ limit: 50, ...f })],
  ] as const) {
    describe(name, () => {
      it("filters by since and until, inclusive", async () => {
        await seedMix();
        expect(tools(await list({ since: T, until: T + 100 }))).toEqual(["mid", "new"]);
        expect(tools(await list({ since: T + 300 }))).toEqual(["otherspace", "viaspace"]);
        expect(tools(await list({ until: T }))).toEqual(["mid", "old"]);
      });

      it("filters delegated rows", async () => {
        await seedMix();
        expect(tools(await list({ delegated: true }))).toEqual(["otherspace", "viaspace"]);
      });

      it("filters by space name", async () => {
        await seedMix();
        expect(tools(await list({ space: "team-dash" }))).toEqual(["viaspace"]);
      });

      it("filters by credential; space is the client prefix, others exclude it", async () => {
        await seedMix();
        expect(tools(await list({ auth: "space" }))).toEqual(["otherspace", "viaspace"]);
        expect(tools(await list({ auth: "oauth" }))).toEqual(["mid"]);
        expect(tools(await list({ auth: "api_key" }))).toEqual(["old"]);
        expect(tools(await list({ auth: "session" }))).toEqual(["new"]);
        expect(tools(await list({ auth: "curl_token" }))).toEqual(["curl"]);
      });

      it("pages with filters set without repeating or skipping", async () => {
        for (let i = 0; i < 5; i++) await seed({ userId: "u1", tool: `t${i}`, createdAt: T, authMethod: "oauth" });
        await seed({ userId: "u1", tool: "excluded", createdAt: T, authMethod: "api_key" });
        const f = { since: T - 5, auth: "oauth" as const };
        const p1 = await list({ ...f, limit: 3 });
        const last = p1[2];
        const p2 = await list({ ...f, limit: 3, cursor: { createdAt: last.created_at, id: last.id } });
        expect(p1).toHaveLength(3);
        expect(tools([...p1, ...p2])).toEqual(["t0", "t1", "t2", "t3", "t4"]);
        expect(p2).toHaveLength(2);
      });
    });
  }
});

describe("parseAuditFilters", () => {
  const ok = (q: Record<string, string>, o?: { person?: boolean }) => parseAuditFilters(q, o);
  const now = Math.floor(Date.now() / 1000);

  it("rejects a range over 90 days, with or without until", () => {
    expect(ok({ since: String(now - 91 * 86400) })).toEqual({ ok: false, error: "range_too_large" });
    expect(ok({ since: "1000", until: String(1000 + 91 * 86400) })).toEqual({ ok: false, error: "range_too_large" });
    expect(ok({ since: String(now - 90 * 86400) }).ok).toBe(true);
  });

  it("keeps today's behaviour with no since", () => {
    expect(ok({})).toEqual({ ok: true, filters: {} });
    expect(ok({ until: "5" }).ok).toBe(true);
  });

  it("refuses bad values", () => {
    expect(ok({ since: "abc" })).toEqual({ ok: false, error: "invalid_since" });
    expect(ok({ since: "1.5" })).toEqual({ ok: false, error: "invalid_since" });
    expect(ok({ until: "x" })).toEqual({ ok: false, error: "invalid_until" });
    expect(ok({ since: "100", until: "50" })).toEqual({ ok: false, error: "invalid_range" });
    expect(ok({ delegated: "0" })).toEqual({ ok: false, error: "invalid_delegated" });
    expect(ok({ space: "a b" })).toEqual({ ok: false, error: "invalid_space" });
    expect(ok({ space: "x'; --" })).toEqual({ ok: false, error: "invalid_space" });
    expect(ok({ auth: "bogus" })).toEqual({ ok: false, error: "invalid_auth" });
    expect(ok({ status: "bogus" })).toEqual({ ok: false, error: "invalid_status" });
    expect(ok({ person: "a".repeat(255) }, { person: true })).toEqual({ ok: false, error: "invalid_person" });
  });

  it("only reads person when asked", () => {
    expect(ok({ person: "dev@example.com" })).toEqual({ ok: true, filters: {} });
    expect(ok({ person: "dev@example.com" }, { person: true })).toEqual({
      ok: true,
      filters: { person: "dev@example.com" },
    });
  });
});

describe("person filter and request fields", () => {
  beforeEach(seedUsers);

  async function seedScene() {
    await seedDelegated({ tool: "owner_ran_for_viewer" }); // OWNER access, VIEWER actor
    await seed({
      userId: VIEWER.id,
      userEmail: VIEWER.email,
      tool: "viewer_own",
      authMethod: "api_key",
      sourceIp: "203.0.113.9",
      userAgent: "agent/1",
    });
    // A third party's delegated rows: BYSTANDER used OWNER's access, and VIEWER used BYSTANDER's.
    await seed({
      userId: OWNER.id,
      userEmail: OWNER.email,
      actorUserId: BYSTANDER.id,
      actorEmail: BYSTANDER.email,
      clientName: "space:other",
      tool: "bystander_on_owner",
    });
    await seed({
      userId: BYSTANDER.id,
      userEmail: BYSTANDER.email,
      actorUserId: OWNER.id,
      actorEmail: OWNER.email,
      clientName: "space:other",
      tool: "owner_on_bystander",
    });
  }

  it("matches the other party, case-insensitively, inside the reader's scope", async () => {
    await seedScene();
    const asViewer = await listAuditEvents({ userId: VIEWER.id, limit: 50, person: "DEV@example.com" });
    expect(asViewer.map((r) => r.tool)).toEqual(["owner_ran_for_viewer"]);
    const asOwner = await listAuditEvents({ userId: OWNER.id, limit: 50, person: VIEWER.email });
    expect(asOwner.map((r) => r.tool)).toEqual(["owner_ran_for_viewer"]);
  });

  it("never returns rows outside the reader's own scope", async () => {
    await seedScene();
    // VIEWER names the bystander: the bystander rows involve OWNER, not VIEWER.
    const rows = await listAuditEvents({ userId: VIEWER.id, limit: 50, person: BYSTANDER.email });
    expect(rows).toEqual([]);
    // Naming oneself matches nothing either.
    expect(await listAuditEvents({ userId: VIEWER.id, limit: 50, person: VIEWER.email })).toEqual([]);
  });

  it("matches the current email, not only the recorded one", async () => {
    await seedScene();
    await db.run("UPDATE users SET email = ? WHERE id = ?", ["renamed@example.com", OWNER.id]);
    const rows = await listAuditEvents({ userId: VIEWER.id, limit: 50, person: "renamed@example.com" });
    expect(rows.map((r) => r.tool)).toEqual(["owner_ran_for_viewer"]);
  });

  it("nulls request fields on for_me rows, keeps them on by_me and own rows", async () => {
    await seedScene();
    await seed({
      userId: OWNER.id,
      userEmail: OWNER.email,
      actorUserId: VIEWER.id,
      actorEmail: VIEWER.email,
      clientName: "space:team-dash",
      authMethod: "oauth",
      sourceIp: "203.0.113.7",
      userAgent: "ua/2",
      tool: "with_origin",
    });
    const asOwner = await listAuditEvents({ userId: OWNER.id, limit: 50 });
    const forMe = asOwner.find((r) => r.tool === "with_origin")!;
    expect(forMe.delegation?.direction).toBe("for_me");
    expect([forMe.auth_method, forMe.client_name, forMe.source_ip, forMe.user_agent]).toEqual([null, null, null, null]);

    const asViewer = await listAuditEvents({ userId: VIEWER.id, limit: 50 });
    const byMe = asViewer.find((r) => r.tool === "with_origin")!;
    expect(byMe.delegation?.direction).toBe("by_me");
    expect(byMe.auth_method).toBe("oauth");
    expect(byMe.client_name).toBe("space:team-dash");
    expect(byMe.source_ip).toBe("203.0.113.7");
    expect(byMe.user_agent).toBe("ua/2");

    const own = asViewer.find((r) => r.tool === "viewer_own")!;
    expect(own.delegation).toBeNull();
    expect(own.auth_method).toBe("api_key");
    expect(own.source_ip).toBe("203.0.113.9");
  });

  it("lists distinct other parties with counts, most frequent first, in range", async () => {
    await seedScene();
    await seedDelegated({ tool: "second" });
    const people = await listActivityPeople(OWNER.id);
    // OWNER: VIEWER x2 (for me), BYSTANDER x1 (for me) + x1 (by me) = 2
    expect(people).toEqual([
      { email: "ops@example.com", count: 2 },
      { email: "qa@example.com", count: 2 },
    ]);
    expect(await listActivityPeople(VIEWER.id)).toEqual([{ email: "dev@example.com", count: 2 }]);
    expect(await listActivityPeople(OWNER.id, NOW + 100)).toEqual([]);
  });
});
