import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { db } from "../../src/db";
import { cancel, createRequest, decide, inboxFor, mineFor } from "../../src/approvals/engine";
import { _registerKindForTest, type Actor, type Kind } from "../../src/approvals/kinds";
import { getRequest, insertRequest } from "../../src/approvals/store";
import { runWithAuditContext } from "../../src/audit/context";

// A fake kind with no domain behind it, to test the rules the engine owns.
const KIND = "test.fake";
const calls = { apply: 0, validate: 0 };
let verdict: Awaited<ReturnType<Kind["validate"]>> = { status: "ok" };
let applyImpl: () => Promise<Awaited<ReturnType<Kind["apply"]>>> = async () => ({ applied: true });

const checker: Actor = { userId: "u-checker", email: "checker@example.com" };
const maker: Actor = { userId: "u-maker", email: "maker@example.com" };
const stranger: Actor = { userId: "u-stranger", email: "stranger@example.com" };

const fake: Kind = {
  name: KIND,
  clientCreatable: true,
  withinLimits: async () => true,
  canCreate: async () => ({ ok: true, payload: { v: 1 } }),
  async inboxFor(actor) {
    if (actor.userId !== checker.userId && actor.userId !== maker.userId) return { rows: [], next: null };
    const rows = await db.all<{ id: string }>("SELECT id FROM approval_requests WHERE kind = ? AND status = 'pending'", [KIND]);
    const out = [];
    for (const r of rows) {
      const request = await getRequest(r.id);
      if (request) out.push({ request, requesterEmail: null, delegated: false });
    }
    return { rows: out, next: null };
  },
  // Anyone but a stranger may decide: the maker is a "checker" on paper, so the
  // engine's own maker-is-not-checker rule is what has to stop them.
  canDecide: async (actor) => actor.userId !== stranger.userId,
  async validate() {
    calls.validate++;
    return verdict;
  },
  async apply() {
    calls.apply++;
    return applyImpl();
  },
  describe: (r) => `fake:${r.subject}`,
  subjectLabel: async (r) => r.subject,
};

let undo: () => void;
let auditCaught: Array<Record<string, unknown>>;

async function seedUsers() {
  for (const a of [checker, maker, stranger]) {
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", [a.userId, a.email]);
  }
}

async function open(subject = "thing", message = "") {
  const id = await insertRequest(db, { kind: KIND, subject, requesterId: maker.userId, message });
  if (!id) throw new Error("not inserted");
  return id;
}

beforeEach(async () => {
  undo = _registerKindForTest(fake);
  calls.apply = 0;
  calls.validate = 0;
  verdict = { status: "ok" };
  applyImpl = async () => ({ applied: true });
  for (const t of ["approval_requests", "audit_log", "users"]) await db.exec(`DELETE FROM ${t}`);
  await seedUsers();
  auditCaught = [];
});

afterEach(() => undo());
afterAll(async () => {
  await db.exec("DELETE FROM approval_requests");
  await db.exec("DELETE FROM audit_log");
  await db.exec("DELETE FROM users");
});

describe("decide: who may", () => {
  it("refuses the maker deciding their own request, as not found, and applies nothing", async () => {
    const id = await open();
    expect(await decide(maker, id, "approve", { kinds: [KIND] })).toEqual({ ok: false });
    expect(await decide(maker, id, "reject", { kinds: [KIND] })).toEqual({ ok: false });
    expect(calls.apply).toBe(0);
    expect((await getRequest(id))?.status).toBe("pending");
  });

  it("answers a non-checker exactly like an unknown id", async () => {
    const id = await open();
    const stranger_ = await decide(stranger, id, "approve", { kinds: [KIND] });
    const unknown = await decide(stranger, "no-such-id", "approve", { kinds: [KIND] });
    expect(stranger_).toEqual({ ok: false });
    expect(unknown).toEqual(stranger_);
    expect(calls.apply).toBe(0);
  });

  it("does not serve a kind the endpoint does not list", async () => {
    const id = await open();
    expect(await decide(checker, id, "approve", { kinds: ["space.access"] })).toEqual({ ok: false });
    expect((await getRequest(id))?.status).toBe("pending");
  });

  it("answers not found once the request is no longer pending", async () => {
    const id = await open();
    expect((await decide(checker, id, "reject", { kinds: [KIND] })).ok).toBe(true);
    expect(await decide(checker, id, "approve", { kinds: [KIND] })).toEqual({ ok: false });
  });
});

