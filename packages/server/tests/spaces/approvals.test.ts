import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
vi.mock("../../src/spaces/dir", () => ({ spacesRoot: () => tmp }));

import { db } from "../../src/db";
import { consentHash, deleteSpace, getConsentRow, grantConsent, upsertSpace } from "../../src/spaces/store";
import {
  approvalEditable,
  approvalFor,
  checkConsent,
  legacyApprovedSet,
  shownConsentHash,
  autoSet,
  defaultMode,
  delegatedFor,
  getApprovalRows,
  policyRows,
  policySource,
  writeApprovals,
} from "../../src/spaces/approvals";
import { registry } from "../../src/plugins/registry";
import type { Space } from "../../src/spaces/store";
import { registerFixtures } from "./fixtures";
import { resetSpacesDb, seedUser } from "./helpers";

beforeAll(() => {
  registerFixtures();
});

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spaces-approvals-"));
  await resetSpacesDb();
  await seedUser("u1", "owner@example.com");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const defaults = { a: "ask", b: "auto" } as const;

describe("approval rows", () => {
  it("returns an empty object when nothing is stored", async () => {
    expect(await getApprovalRows("s1", "u1")).toEqual({});
  });

  it("stores choices that differ from the default and reports the changes", async () => {
    const changes = await writeApprovals("s1", "u1", { a: "auto", b: "ask" }, defaults);
    expect(changes).toEqual([
      { tool: "a", from: "ask", to: "auto" },
      { tool: "b", from: "auto", to: "ask" },
    ]);
    expect(await getApprovalRows("s1", "u1")).toEqual({ a: "auto", b: "ask" });
  });

  it("deletes the row when a tool goes back to its default", async () => {
    await writeApprovals("s1", "u1", { a: "auto" }, defaults);
    const changes = await writeApprovals("s1", "u1", { a: "ask" }, defaults);
    expect(changes).toEqual([{ tool: "a", from: "auto", to: "ask" }]);
    expect(await getApprovalRows("s1", "u1")).toEqual({});
  });

  it("reports nothing and stores nothing when the mode is already in effect", async () => {
    expect(await writeApprovals("s1", "u1", { a: "ask", b: "auto" }, defaults)).toEqual([]);
    expect(await getApprovalRows("s1", "u1")).toEqual({});
    await writeApprovals("s1", "u1", { a: "auto" }, defaults);
    expect(await writeApprovals("s1", "u1", { a: "auto" }, defaults)).toEqual([]);
  });

  it("keeps each user's rows apart", async () => {
    await writeApprovals("s1", "u1", { a: "auto" }, defaults);
    expect(await getApprovalRows("s1", "u2")).toEqual({});
    expect(await getApprovalRows("s2", "u1")).toEqual({});
  });

  it("is all or nothing", async () => {
    await writeApprovals("s1", "u1", { a: "auto" }, defaults);
    // An invalid mode fails the NOT NULL / write mid-way: the second entry throws.
    await expect(
      writeApprovals("s1", "u1", { b: "ask", a: undefined as unknown as "ask" }, { ...defaults })
    ).rejects.toThrow();
    // Nothing from the failed call remained: b is still at its default.
    expect(await getApprovalRows("s1", "u1")).toEqual({ a: "auto" });
  });

  it("deleting a Space removes its rows, and a new Space of that name starts clean", async () => {
    await upsertSpace({ name: "s1", ownerId: "u1", title: "T", tools: ["a"], visibility: "org" });
    await writeApprovals("s1", "u1", { a: "auto" }, defaults);
    await deleteSpace("s1");
    expect(await db.all("SELECT * FROM space_tool_approvals")).toEqual([]);
    await upsertSpace({ name: "s1", ownerId: "u1", title: "T", tools: ["a"], visibility: "org" });
    expect(await getApprovalRows("s1", "u1")).toEqual({});
  });
});

// ---- policy ----------------------------------------------------------------

const READ = "acme_list_items";
const WRITE = "acme_update_item";
const DESTRUCTIVE = "acme_delete_item";
const NOT_DELEGABLE = "acme_set_secret";
const GONE = "acme_removed_tool";

