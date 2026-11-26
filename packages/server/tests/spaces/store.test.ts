import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
vi.mock("../../src/spaces/dir", () => ({ spacesRoot: () => tmp }));

import { db } from "../../src/db";
import {
  deleteSpace,
  getConsentHash,
  getShares,
  getSpace,
  grantConsent,
  hasConsent,
  hasFiles,
  isValidSpaceName,
  kvGet,
  kvKeys,
  kvPut,
  listAllSpaces,
  listOwnedSpaces,
  listSpaceFiles,
  normalizeTools,
  revokeConsent,
  setShares,
  changeShares,
  consentHash,
  toolsHash,
  updateSpaceMeta,
  upsertSpace,
  delegationSuspended,
  writeSpaceMetaIfUnchanged,
  KV_VALUE_MAX_BYTES,
  type Space,
  type SpaceMetaSnapshot,
} from "../../src/spaces/store";
import { resetSpacesDb, seedUser, writeSpaceFiles } from "./helpers";

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spaces-store-"));
  await resetSpacesDb();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const base = { ownerId: "u1", title: "PR timeline", tools: ["b_tool", "a_tool"], visibility: "org" as const };

/** Turn delegation on for `name` as u1, confirming the tool list currently stored. */
async function enableIn(name: string) {
  const cur = (await getSpace(name))!;
  return updateSpaceMeta(name, "u1", { accessMode: "owner", confirmDelegation: true, expectedToolsHash: toolsHash(cur.tools) });
}

/** Narrow an updateSpaceMeta result to the success shape (null otherwise). */
async function meta(p: ReturnType<typeof updateSpaceMeta>) {
  const r = await p;
  return r && typeof r === "object" ? r : null;
}

