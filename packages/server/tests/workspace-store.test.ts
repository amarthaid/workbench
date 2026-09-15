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

import {
  listFiles,
  statFile,
  usedBytes,
  readFileBytes,
  writeFileBytes,
  openWriteStream,
  deleteFile,
  WorkspaceError,
} from "../src/workspace/store";
import { userWorkspaceDir } from "../src/workspace/paths";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-store-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

describe("workspace/store", () => {
  it("round-trips bytes, including non-UTF8", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x42, 0x80]);
    await writeFileBytes("u1", "blob.bin", bytes);
    expect(await readFileBytes("u1", "blob.bin")).toEqual(bytes);
  });

  it("refuses a write over the per-file cap and leaves no file", async () => {
    await expectCode(writeFileBytes("u1", "big.bin", Buffer.alloc(1001)), "TOO_LARGE");
    expect(await listFiles("u1")).toEqual([]);
  });

  it("refuses a write that would breach the per-user quota", async () => {
    await writeFileBytes("u1", "a.bin", Buffer.alloc(900));
    await writeFileBytes("u1", "b.bin", Buffer.alloc(900));
    await writeFileBytes("u1", "c.bin", Buffer.alloc(700));
    await expectCode(writeFileBytes("u1", "d.bin", Buffer.alloc(100)), "QUOTA_EXCEEDED");
    expect((await listFiles("u1")).map((f) => f.name).sort()).toEqual(["a.bin", "b.bin", "c.bin"]);
  });

  it("counts an overwrite against the quota only once", async () => {
    await writeFileBytes("u1", "a.bin", Buffer.alloc(900));
    await writeFileBytes("u1", "b.bin", Buffer.alloc(900));
    // Rewriting a.bin at the same size must not be treated as +900 on top.
    await expect(writeFileBytes("u1", "a.bin", Buffer.alloc(900))).resolves.toBeTruthy();
  });

  it("scopes usedBytes and listFiles to one user", async () => {
    await writeFileBytes("u1", "x.csv", Buffer.alloc(100));
    await writeFileBytes("u2", "x.csv", Buffer.alloc(200));
    expect(await usedBytes("u1")).toBe(100);
    expect(await usedBytes("u2")).toBe(200);
    expect((await listFiles("u1")).map((f) => f.name)).toEqual(["x.csv"]);
  });

  it("reports another user's file as NOT_FOUND, not FORBIDDEN", async () => {
    await writeFileBytes("u2", "secret.csv", Buffer.from("a,b"));
    // No existence oracle: u1 cannot tell the file exists at all.
    await expectCode(readFileBytes("u1", "secret.csv"), "NOT_FOUND");
  });

  it("refuses a traversal name", async () => {
    await expectCode(writeFileBytes("u1", "../escape.csv", Buffer.from("x")), "INVALID_NAME");
  });

  it("refuses to read a file larger than the caller's cap", async () => {
    await writeFileBytes("u1", "mid.bin", Buffer.alloc(500));
    await expectCode(readFileBytes("u1", "mid.bin", 100), "TOO_LARGE");
  });

  it("deletes and reports whether anything went", async () => {
    await writeFileBytes("u1", "gone.csv", Buffer.from("x"));
    expect(await deleteFile("u1", "gone.csv")).toBe(true);
    expect(await deleteFile("u1", "gone.csv")).toBe(false);
    expect(await deleteFile("u1", "never.csv")).toBe(false);
  });

  it("streams a file in and commits it atomically", async () => {
    const h = await openWriteStream("u1", "stream.csv");
    await h.write(Buffer.from("a,b\n"));
    await h.write(Buffer.from("1,2\n"));
    const entry = await h.commit();
    expect(entry.bytes).toBe(8);
    expect((await readFileBytes("u1", "stream.csv")).toString()).toBe("a,b\n1,2\n");
  });

  it("leaves no partial behind when a stream aborts", async () => {
    const h = await openWriteStream("u1", "half.csv");
    await h.write(Buffer.from("partial"));
    await h.abort();
    expect(await listFiles("u1")).toEqual([]);
    expect(fs.readdirSync(userWorkspaceDir("u1"))).toEqual([]);
  });

  it("aborts mid-stream on the per-file cap and leaves nothing", async () => {
    const h = await openWriteStream("u1", "toobig.bin");
    await h.write(Buffer.alloc(600));
    await expect(h.write(Buffer.alloc(600))).rejects.toBeInstanceOf(WorkspaceError);
    expect(await listFiles("u1")).toEqual([]);
    expect(fs.readdirSync(userWorkspaceDir("u1"))).toEqual([]);
  });

  it("never lists a partial file", async () => {
    const h = await openWriteStream("u1", "inflight.csv");
    await h.write(Buffer.from("x"));
    expect(await listFiles("u1")).toEqual([]);
    await h.abort();
  });

  it("derives expiresAt from mtime and the TTL", async () => {
    const e = await writeFileBytes("u1", "aged.csv", Buffer.from("x"));
    const delta = Date.parse(e.expiresAt) - Date.parse(e.mtime);
    expect(delta).toBe(24 * 3_600_000);
  });

  it("does not move expiresAt when the file is read", async () => {
    const written = await writeFileBytes("u1", "read.csv", Buffer.from("x"));
    await readFileBytes("u1", "read.csv");
    const after = await statFile("u1", "read.csv");
    // Age is mtime, and a read does not touch it — "gone within 24h" has to
    // stay a guarantee, or the buffer slowly becomes a document store.
    expect(after!.expiresAt).toBe(written.expiresAt);
  });

  it("creates the user directory 0700", async () => {
    await writeFileBytes("u1", "x.csv", Buffer.from("x"));
    const mode = fs.statSync(userWorkspaceDir("u1")).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
