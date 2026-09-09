import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/jots/store", () => ({
  deployJot: vi.fn(),
  listJots: vi.fn(),
  deleteJot: vi.fn(),
  listJotFiles: vi.fn(),
  updateJotMeta: vi.fn(),
  readManifest: vi.fn(() => null),
}));
vi.mock("../src/jots/pending", () => ({
  mint: vi.fn(() => ({ token: "tok123", expiresAt: 42 })),
}));
vi.mock("../src/jots/auth", () => ({
  hashPassword: vi.fn(() => "scrypt$salt$hash"),
}));

import { jotsPlugin } from "../src/plugins/internal/jots";
import * as store from "../src/jots/store";
import { hashPassword } from "../src/jots/auth";
import { mint } from "../src/jots/pending";
import { readManifest, updateJotMeta } from "../src/jots/store";

function findTool(name: string) {
  return jotsPlugin.tools.find((t) => t.name === name)!;
}

describe("jots plugin tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deploy_jot mints a token and returns the upload URL for a public jot", async () => {
    vi.mocked(readManifest).mockReturnValue(null);
    const tool = findTool("deploy_jot");
    const result = await tool.handler({ userId: "u1" }, { name: "r", access: "public" });
    expect(mint).toHaveBeenCalledWith({ owner: "u1", name: "r", access: "public", passwordHash: undefined });
    expect(result).toMatchObject({ token: "tok123", expiresAt: 42, maxBytes: 5_242_880 });
    expect((result as { uploadUrl: string }).uploadUrl).toMatch(/\/j\/upload\/tok123$/);
  });

  it("deploy_jot hashes the password for a password jot", async () => {
    vi.mocked(readManifest).mockReturnValue(null);
    const tool = findTool("deploy_jot");
    await tool.handler({ userId: "u1" }, { name: "s", access: "password", password: "pw" });
    expect(hashPassword).toHaveBeenCalledWith("pw");
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ access: "password", passwordHash: "scrypt$salt$hash" }));
  });

  it("deploy_jot errors if a password jot has no password", async () => {
    const tool = findTool("deploy_jot");
    const result = await tool.handler({ userId: "u1" }, { name: "s", access: "password" });
    expect(result).toEqual({ error: "PASSWORD_REQUIRED" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("deploy_jot rejects an invalid name", async () => {
    const tool = findTool("deploy_jot");
    const result = await tool.handler({ userId: "u1" }, { name: "Bad Name", access: "public" });
    expect(result).toEqual({ error: "INVALID_NAME" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("deploy_jot refuses a name owned by another user", async () => {
    vi.mocked(readManifest).mockReturnValue({ access: "public", owner: "someone-else", createdAt: "t", updatedAt: "t" });
    const tool = findTool("deploy_jot");
    const result = await tool.handler({ userId: "u1" }, { name: "taken", access: "public" });
    expect(result).toEqual({ error: "JOT_NAME_TAKEN" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("list_jots returns the caller's jots", async () => {
    vi.mocked(store.listJots).mockReturnValue([{ name: "r", access: "public", url: "https://wb.test/j/r/", updatedAt: "t" }]);
    const tool = findTool("list_jots");
    const result = await tool.handler({ userId: "u1" }, {});
    expect(store.listJots).toHaveBeenCalledWith("u1");
    expect(result).toEqual({ jots: [{ name: "r", access: "public", url: "https://wb.test/j/r/", updatedAt: "t" }] });
  });

  it("delete_jot forwards owner + name", async () => {
    vi.mocked(store.deleteJot).mockReturnValue({ ok: true });
    const tool = findTool("delete_jot");
    const result = await tool.handler({ userId: "u1" }, { name: "r" });
    expect(store.deleteJot).toHaveBeenCalledWith("r", "u1");
    expect(result).toEqual({ ok: true });
  });
});

describe("jots plugin update_jot", () => {
  beforeEach(() => vi.clearAllMocks());

  const owned = { access: "public" as const, owner: "u1", createdAt: "t", updatedAt: "t" };

  it("mints a patch token for a jot the caller owns", async () => {
    vi.mocked(readManifest).mockReturnValue(owned);
    const result = await findTool("update_jot").handler({ userId: "u1" }, { name: "site" });
    expect(mint).toHaveBeenCalledWith({ owner: "u1", name: "site", mode: "patch", deletes: [] });
    expect(result).toMatchObject({ token: "tok123", expiresAt: 42 });
    expect((result as { uploadUrl: string }).uploadUrl).toMatch(/\/j\/upload\/tok123$/);
    expect(updateJotMeta).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("applied");
  });

  it("passes the delete list through to the token", async () => {
    vi.mocked(readManifest).mockReturnValue(owned);
    await findTool("update_jot").handler({ userId: "u1" }, { name: "site", delete: ["old.json"] });
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ deletes: ["old.json"] }));
  });

  it("applies a password immediately, without waiting for an upload", async () => {
    vi.mocked(readManifest).mockReturnValue(owned);
    vi.mocked(updateJotMeta).mockReturnValue({ name: "site", access: "password", cors: false, url: "https://wb.test/j/site/" });
    const result = await findTool("update_jot").handler({ userId: "u1" }, { name: "site", password: "pw" });
    expect(hashPassword).toHaveBeenCalledWith("pw");
    expect(updateJotMeta).toHaveBeenCalledWith("site", "u1", {
      access: "password",
      passwordHash: "scrypt$salt$hash",
      cors: undefined,
    });
    expect(result).toMatchObject({ applied: { access: "password", cors: false } });
  });

  it("unlocks a jot back to public without a password", async () => {
    vi.mocked(readManifest).mockReturnValue({ ...owned, access: "password", hash: "scrypt$a$b" });
    vi.mocked(updateJotMeta).mockReturnValue({ name: "site", access: "public", cors: false, url: "https://wb.test/j/site/" });
    const result = await findTool("update_jot").handler({ userId: "u1" }, { name: "site", access: "public" });
    expect(hashPassword).not.toHaveBeenCalled();
    expect(updateJotMeta).toHaveBeenCalledWith("site", "u1", { access: "public", passwordHash: undefined, cors: undefined });
    expect(result).toMatchObject({ applied: { access: "public", cors: false } });
  });

  it("applies the cors flag on its own", async () => {
    vi.mocked(readManifest).mockReturnValue(owned);
    vi.mocked(updateJotMeta).mockReturnValue({ name: "site", access: "public", cors: true, url: "https://wb.test/j/site/" });
    const result = await findTool("update_jot").handler({ userId: "u1" }, { name: "site", cors: true });
    expect(updateJotMeta).toHaveBeenCalledWith("site", "u1", { access: undefined, passwordHash: undefined, cors: true });
    expect(result).toMatchObject({ applied: { access: "public", cors: true } });
    // cors now rides the manifest, not the upload token.
    expect(mint).toHaveBeenCalledWith({ owner: "u1", name: "site", mode: "patch", deletes: [] });
  });

  it("rejects an empty password and surfaces a settings error without minting", async () => {
    vi.mocked(readManifest).mockReturnValue(owned);
    expect(await findTool("update_jot").handler({ userId: "u1" }, { name: "site", password: "" })).toEqual({
      error: "PASSWORD_REQUIRED",
    });
    vi.mocked(updateJotMeta).mockReturnValue({ error: "PASSWORD_REQUIRED" });
    expect(await findTool("update_jot").handler({ userId: "u1" }, { name: "site", access: "password" })).toEqual({
      error: "PASSWORD_REQUIRED",
    });
    expect(mint).not.toHaveBeenCalled();
  });

  it("refuses an unknown jot, a jot owned by someone else, and an invalid name", async () => {
    vi.mocked(readManifest).mockReturnValue(null);
    expect(await findTool("update_jot").handler({ userId: "u1" }, { name: "site" })).toEqual({ error: "NOT_FOUND" });
    vi.mocked(readManifest).mockReturnValue({ ...owned, owner: "u2" });
    expect(await findTool("update_jot").handler({ userId: "u1" }, { name: "site" })).toEqual({ error: "FORBIDDEN" });
    expect(await findTool("update_jot").handler({ userId: "u1" }, { name: "BAD" })).toEqual({ error: "INVALID_NAME" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("rejects a delete path that escapes the jot or names the manifest", async () => {
    vi.mocked(readManifest).mockReturnValue(owned);
    expect(await findTool("update_jot").handler({ userId: "u1" }, { name: "site", delete: ["../etc"] })).toEqual({ error: "INVALID_PATH" });
    expect(await findTool("update_jot").handler({ userId: "u1" }, { name: "site", delete: ["jot.json"] })).toEqual({ error: "INVALID_PATH" });
    expect(mint).not.toHaveBeenCalled();
    // A bad path aborts before any setting is applied.
    expect(await findTool("update_jot").handler({ userId: "u1" }, { name: "site", delete: [".."], access: "public" })).toEqual({
      error: "INVALID_PATH",
    });
    expect(updateJotMeta).not.toHaveBeenCalled();
  });
});

describe("jots plugin list_jot_files", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the caller's own jot tree", async () => {
    vi.mocked(store.listJotFiles).mockReturnValue({ files: [{ path: "data.json", bytes: 2, updatedAt: "t" }] });
    const result = await findTool("list_jot_files").handler({ userId: "u1" }, { name: "site" });
    expect(store.listJotFiles).toHaveBeenCalledWith("site", "u1");
    expect(result).toEqual({ files: [{ path: "data.json", bytes: 2, updatedAt: "t" }] });
  });
});

describe("jots plugin deploy_jot cors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the cors flag to the token", async () => {
    vi.mocked(readManifest).mockReturnValue(null);
    await findTool("deploy_jot").handler({ userId: "u1" }, { name: "r", access: "public", cors: true });
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ cors: true }));
  });
});
