import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

let tmp: string;
vi.mock("../../src/spaces/dir", () => ({ spacesRoot: () => tmp }));

import { db } from "../../src/db";
import { cancel, createRequest, decide, inboxFor } from "../../src/approvals/engine";
import {
  SPACE_ACCESS,
  SPACE_ACCESS_MAX_OPEN,
  SPACE_ACCESS_MAX_PER_DAY,
  SPACE_ACCESS_MAX_PER_SPACE_DAY,
  pendingRequestCounts,
  type Actor,
} from "../../src/approvals/kinds";
import { getRequest } from "../../src/approvals/store";
import { canView } from "../../src/spaces/access";
import { deleteSpace, getSpace, getShares, setShares, toolsHash, updateSpaceMeta, upsertSpace } from "../../src/spaces/store";
import { setUserDisabled } from "../../src/auth/user-status";
import { resetSpacesDb, seedUser, writeSpaceFiles } from "../spaces/helpers";

const owner: Actor = { userId: "u-owner", email: "dev@example.com" };
const asker: Actor = { userId: "u-asker", email: "Asker@Example.com" };
const other: Actor = { userId: "u-other", email: "other@example.com" };
const admin: Actor = { userId: "u-admin", email: "admin@example.com" };

async function space(name: string, visibility: "users" | "org" | "private" = "users", files = true) {
  await upsertSpace({ name, ownerId: owner.userId, title: name, tools: ["acme_list_items"], visibility });
  if (files) writeSpaceFiles(tmp, name, { "index.html": "x" });
}

async function requests(where = "1 = 1") {
  return db.all<{ id: string; status: string; subject: string; message: string; payload: string | null }>(
    `SELECT id, status, subject, message, payload FROM approval_requests WHERE ${where} ORDER BY created_at, id`
  );
}

async function pendingId(subject = "s1", requester = asker) {
  const row = await db.get<{ id: string }>(
    "SELECT id FROM approval_requests WHERE subject = ? AND requester_id = ? AND status = 'pending'",
    [subject, requester.userId]
  );
  if (!row) throw new Error("no pending request");
  return row.id;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approvals-space-"));
  await resetSpacesDb();
  for (const a of [owner, asker, other, admin]) await seedUser(a.userId, a.email);
  await space("s1");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterAll(async () => {
  await resetSpacesDb();
});

describe("creating a request: the answer never depends on the Space", () => {
  it("stores a request only for a live users-Space the asker is not on and does not own", async () => {
    await space("priv", "private");
    await space("org", "org");
    await space("empty", "users", false);
    await space("shared", "users");
    await setShares("shared", owner.userId, ["asker@example.com"]);
    await space("mine", "users");

    expect(await createRequest(SPACE_ACCESS, asker, "s1", "hi")).toBe("accepted");
    for (const subject of ["missing", "priv", "org", "empty", "shared", "bad name!"]) {
      expect(await createRequest(SPACE_ACCESS, asker, subject, "hi")).toBe("accepted");
    }
    // The owner asking for their own Space is a no-op too.
    expect(await createRequest(SPACE_ACCESS, owner, "mine", "hi")).toBe("accepted");
    const rows = await requests();
    expect(rows.map((r) => r.subject)).toEqual(["s1"]);
  });

  it("pins the Space's created_at and stores a sanitised message", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "please‮ add me\n now");
    const [row] = await requests();
    expect(row.message).toBe("please add me now");
    const s = await getSpace("s1");
    expect(JSON.parse(row.payload!)).toEqual({ space_created_at: s!.createdAt });
  });

  it("a repeat while open adds nothing", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "a");
    await createRequest(SPACE_ACCESS, asker, "s1", "b");
    expect(await requests()).toHaveLength(1);
  });

  it("does nothing for a Space whose owner is disabled", async () => {
    await setUserDisabled(owner.userId, true);
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    expect(await requests()).toHaveLength(0);
  });

  it("does nothing for an asker with no email", async () => {
    await createRequest(SPACE_ACCESS, { userId: "u-asker", email: null }, "s1", "hi");
    expect(await requests()).toHaveLength(0);
  });
});

