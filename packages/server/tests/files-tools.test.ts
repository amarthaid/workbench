import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

vi.mock("../src/workspace/dir", () => ({ workspaceRoot: () => tmp }));
vi.mock("../src/config", () => ({
  config: {
    WORKSPACE_TTL_HOURS: 24,
    WORKSPACE_MAX_FILE_BYTES: 1000,
    WORKSPACE_MAX_BYTES_PER_USER: 2500,
    NODE_ENV: "test",
  },
}));

import { filesPlugin, FILES_INTEGRATION_NAME } from "../src/plugins/internal/files";

const tool = (name: string) => {
  const t = filesPlugin.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const run = (name: string, userId: string, args: Record<string, unknown> = {}) => {
  const t = tool(name);
  return t.handler({ userId } as never, t.inputSchema.parse(args) as never) as Promise<any>;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "files-tools-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("files integration", () => {
  it("registers every tool under the files integration", () => {
    expect(filesPlugin.integration.name).toBe(FILES_INTEGRATION_NAME);
    expect(filesPlugin.tools.map((t) => t.name).sort()).toEqual([
      "files_delete",
      "files_list",
      "files_read",
      "files_stat",
      "files_write",
    ]);
    for (const t of filesPlugin.tools) expect(t.integration).toBe(FILES_INTEGRATION_NAME);
  });

  it("states the retention rule in the descriptions an agent reads first", () => {
    for (const name of ["files_list", "files_read", "files_write", "files_stat"]) {
      expect(tool(name).description).toMatch(/24 hours/);
    }
  });

  it("writes then reads text", async () => {
    await run("files_write", "u1", { name: "a.csv", content: "x,y" });
    const read = await run("files_read", "u1", { name: "a.csv" });
    expect(read.content).toBe("x,y");
    expect(read.bytes).toBe(3);
  });

  it("round-trips binary through base64 that utf8 would corrupt", async () => {
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x80]);
    await run("files_write", "u1", { name: "b.bin", content: raw.toString("base64"), encoding: "base64" });
    const b64 = await run("files_read", "u1", { name: "b.bin", encoding: "base64" });
    expect(Buffer.from(b64.content, "base64")).toEqual(raw);

    const utf8 = await run("files_read", "u1", { name: "b.bin", encoding: "utf8" });
    expect(Buffer.from(utf8.content, "utf8")).not.toEqual(raw);
  });

  it("returns INVALID_NAME for a traversal rather than throwing", async () => {
    await expect(
      run("files_write", "u1", { name: "../escape.csv", content: "x" })
    ).resolves.toEqual({ error: "INVALID_NAME" });
  });

  it("scopes listing to the calling user", async () => {
    await run("files_write", "u1", { name: "mine.csv", content: "x" });
    await run("files_write", "u2", { name: "theirs.csv", content: "y" });
    const listed = await run("files_list", "u1");
    expect(listed.files.map((f: any) => f.name)).toEqual(["mine.csv"]);
  });

  it("cannot read another user's file", async () => {
    await run("files_write", "u2", { name: "secret.csv", content: "x" });
    await expect(run("files_read", "u1", { name: "secret.csv" })).resolves.toEqual({
      error: "NOT_FOUND",
    });
  });

  it("refuses an oversize read instead of truncating", async () => {
    await run("files_write", "u1", { name: "mid.csv", content: "y".repeat(500) });
    const res = await run("files_read", "u1", { name: "mid.csv", maxBytes: 10 });
    expect(res.error).toBe("TOO_LARGE");
    expect(res.content).toBeUndefined();
  });

  it("reports quota alongside the listing", async () => {
    await run("files_write", "u1", { name: "a.csv", content: "12345" });
    const listed = await run("files_list", "u1");
    expect(listed.usedBytes).toBe(5);
    expect(listed.quotaBytes).toBe(2500);
  });

  it("deletes and then reports NOT_FOUND", async () => {
    await run("files_write", "u1", { name: "gone.csv", content: "x" });
    expect(await run("files_delete", "u1", { name: "gone.csv" })).toMatchObject({ ok: true });
    expect(await run("files_delete", "u1", { name: "gone.csv" })).toEqual({ error: "NOT_FOUND" });
  });
});