function space(over: Partial<Space> = {}): Space {
  return {
    name: "s1",
    ownerId: "u1",
    title: "T",
    description: null,
    tools: [READ, WRITE, DESTRUCTIVE, NOT_DELEGABLE, GONE],
    visibility: "org",
    accessMode: "viewer",
    delegatedToolsHash: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("delegatedFor and policySource", () => {
  it("is true only for the stored owner mode and a viewer who is not the owner", () => {
    expect(delegatedFor(space({ accessMode: "owner" }), "u2")).toBe(true);
    expect(delegatedFor(space({ accessMode: "owner" }), "u1")).toBe(false);
    expect(delegatedFor(space({ accessMode: "viewer" }), "u2")).toBe(false);
  });

  it("stays true while delegation is paused by a tool change (stale pin)", () => {
    expect(delegatedFor(space({ accessMode: "owner", delegatedToolsHash: "stale" }), "u2")).toBe(true);
  });

  it("follows the owner's rows only when delegated", async () => {
    expect(policySource(space({ accessMode: "owner" }), "u2")).toBe("u1");
    expect(policySource(space({ accessMode: "owner" }), "u1")).toBe("u1");
    expect(policySource(space(), "u2")).toBe("u2");
    await writeApprovals("s1", "u1", { [WRITE]: "ask" }, { [WRITE]: "auto" });
    expect(await policyRows(space({ accessMode: "owner" }), "u2")).toEqual({ [WRITE]: "ask" });
    expect(await policyRows(space(), "u2")).toEqual({});
  });
});

describe("defaultMode", () => {
  it("is auto for a write, ask for destructive and unlabelled, none for a read", () => {
    expect(defaultMode(registry.getTool(WRITE)!)).toBe("auto");
    expect(defaultMode(registry.getTool(DESTRUCTIVE)!)).toBe("ask");
    expect(defaultMode(registry.getTool("acme_unlabelled")!)).toBe("ask");
    expect(defaultMode(registry.getTool(READ)!)).toBeNull();
  });
});

describe("approvalFor", () => {
  it.each([
    [READ, {}, null],
    [GONE, {}, "ask"],
    [GONE, { [GONE]: "auto" }, "ask"],
    [WRITE, {}, "auto"],
    [WRITE, { [WRITE]: "ask" }, "ask"],
    [DESTRUCTIVE, {}, "ask"],
    [DESTRUCTIVE, { [DESTRUCTIVE]: "auto" }, "auto"],
    [READ, { [READ]: "ask" }, null],
  ] as const)("%s with rows %j is %s", (tool, rows, expected) => {
    expect(approvalFor(space(), "u2", tool, rows as Record<string, "auto" | "ask">)).toBe(expected);
  });

  it("treats a tool of an internal integration as ask", () => {
    expect(approvalFor(space(), "u2", "deploy_space", {})).toBe("ask");
  });
});

describe("autoSet", () => {
  it("lists the auto tools in sorted order for an ordinary viewer, non-delegable included", () => {
    expect(autoSet(space(), "u2", {})).toEqual([NOT_DELEGABLE, WRITE].sort());
    expect(autoSet(space(), "u2", { [DESTRUCTIVE]: "auto", [WRITE]: "ask" })).toEqual([DESTRUCTIVE, NOT_DELEGABLE].sort());
  });

  it("leaves out tools that cannot be delegated for a delegated viewer", () => {
    const s = space({ accessMode: "owner" });
    expect(autoSet(s, "u2", {})).toEqual([WRITE]);
    expect(autoSet(s, "u2", { [DESTRUCTIVE]: "auto" })).toEqual([DESTRUCTIVE, WRITE].sort());
    expect(autoSet(s, "u1", {})).toEqual([NOT_DELEGABLE, WRITE].sort());
  });
});

describe("approvalEditable", () => {
  it("is false for reads, missing tools and delegated viewers", () => {
    expect(approvalEditable(space(), "u2", READ)).toBe(false);
    expect(approvalEditable(space(), "u2", GONE)).toBe(false);
    expect(approvalEditable(space({ accessMode: "owner" }), "u2", WRITE)).toBe(false);
  });

  it("is true for a write or destructive tool of an ordinary viewer and for the owner", () => {
    expect(approvalEditable(space(), "u2", WRITE)).toBe(true);
    expect(approvalEditable(space(), "u2", DESTRUCTIVE)).toBe(true);
    expect(approvalEditable(space({ accessMode: "owner" }), "u1", WRITE)).toBe(true);
  });
});

// ---- consent ---------------------------------------------------------------

describe("shownConsentHash", () => {
  it("equals consentHash for the owner and an ordinary viewer", () => {
    const s = space();
    expect(shownConsentHash(s, "u1", [WRITE])).toBe(consentHash(s, "u1"));
    expect(shownConsentHash(s, "u2", [WRITE])).toBe(consentHash(s, "u2"));
    const d = space({ accessMode: "owner" });
    expect(shownConsentHash(d, "u1", [WRITE])).toBe(consentHash(d, "u1"));
  });

  it("covers the auto set for a delegated viewer", () => {
    const d = space({ accessMode: "owner" });
    const expected = crypto.createHash("sha256").update(JSON.stringify([consentHash(d, "u2"), [WRITE]])).digest("hex");
    expect(shownConsentHash(d, "u2", [WRITE])).toBe(expected);
    expect(shownConsentHash(d, "u2", [WRITE, DESTRUCTIVE])).not.toBe(expected);
    expect(shownConsentHash(d, "u2", [WRITE])).not.toBe(consentHash(d, "u2"));
  });
});

describe("legacyApprovedSet", () => {
  it("is the current delegable write tools", () => {
    expect(legacyApprovedSet(space())).toEqual([WRITE]);
  });
});

describe("grantConsent auto_tools", () => {
  it("stores the set as JSON, and null when none is given", async () => {
    const d = space({ accessMode: "owner" });
    await grantConsent(d, "u2", [WRITE]);
    expect(await getConsentRow("s1", "u2")).toEqual({ hash: consentHash(d, "u2"), autoTools: [WRITE] });
    await grantConsent(d, "u2", null);
    expect((await getConsentRow("s1", "u2"))!.autoTools).toBeNull();
    await grantConsent(d, "u2");
    expect((await getConsentRow("s1", "u2"))!.autoTools).toBeNull();
  });

  it("treats an unparsable stored set as never recorded", async () => {
    await grantConsent(space(), "u2");
    await db.run("UPDATE space_consents SET auto_tools = ? WHERE space_name = ? AND user_id = ?", ["not json", "s1", "u2"]);
    expect((await getConsentRow("s1", "u2"))!.autoTools).toBeNull();
  });
});

describe("checkConsent", () => {
  const delegated = () => space({ accessMode: "owner" });

  it("is not consented, with no reason, when there is no row", async () => {
    expect(await checkConsent(space(), "u2", {})).toEqual({ consented: false });
  });

  it("reports tools when the stored hash no longer matches", async () => {
    await grantConsent(space(), "u2");
    expect(await checkConsent(space({ tools: [READ] }), "u2", {})).toEqual({ consented: false, reason: "tools" });
  });

  it("consents an ordinary viewer and the owner without the subset check", async () => {
    await grantConsent(space(), "u2");
    await grantConsent(space(), "u1");
    expect(await checkConsent(space(), "u2", { [DESTRUCTIVE]: "auto" })).toEqual({ consented: true });
    expect(await checkConsent(space(), "u1", { [DESTRUCTIVE]: "auto" })).toEqual({ consented: true });
  });

  it("consents a delegated viewer whose current auto set is within what they approved", async () => {
    await grantConsent(delegated(), "u2", [WRITE]);
    expect(await checkConsent(delegated(), "u2", {})).toEqual({ consented: true });
  });

  it("asks again with reason approvals when the owner loosens a destructive tool", async () => {
    await grantConsent(delegated(), "u2", [WRITE]);
    expect(await checkConsent(delegated(), "u2", { [DESTRUCTIVE]: "auto" })).toEqual({ consented: false, reason: "approvals" });
  });

  it("stays consented when the owner tightens a write", async () => {
    await grantConsent(delegated(), "u2", [WRITE]);
    expect(await checkConsent(delegated(), "u2", { [WRITE]: "ask" })).toEqual({ consented: true });
  });

  it("counts NULL auto_tools as the current delegable write tools", async () => {
    await grantConsent(delegated(), "u2", null);
    expect(await checkConsent(delegated(), "u2", {})).toEqual({ consented: true });
    expect(await checkConsent(delegated(), "u2", { [DESTRUCTIVE]: "auto" })).toEqual({ consented: false, reason: "approvals" });
  });

  it("ignores tools that cannot be delegated", async () => {
    await grantConsent(delegated(), "u2", [WRITE]);
    expect(await checkConsent(delegated(), "u2", { [NOT_DELEGABLE]: "auto" })).toEqual({ consented: true });
  });
});