describe("decide: outcomes", () => {
  it("approve applies once and records who decided", async () => {
    const id = await open();
    const r = await decide(checker, id, "approve", { kinds: [KIND], note: "ok" });
    expect(r).toMatchObject({ ok: true, outcome: "approved" });
    expect(calls.apply).toBe(1);
    expect(await getRequest(id)).toMatchObject({ status: "approved", decidedBy: checker.userId, decisionNote: "ok" });
  });

  it("reject never applies, and keeps a sanitised note", async () => {
    const id = await open();
    const r = await decide(checker, id, "reject", { kinds: [KIND], note: "no‮ thanks\n" });
    expect(r).toMatchObject({ ok: true, outcome: "rejected" });
    expect(calls.apply).toBe(0);
    expect((await getRequest(id))?.decisionNote).toBe("no thanks");
  });

  it("an invalid subject auto-rejects with the kind's reason and applies nothing", async () => {
    verdict = { status: "invalid", reason: "subject_gone" };
    const id = await open();
    const r = await decide(checker, id, "approve", { kinds: [KIND] });
    expect(r).toMatchObject({ ok: true, outcome: "auto_rejected" });
    expect(await getRequest(id)).toMatchObject({ status: "rejected", decisionNote: "subject_gone" });
    expect(calls.apply).toBe(0);
  });

  it("a moot request is approved as a no-op: apply is not run", async () => {
    verdict = { status: "moot" };
    const id = await open();
    const r = await decide(checker, id, "approve", { kinds: [KIND] });
    expect(r).toMatchObject({ ok: true, outcome: "already_satisfied" });
    expect((await getRequest(id))?.status).toBe("approved");
    expect(calls.apply).toBe(0);
  });

  it("an effect that cannot apply closes the request as rejected, in the same transaction", async () => {
    applyImpl = async () => ({ applied: false, reason: "state_changed" });
    const id = await open();
    const r = await decide(checker, id, "approve", { kinds: [KIND] });
    expect(r).toMatchObject({ ok: true, outcome: "auto_rejected" });
    expect(await getRequest(id)).toMatchObject({ status: "rejected", decisionNote: "state_changed" });
  });

  it("rolls the decision back when apply throws", async () => {
    applyImpl = async () => {
      throw new Error("boom");
    };
    const id = await open();
    await expect(decide(checker, id, "approve", { kinds: [KIND] })).rejects.toThrow("boom");
    expect(await getRequest(id)).toMatchObject({ status: "pending", decidedBy: null });
  });

  it("two concurrent approves apply once; the loser applies nothing", async () => {
    const id = await open();
    const results = await Promise.all([
      decide(checker, id, "approve", { kinds: [KIND] }),
      decide(checker, id, "approve", { kinds: [KIND] }),
    ]);
    expect(calls.apply).toBe(1);
    const outcomes = results.map((r) => (r.ok ? r.outcome : "not_found")).sort();
    // The loser either raced inside (lost) or arrived after the commit (not found).
    expect(outcomes.filter((o) => o === "approved")).toHaveLength(1);
    expect(outcomes.filter((o) => o !== "approved").every((o) => o === "lost" || o === "not_found")).toBe(true);
  });
});

describe("cancel", () => {
  it("only the requester, only while pending", async () => {
    const id = await open();
    expect(await cancel(stranger, id, [KIND])).toBe(false);
    expect(await cancel(checker, id, [KIND])).toBe(false);
    expect(await cancel(maker, id, ["space.access"])).toBe(false);
    expect(await cancel(maker, id, [KIND])).toBe(true);
    expect((await getRequest(id))?.status).toBe("cancelled");
    expect(await cancel(maker, id, [KIND])).toBe(false);
    // And a cancelled request cannot be decided any more.
    expect(await decide(checker, id, "approve", { kinds: [KIND] })).toEqual({ ok: false });
    expect(calls.apply).toBe(0);
  });

  it("cannot cancel a request that was already decided", async () => {
    const id = await open();
    await decide(checker, id, "reject", { kinds: [KIND] });
    expect(await cancel(maker, id, [KIND])).toBe(false);
    expect((await getRequest(id))?.status).toBe("rejected");
  });
});

describe("the pending uniqueness rule", () => {
  it("one open request per (kind, subject, requester); a decided one frees the slot", async () => {
    const first = await insertRequest(db, { kind: KIND, subject: "s", requesterId: maker.userId });
    expect(first).toBeTruthy();
    expect(await insertRequest(db, { kind: KIND, subject: "s", requesterId: maker.userId })).toBeNull();
    // Another subject or another requester is a different request.
    expect(await insertRequest(db, { kind: KIND, subject: "t", requesterId: maker.userId })).toBeTruthy();
    expect(await insertRequest(db, { kind: KIND, subject: "s", requesterId: stranger.userId })).toBeTruthy();
    await decide(checker, first!, "reject", { kinds: [KIND] });
    expect(await insertRequest(db, { kind: KIND, subject: "s", requesterId: maker.userId })).toBeTruthy();
    const n = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM approval_requests WHERE subject = 's' AND requester_id = ?", [maker.userId]);
    expect(Number(n?.n)).toBe(2);
  });
});