describe("spaces/store", () => {
  it("names follow jot rules and reserve _sdk and upload", () => {
    expect(isValidSpaceName("pr-timeline")).toBe(true);
    expect(isValidSpaceName("upload")).toBe(false);
    expect(isValidSpaceName("_sdk")).toBe(false);
    expect(isValidSpaceName("Bad")).toBe(false);
    expect(isValidSpaceName("a".repeat(65))).toBe(false);
  });

  it("creates, reads, updates and lists", async () => {
    expect(await upsertSpace({ name: "s1", ...base, description: "d" })).toEqual({ result: "ok", modeReset: false });
    const s = await getSpace("s1");
    expect(s).toMatchObject({ name: "s1", ownerId: "u1", title: "PR timeline", description: "d", visibility: "org" });
    expect(s!.tools).toEqual(["a_tool", "b_tool"]);
    expect(typeof s!.createdAt).toBe("number");

    const u = await meta(updateSpaceMeta("s1", "u1", { title: "New", visibility: "private" }));
    expect(u!.space).toMatchObject({ title: "New", visibility: "private", description: "d" });
    expect(u!.modeReset).toBe(false);
    expect((await getSpace("s1"))!.title).toBe("New");

    await upsertSpace({ name: "s2", ...base });
    await upsertSpace({ name: "s3", ...base, ownerId: "u2" });
    expect((await listOwnedSpaces("u1")).map((x) => x.name).sort()).toEqual(["s1", "s2"]);
    expect((await listAllSpaces()).map((x) => x.name).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("refuses a name another user owns, and the owner can redeploy", async () => {
    await upsertSpace({ name: "s1", ...base });
    expect((await upsertSpace({ name: "s1", ...base, ownerId: "u2", title: "Mine now" })).result).toBe("taken");
    expect((await getSpace("s1"))!.title).toBe("PR timeline");
    expect((await upsertSpace({ name: "s1", ...base, title: "Again" })).result).toBe("ok");
    expect((await getSpace("s1"))!.title).toBe("Again");
  });

  it("listAllSpaces carries the owner's email", async () => {
    await seedUser("u1", "dev@example.com");
    await upsertSpace({ name: "s1", ...base });
    expect((await listAllSpaces())[0].ownerEmail).toBe("dev@example.com");
  });

  it("tool hash is stable under reordering and duplicates", () => {
    expect(toolsHash(["b", "a"])).toBe(toolsHash(["a", "b", "a"]));
    expect(toolsHash(["a"])).not.toBe(toolsHash(["a", "b"]));
    expect(normalizeTools(["c", "a", "c"])).toEqual(["a", "c"]);
  });

  it("shares are lowercased and replaced wholesale", async () => {
    await upsertSpace({ name: "s1", ...base });
    expect(await setShares("s1", "u1", ["Dev@Example.com", "dev@example.com", "qa@example.com"])).toBe(true);
    expect(await getShares("s1")).toEqual(["dev@example.com", "qa@example.com"]);
    await setShares("s1", "u1", ["ops@example.com"]);
    expect(await getShares("s1")).toEqual(["ops@example.com"]);
  });

  it("changeShares adds and removes without touching other shares", async () => {
    await upsertSpace({ name: "s1", ...base });
    await setShares("s1", "u1", ["dev@example.com", "qa@example.com"]);
    expect(await changeShares("s1", "u1", { add: ["Ops@Example.com", "dev@example.com"] })).toEqual([
      "dev@example.com",
      "ops@example.com",
      "qa@example.com",
    ]);
    expect(await changeShares("s1", "u1", { remove: ["QA@example.com", "nobody@example.com"] })).toEqual([
      "dev@example.com",
      "ops@example.com",
    ]);
    // In both lists: removal wins.
    expect(await changeShares("s1", "u1", { add: ["x@example.com"], remove: ["x@example.com"] })).toEqual([
      "dev@example.com",
      "ops@example.com",
    ]);
    expect(await getShares("s1")).toEqual(["dev@example.com", "ops@example.com"]);
  });

  it("changeShares keeps both of two concurrent additions", async () => {
    await upsertSpace({ name: "s1", ...base });
    await setShares("s1", "u1", ["dev@example.com"]);
    await Promise.all([
      changeShares("s1", "u1", { add: ["a@example.com"] }),
      changeShares("s1", "u1", { add: ["b@example.com"] }),
    ]);
    expect(await getShares("s1")).toEqual(["a@example.com", "b@example.com", "dev@example.com"]);
  });

  it("changeShares refuses to empty a required list and checks the owner", async () => {
    await upsertSpace({ name: "s1", ...base });
    await setShares("s1", "u1", ["dev@example.com"]);
    expect(await changeShares("s1", "u1", { remove: ["dev@example.com"] }, true)).toBe("empty");
    expect(await getShares("s1")).toEqual(["dev@example.com"]);
    expect(await changeShares("s1", "u2", { add: ["evil@example.com"] })).toBe("forbidden");
    expect(await changeShares("missing", "u1", { add: ["x@example.com"] })).toBe("forbidden");
    expect(await getShares("s1")).toEqual(["dev@example.com"]);
    // Without the requirement an empty list is fine.
    expect(await changeShares("s1", "u1", { remove: ["dev@example.com"] })).toEqual([]);
  });

  it("metadata and share writes carry the owner predicate", async () => {
    await upsertSpace({ name: "s1", ...base });
    expect(await setShares("s1", "u1", ["dev@example.com"])).toBe(true);
    // Another user (or a stale owner after delete and re-create) changes nothing.
    expect(await updateSpaceMeta("s1", "u2", { title: "Hijack" })).toBeNull();
    expect(await setShares("s1", "u2", ["evil@example.com"])).toBe(false);
    expect((await getSpace("s1"))!.title).toBe("PR timeline");
    expect(await getShares("s1")).toEqual(["dev@example.com"]);
    await deleteSpace("s1");
    await upsertSpace({ name: "s1", ...base, ownerId: "u2" });
    expect(await updateSpaceMeta("s1", "u1", { title: "Stale" })).toBeNull();
    expect(await setShares("s1", "u1", ["x@example.com"])).toBe(false);
    expect(await setShares("missing", "u1", ["x@example.com"])).toBe(false);
  });

  it("consent binds the current tool hash", async () => {
    await upsertSpace({ name: "s1", ...base });
    const s = (await getSpace("s1"))!;
    expect(await hasConsent(s, "v1")).toBe(false);
    await grantConsent(s, "v1");
    expect(await hasConsent(s, "v1")).toBe(true);
    const changed = (await meta(updateSpaceMeta("s1", "u1", { tools: ["a_tool", "c_tool"] })))!.space;
    expect(await hasConsent(changed, "v1")).toBe(false);
    await revokeConsent("s1", "v1");
    expect(await getConsentHash("s1", "v1")).toBeNull();
  });

  describe("consent covers mode and owner", () => {
    it("stores the consent hash, not the bare tools hash", async () => {
      await upsertSpace({ name: "s1", ...base });
      const s = (await getSpace("s1"))!;
      await grantConsent(s, "v1");
      expect(await getConsentHash("s1", "v1")).toBe(consentHash(s, "v1"));
      expect(consentHash(s, "v1")).not.toBe(toolsHash(s.tools));
    });

    it("a viewer to owner flip invalidates it", async () => {
      await upsertSpace({ name: "s1", ...base });
      await grantConsent((await getSpace("s1"))!, "v1");
      const on = (await meta(enableIn("s1")))!.space;
      expect(await hasConsent(on, "v1")).toBe(false);
      expect(await hasConsent((await getSpace("s1"))!, "v1")).toBe(false);
    });

    it("an owner to viewer flip invalidates it", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enableIn("s1");
      await grantConsent((await getSpace("s1"))!, "v1");
      expect(await hasConsent((await getSpace("s1"))!, "v1")).toBe(true);
      const off = (await meta(updateSpaceMeta("s1", "u1", { accessMode: "viewer" })))!.space;
      expect(await hasConsent(off, "v1")).toBe(false);
    });

    it("a different owner invalidates it", async () => {
      await upsertSpace({ name: "s1", ...base });
      const s = (await getSpace("s1"))!;
      await grantConsent(s, "v1");
      expect(await hasConsent({ ...s, ownerId: "u9" }, "v1")).toBe(false);
      expect(consentHash({ ...s, ownerId: "u9" }, "v1")).not.toBe(consentHash(s, "v1"));
    });

    it("the owner keeps consent across delegation toggles, both ways", async () => {
      await upsertSpace({ name: "s1", ...base });
      await grantConsent((await getSpace("s1"))!, "u1");
      const on = (await meta(enableIn("s1")))!.space;
      expect(await hasConsent(on, "u1")).toBe(true);
      const off = (await meta(updateSpaceMeta("s1", "u1", { accessMode: "viewer" })))!.space;
      expect(await hasConsent(off, "u1")).toBe(true);
      // The owner's hash ignores the mode; a viewer's does not.
      expect(consentHash(on, "u1")).toBe(consentHash(off, "u1"));
      expect(consentHash(on, "v1")).not.toBe(consentHash(off, "v1"));
    });

    it("the owner is still re-asked when the tool list changes", async () => {
      await upsertSpace({ name: "s1", ...base });
      await grantConsent((await getSpace("s1"))!, "u1");
      const changed = (await meta(updateSpaceMeta("s1", "u1", { tools: ["a_tool", "c_tool"] })))!.space;
      expect(await hasConsent(changed, "u1")).toBe(false);
    });

    it("an owner's consent does not carry over once someone else owns it", async () => {
      await upsertSpace({ name: "s1", ...base });
      const s = (await getSpace("s1"))!;
      await grantConsent(s, "u1");
      expect(await hasConsent({ ...s, ownerId: "u9" }, "u1")).toBe(false);
    });

    it("a consent recorded as the bare tools hash (before this change) no longer counts", async () => {
      await upsertSpace({ name: "s1", ...base });
      const s = (await getSpace("s1"))!;
      await db.run(
        "INSERT INTO space_consents (space_name, user_id, tools_hash, granted_at) VALUES (?, ?, ?, ?)",
        ["s1", "v1", toolsHash(s.tools), 1]
      );
      expect(await hasConsent(s, "v1")).toBe(false);
    });
  });

  describe("access mode", () => {
    const enable = () => enableIn("s1");

    it("a new Space is viewer mode with no tool pin", async () => {
      await upsertSpace({ name: "s1", ...base });
      const s = (await getSpace("s1"))!;
      expect(s.accessMode).toBe("viewer");
      expect(s.delegatedToolsHash).toBeNull();
      expect(delegationSuspended(s)).toBe(false);
      expect((await listAllSpaces())[0]).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });
    });

    it("enabling with confirmation records the hash of the current tools", async () => {
      await upsertSpace({ name: "s1", ...base });
      const r = (await meta(enable()))!;
      expect(r.modeReset).toBe(false);
      expect(r.space).toMatchObject({ accessMode: "owner", delegatedToolsHash: toolsHash(base.tools) });
      const stored = (await getSpace("s1"))!;
      expect(stored).toMatchObject({ accessMode: "owner", delegatedToolsHash: toolsHash(base.tools) });
      expect(delegationSuspended(stored)).toBe(false);
    });

    it("confirming with the hash of the reviewed list enables it", async () => {
      await upsertSpace({ name: "s1", ...base });
      const r = await updateSpaceMeta("s1", "u1", {
        accessMode: "owner",
        confirmDelegation: true,
        expectedToolsHash: toolsHash(["a_tool", "b_tool"]),
      });
      expect(r).toMatchObject({ modeReset: false, space: { accessMode: "owner" } });
    });

    it("a stale reviewed list is refused as tools_changed and nothing is written", async () => {
      await upsertSpace({ name: "s1", ...base });
      const before = (await getSpace("s1"))!;
      const r = await updateSpaceMeta("s1", "u1", {
        title: "Changed",
        accessMode: "owner",
        confirmDelegation: true,
        expectedToolsHash: toolsHash(["a_tool"]),
      });
      expect(r).toBe("tools_changed");
      expect(await getSpace("s1")).toEqual(before);
    });

    it("confirming without a reviewed hash is refused", async () => {
      await upsertSpace({ name: "s1", ...base });
      const before = (await getSpace("s1"))!;
      expect(await updateSpaceMeta("s1", "u1", { accessMode: "owner", confirmDelegation: true })).toBe("tools_changed");
      expect(await getSpace("s1")).toEqual(before);
    });

    // updateSpaceMeta reads, then writes through writeSpaceMetaIfUnchanged; a
    // concurrent write between the two cannot be injected mid-function, so the
    // predicate is tested on the helper directly with a stale read.
    const readRow = async () =>
      (await db.get<SpaceMetaSnapshot>(
        "SELECT title, description, tools, visibility, access_mode, delegated_tools_hash FROM spaces WHERE name = ?",
        ["s1"]
      ))!;

    it("the write is a compare-and-set on the stored tool list", async () => {
      await upsertSpace({ name: "s1", ...base });
      const stale = await readRow();
      const cur = (await getSpace("s1"))!;
      await upsertSpace({ name: "s1", ...base, tools: ["z_tool"] }); // the concurrent redeploy
      const next: Space = { ...cur, accessMode: "owner", delegatedToolsHash: toolsHash(cur.tools), updatedAt: cur.updatedAt + 1 };
      expect(await writeSpaceMetaIfUnchanged(next, stale)).toBe(false);
      expect((await getSpace("s1"))!).toMatchObject({ tools: ["z_tool"], accessMode: "viewer" });
      const fresh = await readRow();
      expect(await writeSpaceMetaIfUnchanged({ ...next, tools: ["z_tool"] }, fresh)).toBe(true);
      expect((await getSpace("s1"))!.accessMode).toBe("owner");
      // Another owner never matches.
      expect(await writeSpaceMetaIfUnchanged({ ...next, ownerId: "u2" }, await readRow())).toBe(false);
    });

    it("a confirm read before a private redeploy of the same tools cannot undo it", async () => {
      await upsertSpace({ name: "s1", ...base });
      const stale = await readRow();
      const cur = (await getSpace("s1"))!;
      // The agent redeploys the same tools, private.
      await upsertSpace({ name: "s1", ...base, visibility: "private" });
      const confirm: Space = { ...cur, accessMode: "owner", delegatedToolsHash: toolsHash(cur.tools), updatedAt: cur.updatedAt + 1 };
      expect(await writeSpaceMetaIfUnchanged(confirm, stale)).toBe(false);
      expect((await getSpace("s1"))!).toMatchObject({ visibility: "private", accessMode: "viewer", delegatedToolsHash: null });
    });

    it("the compare covers the mode, the pin and the title too", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enableIn("s1");
      const stale = await readRow();
      const cur = (await getSpace("s1"))!;
      await updateSpaceMeta("s1", "u1", { accessMode: "viewer" });
      expect(await writeSpaceMetaIfUnchanged({ ...cur, title: "Late" }, stale)).toBe(false);
      await enableIn("s1");
      const stale2 = await readRow();
      await updateSpaceMeta("s1", "u1", { title: "Other" });
      expect(await writeSpaceMetaIfUnchanged({ ...cur, title: "Late" }, stale2)).toBe(false);
      expect((await getSpace("s1"))!).toMatchObject({ title: "Other", accessMode: "owner" });
    });

    it("owner without confirmation does not turn it on", async () => {
      await upsertSpace({ name: "s1", ...base });
      await updateSpaceMeta("s1", "u1", { accessMode: "owner" });
      expect((await getSpace("s1"))!).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });
    });

    it("a tool change suspends it and a re-confirm resumes it", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enable();
      const changed = (await meta(updateSpaceMeta("s1", "u1", { tools: ["a_tool", "c_tool"] })))!;
      expect(changed.space.accessMode).toBe("owner");
      expect(delegationSuspended(changed.space)).toBe(true);
      expect(delegationSuspended((await getSpace("s1"))!)).toBe(true);
      await enable();
      const resumed = (await getSpace("s1"))!;
      expect(resumed.delegatedToolsHash).toBe(toolsHash(["a_tool", "c_tool"]));
      expect(delegationSuspended(resumed)).toBe(false);
    });

    it("a redeploy that changes the tools also suspends it", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enable();
      await upsertSpace({ name: "s1", ...base, tools: ["z_tool"] });
      const s = (await getSpace("s1"))!;
      expect(s.accessMode).toBe("owner");
      expect(delegationSuspended(s)).toBe(true);
    });

    it("turning it off clears the hash", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enable();
      const r = (await meta(updateSpaceMeta("s1", "u1", { accessMode: "viewer" })))!;
      expect(r.modeReset).toBe(true);
      expect(r.space).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });
      expect((await getSpace("s1"))!).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });
    });

    it("going private through updateSpaceMeta resets it and reports modeReset", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enable();
      const r = (await meta(updateSpaceMeta("s1", "u1", { visibility: "private" })))!;
      expect(r.modeReset).toBe(true);
      expect(r.space).toMatchObject({ visibility: "private", accessMode: "viewer", delegatedToolsHash: null });
      expect((await getSpace("s1"))!).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });
      // Already viewer: nothing to report.
      expect((await meta(updateSpaceMeta("s1", "u1", { visibility: "private" })))!.modeReset).toBe(false);
    });

    it("a private redeploy through upsertSpace resets it and reports modeReset", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enable();
      expect(await upsertSpace({ name: "s1", ...base, visibility: "private" })).toEqual({ result: "ok", modeReset: true });
      expect((await getSpace("s1"))!).toMatchObject({ visibility: "private", accessMode: "viewer", delegatedToolsHash: null });
      expect(await upsertSpace({ name: "s1", ...base, visibility: "private" })).toEqual({ result: "ok", modeReset: false });
    });

    it("a redeploy without accessMode keeps owner mode and the hash", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enable();
      expect(await upsertSpace({ name: "s1", ...base, title: "Again" })).toEqual({ result: "ok", modeReset: false });
      expect((await getSpace("s1"))!).toMatchObject({
        title: "Again",
        accessMode: "owner",
        delegatedToolsHash: toolsHash(base.tools),
      });
    });

    it("a redeploy passing viewer turns it off and reports modeReset", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enable();
      expect(await upsertSpace({ name: "s1", ...base, accessMode: "viewer" })).toEqual({ result: "ok", modeReset: true });
      expect((await getSpace("s1"))!).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });
    });

    it("another user's redeploy is taken and leaves the mode alone", async () => {
      await upsertSpace({ name: "s1", ...base });
      await enable();
      expect(await upsertSpace({ name: "s1", ...base, ownerId: "u2", visibility: "private" })).toEqual({
        result: "taken",
        modeReset: false,
      });
      expect((await getSpace("s1"))!).toMatchObject({ ownerId: "u1", accessMode: "owner", visibility: "org" });
    });

    it("an unknown stored mode reads as viewer", async () => {
      await upsertSpace({ name: "s1", ...base });
      await db.run("UPDATE spaces SET access_mode = ? WHERE name = ?", ["root", "s1"]);
      expect((await getSpace("s1"))!.accessMode).toBe("viewer");
    });
  });

  it("kv enforces the per-value and per-viewer limits", async () => {
    expect(await kvPut("s1", "v1", "k", JSON.stringify({ a: 1 }))).toBe("ok");
    expect(JSON.parse((await kvGet("s1", "v1", "k"))!)).toEqual({ a: 1 });
    expect(await kvGet("s1", "v2", "k")).toBeNull();
    expect(await kvPut("s1", "v1", "big", JSON.stringify("x".repeat(KV_VALUE_MAX_BYTES)))).toBe("TOO_LARGE");
    const chunk = JSON.stringify("y".repeat(60 * 1024));
    for (const k of ["a", "b", "c", "d"]) expect(await kvPut("s1", "v1", k, chunk)).toBe("ok");
    expect(await kvPut("s1", "v1", "e", chunk)).toBe("TOO_LARGE");
    // Overwriting an existing key counts its new size, not both.
    expect(await kvPut("s1", "v1", "a", chunk)).toBe("ok");
    expect(await kvKeys("s1", "v1")).toEqual(["a", "b", "c", "d", "k"]);
  });

  it("hasFiles and listSpaceFiles read the tree", async () => {
    expect(hasFiles("s1")).toBe(false);
    writeSpaceFiles(tmp, "s1", { "index.html": "<p>hi</p>", "js/app.js": "1" });
    expect(hasFiles("s1")).toBe(true);
    expect(listSpaceFiles("s1").map((f) => f.path)).toEqual(["index.html", "js/app.js"]);
  });

  it("delete cascades to shares, consents, kv and files", async () => {
    await upsertSpace({ name: "s1", ...base });
    await upsertSpace({ name: "keep", ...base });
    const s = (await getSpace("s1"))!;
    await setShares("s1", "u1", ["dev@example.com"]);
    await setShares("keep", "u1", ["dev@example.com"]);
    await grantConsent(s, "v1");
    await kvPut("s1", "v1", "k", "1");
    await kvPut("keep", "v1", "k", "1");
    writeSpaceFiles(tmp, "s1", { "index.html": "x" });

    await deleteSpace("s1");
    expect(await getSpace("s1")).toBeNull();
    expect(await getShares("s1")).toEqual([]);
    expect(await getConsentHash("s1", "v1")).toBeNull();
    expect(await kvKeys("s1", "v1")).toEqual([]);
    expect(fs.existsSync(path.join(tmp, "s1"))).toBe(false);
    // Another Space is untouched.
    expect(await getShares("keep")).toEqual(["dev@example.com"]);
    expect(await kvKeys("keep", "v1")).toEqual(["k"]);
    expect(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM spaces"))!.n)).toBe(1);
  });
});