describe("approving", () => {
  it("adds the asker to the share list through changeShares and makes canView true (no nested transaction hang)", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    const s = (await getSpace("s1"))!;
    const viewer = { userId: asker.userId, email: asker.email };
    expect(await canView(s, viewer)).toBe(false);

    const r = await decide(owner, await pendingId(), "approve", { kinds: [SPACE_ACCESS] });
    expect(r).toMatchObject({ ok: true, outcome: "approved" });
    expect(await getShares("s1")).toEqual(["asker@example.com"]);
    expect(await canView((await getSpace("s1"))!, viewer)).toBe(true);
    expect((await requests())[0].status).toBe("approved");
  });

  it("keeps the people already on the list", async () => {
    await setShares("s1", owner.userId, ["a@example.com", "b@example.com"]);
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    await decide(owner, await pendingId(), "approve", { kinds: [SPACE_ACCESS] });
    expect(await getShares("s1")).toEqual(["a@example.com", "asker@example.com", "b@example.com"]);
  });

  it("is audited as the asker's row with the owner as actor, naming the Space but not the message", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "a-very-private-message");
    await decide(owner, await pendingId(), "approve", { kinds: [SPACE_ACCESS], note: "a-very-private-note" });
    const rows = await db.all<{ user_id: string; actor_user_id: string | null; action: string; tool: string }>(
      "SELECT user_id, actor_user_id, action, tool FROM audit_log ORDER BY id"
    );
    expect(rows.map((r) => [r.action, r.user_id, r.actor_user_id, r.tool])).toEqual([
      ["APPROVAL_REQUEST", asker.userId, null, "space.access space:s1 (requested)"],
      ["APPROVAL_APPROVE", asker.userId, owner.userId, "space.access space:s1 (approved)"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("a-very-private");
  });

  it("an asker who got on the list meanwhile is approved as a no-op", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    await setShares("s1", owner.userId, ["asker@example.com"]);
    const r = await decide(owner, await pendingId(), "approve", { kinds: [SPACE_ACCESS] });
    expect(r).toMatchObject({ ok: true, outcome: "already_satisfied" });
    expect(await getShares("s1")).toEqual(["asker@example.com"]);
  });

  it("auto-rejects when the owner is disabled", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    await setUserDisabled(owner.userId, true);
    const r = await decide(owner, await pendingId(), "approve", { kinds: [SPACE_ACCESS] });
    expect(r).toMatchObject({ ok: true, outcome: "auto_rejected" });
    expect(await getShares("s1")).toEqual([]);
    expect((await requests())[0]).toMatchObject({ status: "rejected" });
  });

  it("auto-rejects when the asker's account was disabled", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    await setUserDisabled(asker.userId, true);
    const r = await decide(owner, await pendingId(), "approve", { kinds: [SPACE_ACCESS] });
    expect(r).toMatchObject({ ok: true, outcome: "auto_rejected" });
    expect(await getShares("s1")).toEqual([]);
  });

  it("a Space that became private is closed, one that became org is a no-op", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    await createRequest(SPACE_ACCESS, other, "s1", "hi");
    await updateSpaceMeta("s1", owner.userId, { visibility: "private" });
    expect(await decide(owner, await pendingId("s1", asker), "approve", { kinds: [SPACE_ACCESS] })).toMatchObject({ outcome: "auto_rejected" });
    await updateSpaceMeta("s1", owner.userId, { visibility: "org" });
    expect(await decide(owner, await pendingId("s1", other), "approve", { kinds: [SPACE_ACCESS] })).toMatchObject({ outcome: "already_satisfied" });
    expect(await getShares("s1")).toEqual([]);
  });

  it("reject leaves the list alone", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    expect(await decide(owner, await pendingId(), "reject", { kinds: [SPACE_ACCESS], note: "no" })).toMatchObject({ outcome: "rejected" });
    expect(await getShares("s1")).toEqual([]);
  });

  it("delegation interplay: a delegated Space flags the row, and the share lands through the same writer", async () => {
    await updateSpaceMeta("s1", owner.userId, { accessMode: "owner", confirmDelegation: true, expectedToolsHash: toolsHash(["acme_list_items"]) });
    expect((await getSpace("s1"))?.accessMode).toBe("owner");
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    const rows = await inboxFor(owner, [SPACE_ACCESS]);
    expect(rows).toHaveLength(1);
    expect(rows[0].delegated).toBe(true);
    await decide(owner, rows[0].request.id, "approve", { kinds: [SPACE_ACCESS] });
    expect(await getShares("s1")).toEqual(["asker@example.com"]);
    // Delegation itself is untouched by the approval.
    expect((await getSpace("s1"))?.accessMode).toBe("owner");
  });
});

