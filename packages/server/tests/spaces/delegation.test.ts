import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/db";
import { setPermission } from "../../src/permissions/store";
import { setUserDisabled } from "../../src/auth/user-status";
import { getSpace, updateSpaceMeta, upsertSpace, toolsHash, type Space } from "../../src/spaces/store";
import { delegationFor, mayEnableDelegation, recordDelegationChange } from "../../src/spaces/delegation";
import { acmePlugin } from "./fixtures";
import { resetSpacesDb, seedUser } from "./helpers";

const TOOLS = ["acme_list_items"];

async function grant(userId: string) {
  await setPermission({ userId, capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
}

/** A Space in owner mode, confirmed for its current tool list. */
async function delegated(): Promise<Space> {
  await upsertSpace({ name: "s1", ownerId: "u1", title: "T", tools: TOOLS, visibility: "org" });
  const r = await updateSpaceMeta("s1", "u1", { accessMode: "owner", confirmDelegation: true, expectedToolsHash: toolsHash(TOOLS) });
  if (!r || typeof r === "string") throw new Error("setup failed");
  return r.space;
}

beforeEach(async () => {
  await resetSpacesDb();
  await seedUser("u1", "dev@example.com");
  await seedUser("u2", "qa@example.com");
});

describe("mayEnableDelegation", () => {
  it("refuses a private audience, even when granted", async () => {
    await grant("u1");
    const r = await mayEnableDelegation("u1", "private");
    expect(r).toMatchObject({ ok: false, code: "DELEGATION_NOT_ALLOWED" });
  });

  it("refuses an owner without the permission", async () => {
    const r = await mayEnableDelegation("u1", "org");
    expect(r).toMatchObject({ ok: false, code: "DELEGATION_NOT_ALLOWED" });
    if (!r.ok) expect(r.message).toMatch(/admin/);
  });

  it("allows a granted owner with org or users", async () => {
    await grant("u1");
    expect(await mayEnableDelegation("u1", "org")).toEqual({ ok: true });
    expect(await mayEnableDelegation("u1", "users")).toEqual({ ok: true });
  });
});

describe("delegationFor", () => {
  it("viewer mode is the viewer", async () => {
    await upsertSpace({ name: "s1", ownerId: "u1", title: "T", tools: TOOLS, visibility: "org" });
    await grant("u1");
    expect(await delegationFor((await getSpace("s1"))!)).toEqual({ mode: "viewer" });
  });

  it("owner mode, granted, unchanged: runs as the owner", async () => {
    await grant("u1");
    const s = await delegated();
    expect(await delegationFor(s)).toEqual({ mode: "owner", runAs: "u1" });
  });

  it("private audience is off, never the viewer", async () => {
    await grant("u1");
    const s = await delegated();
    // A row that is private but still says owner (not reachable through the store).
    expect(await delegationFor({ ...s, visibility: "private" })).toMatchObject({ mode: "off", reason: "turned_off" });
  });

  it("missing owner row is off", async () => {
    await grant("u1");
    const s = await delegated();
    await db.run("DELETE FROM users WHERE id = ?", ["u1"]);
    expect(await delegationFor(s)).toMatchObject({ mode: "off", reason: "turned_off" });
  });

  it("disabled owner is off, and resumes when enabled", async () => {
    await grant("u1");
    const s = await delegated();
    await setUserDisabled("u1", true);
    expect(await delegationFor(s)).toMatchObject({ mode: "off", reason: "turned_off" });
    await setUserDisabled("u1", false);
    expect(await delegationFor(s)).toEqual({ mode: "owner", runAs: "u1" });
  });

  it("permission revoked is off, and re-granting resumes it", async () => {
    await grant("u1");
    const s = await delegated();
    await db.run("DELETE FROM user_permissions WHERE user_id = ?", ["u1"]);
    expect(await delegationFor(s)).toMatchObject({ mode: "off", reason: "turned_off" });
    await grant("u1");
    expect(await delegationFor(s)).toEqual({ mode: "owner", runAs: "u1" });
  });

  it("tool list changed since the confirm is off with tools_changed", async () => {
    await grant("u1");
    await delegated();
    await upsertSpace({ name: "s1", ownerId: "u1", title: "T", tools: [...TOOLS, "acme_fail"], visibility: "org" });
    const r = await delegationFor((await getSpace("s1"))!);
    expect(r).toMatchObject({ mode: "off", reason: "tools_changed" });
    if (r.mode === "off") expect(r.message).toMatch(/confirm/);
  });
});

describe("recordDelegationChange", () => {
  const rows = () =>
    db.all<{ user_id: string; action: string; tool: string; success: number | boolean; error: string | null }>(
      "SELECT user_id, action, tool, success, error FROM audit_log ORDER BY id"
    );

  it("writes ON and OFF rows as the owner, tool space:<name>", async () => {
    await upsertSpace({ name: "s1", ownerId: "u1", title: "T", tools: TOOLS, visibility: "org" });
    const s = (await getSpace("s1"))!;
    await recordDelegationChange(s, "u1", "on");
    await recordDelegationChange(s, "u1", "off");
    const r = await rows();
    expect(r.map((x) => [x.user_id, x.action, x.tool, Boolean(x.success), x.error ?? null])).toEqual([
      ["u1", "SPACE_DELEGATION_ON", "space:s1", true, null],
      ["u1", "SPACE_DELEGATION_OFF", "space:s1", true, null],
    ]);
  });

  it("a forced OFF carries the reason", async () => {
    await upsertSpace({ name: "s1", ownerId: "u1", title: "T", tools: TOOLS, visibility: "org" });
    await recordDelegationChange((await getSpace("s1"))!, "u1", "off", "audience set to only me");
    expect((await rows())[0]).toMatchObject({ action: "SPACE_DELEGATION_OFF", error: "reason: audience set to only me" });
  });
});

describe("delegable", () => {
  it("a tool that rewrites its own stored credential is not delegable; the rest are", async () => {
    const mod = await import("../../../plugins/clevertap/tools/index");
    const tools = Object.values(mod).filter((t: any) => t && typeof t === "object" && typeof t.name === "string") as Array<{
      name: string;
      delegable?: boolean;
    }>;
    expect(tools.length).toBeGreaterThan(2);
    const notDelegable = tools.filter((t) => t.delegable === false).map((t) => t.name);
    expect(notDelegable).toEqual(["clevertap_set_projects"]);
    expect(acmePlugin.tools.every((t) => t.delegable === undefined)).toBe(true);
  });
});