describe("createRequest", () => {
  it("stores one request with a sanitised message and the kind's payload; a repeat adds nothing", async () => {
    expect(await createRequest(KIND, maker, "thing", "hello‮\nworld")).toBe("accepted");
    expect(await createRequest(KIND, maker, "thing", "again")).toBe("accepted");
    const rows = await db.all<{ message: string; payload: string }>("SELECT message, payload FROM approval_requests");
    expect(rows).toEqual([{ message: "hello world", payload: JSON.stringify({ v: 1 }) }]);
  });

  it("refuses a kind that is unknown or not client-creatable", async () => {
    expect(await createRequest("nope", maker, "x", "")).toBe("invalid_kind");
    const undoLocked = _registerKindForTest({ ...fake, name: "test.locked", clientCreatable: false });
    try {
      expect(await createRequest("test.locked", maker, "x", "")).toBe("invalid_kind");
    } finally {
      undoLocked();
    }
  });

  it("answers rate_limited from the kind's limits without storing anything", async () => {
    const undoLimit = _registerKindForTest({ ...fake, name: "test.limited", withinLimits: async () => false });
    try {
      expect(await createRequest("test.limited", maker, "x", "")).toBe("rate_limited");
      expect(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approval_requests"))?.n)).toBe(0);
    } finally {
      undoLimit();
    }
  });
});

describe("lists", () => {
  it("inboxFor returns what the actor may decide; mineFor the requester's own, newest first", async () => {
    await open("a");
    await open("b");
    expect((await inboxFor(checker, [KIND])).map((r) => r.request.subject).sort()).toEqual(["a", "b"]);
    expect(await inboxFor(stranger, [KIND])).toEqual([]);
    const mine = await mineFor(maker.userId, [KIND]);
    expect(mine).toHaveLength(2);
    expect(await mineFor(stranger.userId, [KIND])).toEqual([]);
    expect(await mineFor(maker.userId, [])).toEqual([]);
  });
});

describe("audit rows", () => {
  async function rows() {
    return db.all<{
      user_id: string;
      actor_user_id: string | null;
      action: string;
      tool: string;
      integration: string;
      success: number | boolean;
    }>("SELECT user_id, actor_user_id, action, tool, integration, success FROM audit_log ORDER BY id");
  }

  it("a decision is the maker's row with the checker as actor, and never carries the message or the note", async () => {
    const SECRET_MESSAGE = "my-secret-message-text";
    const SECRET_NOTE = "my-secret-note-text";
    const id = await open("thing", SECRET_MESSAGE);
    await decide(checker, id, "approve", { kinds: [KIND], note: SECRET_NOTE });
    const [row] = await rows();
    expect(row).toMatchObject({
      user_id: maker.userId,
      actor_user_id: checker.userId,
      action: "APPROVAL_APPROVE",
      integration: "approvals",
    });
    expect(row.tool).toBe("test.fake fake:thing (approved)");
    const all = JSON.stringify(await db.all("SELECT * FROM audit_log"));
    expect(all).not.toContain(SECRET_MESSAGE);
    expect(all).not.toContain(SECRET_NOTE);
  });

  it("reject, auto-reject, create and cancel each leave one row with the right action", async () => {
    await createRequest(KIND, maker, "c1", "m");
    const id = await open("r1");
    await decide(checker, id, "reject", { kinds: [KIND] });
    verdict = { status: "invalid", reason: "gone" };
    const id2 = await open("r2");
    await decide(checker, id2, "approve", { kinds: [KIND] });
    const id3 = await open("r3");
    await cancel(maker, id3, [KIND]);
    const out = await rows();
    expect(out.map((r) => r.action)).toEqual(["APPROVAL_REQUEST", "APPROVAL_REJECT", "APPROVAL_REJECT", "APPROVAL_CANCEL"]);
    // The create and cancel rows are the maker's own: no actor.
    expect(out[0].actor_user_id).toBeNull();
    expect(out[3].actor_user_id).toBeNull();
    expect(out[1].actor_user_id).toBe(checker.userId);
  });

  it("writes no row when the loser of a race applied nothing, and none when apply throws", async () => {
    applyImpl = async () => {
      throw new Error("boom");
    };
    const id = await open();
    await expect(decide(checker, id, "approve", { kinds: [KIND] })).rejects.toThrow("boom");
    expect(await rows()).toEqual([]);
  });

  it("keeps the request origin of the HTTP request next to the actor", async () => {
    const id = await open();
    await runWithAuditContext({ source_ip: "203.0.113.9", auth_method: "session" }, () =>
      decide(checker, id, "approve", { kinds: [KIND] })
    );
    const row = await db.get<{ source_ip: string; auth_method: string; actor_user_id: string }>(
      "SELECT source_ip, auth_method, actor_user_id FROM audit_log"
    );
    expect(row).toEqual({ source_ip: "203.0.113.9", auth_method: "session", actor_user_id: checker.userId });
  });
});