describe("who may decide", () => {
  it("a stranger and an admin cannot; only the owner", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    const id = await pendingId();
    expect(await decide(other, id, "approve", { kinds: [SPACE_ACCESS] })).toEqual({ ok: false });
    expect(await decide(admin, id, "approve", { kinds: [SPACE_ACCESS] })).toEqual({ ok: false });
    expect(await decide(asker, id, "approve", { kinds: [SPACE_ACCESS] })).toEqual({ ok: false });
    expect(await getShares("s1")).toEqual([]);
    expect((await getRequest(id))?.status).toBe("pending");
  });

  it("the owner of another Space cannot decide this one", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    await upsertSpace({ name: "s2", ownerId: other.userId, title: "s2", tools: [], visibility: "users" });
    expect(await decide(other, await pendingId(), "approve", { kinds: [SPACE_ACCESS] })).toEqual({ ok: false });
  });

  it("the inbox is the owner's, pending only, and carries the requester's email", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    expect(await inboxFor(other, [SPACE_ACCESS])).toEqual([]);
    expect(await inboxFor(admin, [SPACE_ACCESS])).toEqual([]);
    const rows = await inboxFor(owner, [SPACE_ACCESS]);
    expect(rows.map((r) => [r.request.subject, r.requesterEmail, r.delegated])).toEqual([["s1", "Asker@Example.com", false]]);
    await decide(owner, rows[0].request.id, "reject", { kinds: [SPACE_ACCESS] });
    expect(await inboxFor(owner, [SPACE_ACCESS])).toEqual([]);
  });

  it("counts open requests per Space for the owner's list", async () => {
    await space("s2");
    await createRequest(SPACE_ACCESS, asker, "s1", "");
    await createRequest(SPACE_ACCESS, other, "s1", "");
    await createRequest(SPACE_ACCESS, asker, "s2", "");
    expect([...(await pendingRequestCounts(owner.userId))].sort()).toEqual([["s1", 2], ["s2", 1]]);
    expect([...(await pendingRequestCounts(other.userId))]).toEqual([]);
  });
});

describe("a Space that goes away or is recreated under the same name", () => {
  it("deleteSpace closes its open requests inside its own transaction", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    await deleteSpace("s1");
    expect((await requests())[0].status).toBe("cancelled");
    expect(await decide(owner, (await requests())[0].id, "approve", { kinds: [SPACE_ACCESS] })).toEqual({ ok: false });
  });

  it("a recreated name never inherits old requests (created_at is pinned)", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    const id = await pendingId();
    // Same name, a different Space: as if it was deleted and deployed again.
    await db.run("UPDATE spaces SET created_at = created_at + 1 WHERE name = 's1'");
    expect(await inboxFor(owner, [SPACE_ACCESS])).toEqual([]);
    expect([...(await pendingRequestCounts(owner.userId))]).toEqual([]);
    expect(await decide(owner, id, "approve", { kinds: [SPACE_ACCESS] })).toEqual({ ok: false });
    expect(await getShares("s1")).toEqual([]);
  });

  it("a redeploy by the owner keeps the Space's created_at, so open requests survive it", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    await upsertSpace({ name: "s1", ownerId: owner.userId, title: "New title", tools: ["acme_list_items"], visibility: "users" });
    expect(await inboxFor(owner, [SPACE_ACCESS])).toHaveLength(1);
  });
});

