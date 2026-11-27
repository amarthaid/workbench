import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
vi.mock("../../src/spaces/dir", () => ({ spacesRoot: () => tmp }));

import { db } from "../../src/db";
import { deleteSpace, upsertSpace } from "../../src/spaces/store";
import { getApprovalRows, writeApprovals } from "../../src/spaces/approvals";
import { resetSpacesDb, seedUser } from "./helpers";

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