describe("cancel", () => {
  it("the asker withdraws; the owner cannot cancel it for them", async () => {
    await createRequest(SPACE_ACCESS, asker, "s1", "hi");
    const id = await pendingId();
    expect(await cancel(owner, id, [SPACE_ACCESS])).toBe(false);
    expect(await cancel(asker, id, [SPACE_ACCESS])).toBe(true);
    expect(await inboxFor(owner, [SPACE_ACCESS])).toEqual([]);
  });
});

describe("limits", () => {
  it(`allows ${SPACE_ACCESS_MAX_PER_SPACE_DAY} requests per Space per 24h, counting rejected and cancelled ones`, async () => {
    for (let i = 0; i < SPACE_ACCESS_MAX_PER_SPACE_DAY; i++) {
      expect(await createRequest(SPACE_ACCESS, asker, "s1", "")).toBe("accepted");
      const id = await pendingId();
      if (i % 2 === 0) await decide(owner, id, "reject", { kinds: [SPACE_ACCESS] });
      else await cancel(asker, id, [SPACE_ACCESS]);
    }
    expect(await createRequest(SPACE_ACCESS, asker, "s1", "")).toBe("rate_limited");
    expect(await requests()).toHaveLength(SPACE_ACCESS_MAX_PER_SPACE_DAY);
    // A day later the window has moved on.
    await db.run("UPDATE approval_requests SET created_at = created_at - ?", [25 * 3600]);
    expect(await createRequest(SPACE_ACCESS, asker, "s1", "")).toBe("accepted");
  });

  it("the limit is the same for a Space that does not exist (the 429 does not reveal existence)", async () => {
    for (let i = 0; i < SPACE_ACCESS_MAX_PER_DAY; i++) {
      // Ask for different, mostly missing, names; only s1 exists.
      expect(await createRequest(SPACE_ACCESS, asker, i === 0 ? "s1" : `nope-${i}`, "")).toBe("accepted");
    }
    // Pretend those were made: the per-day count is over every subject.
    const now = Math.floor(Date.now() / 1000);
    for (let i = 1; i < SPACE_ACCESS_MAX_PER_DAY; i++) {
      await db.run(
        "INSERT INTO approval_requests (id, kind, subject, requester_id, status, created_at) VALUES (?, ?, ?, ?, 'rejected', ?)",
        [`old-${i}`, SPACE_ACCESS, `nope-${i}`, asker.userId, now]
      );
    }
    expect(await createRequest(SPACE_ACCESS, asker, "s1", "")).toBe("rate_limited");
    expect(await createRequest(SPACE_ACCESS, asker, "missing", "")).toBe("rate_limited");
  });

  it(`allows ${SPACE_ACCESS_MAX_OPEN} open requests; ones on dead Spaces do not count`, async () => {
    for (let i = 0; i < SPACE_ACCESS_MAX_OPEN + 1; i++) await space(`o${i}`);
    for (let i = 0; i < SPACE_ACCESS_MAX_OPEN; i++) expect(await createRequest(SPACE_ACCESS, asker, `o${i}`, "")).toBe("accepted");
    expect(await createRequest(SPACE_ACCESS, asker, `o${SPACE_ACCESS_MAX_OPEN}`, "")).toBe("rate_limited");
    // One of the five Spaces is recreated under the same name: that request is dead.
    await db.run("UPDATE spaces SET created_at = created_at + 1 WHERE name = 'o0'");
    expect(await createRequest(SPACE_ACCESS, asker, `o${SPACE_ACCESS_MAX_OPEN}`, "")).toBe("accepted");
  });
});
