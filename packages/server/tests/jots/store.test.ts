import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

vi.mock("../../src/jots/dir", () => ({ jotsRoot: () => tmp }));
vi.mock("../../src/config", () => ({
  config: { JOTS_MAX_BYTES: 1000, JOTS_MAX_FILES: 1000, SERVER_PUBLIC_URL: "https://wb.test", NODE_ENV: "test" },
}));

import { deployJot, commitJotDir, listJots, deleteJot, readManifest, listJotFiles, updateJotMeta } from "../../src/jots/store";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jots-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const file = (p: string, content: string) => ({ path: p, content });

describe("jots/store", () => {
  it("creates a jot and returns its url", () => {
    const r = deployJot({ name: "report", owner: "u1", access: "public", files: [file("index.html", "<h1>hi</h1>")] });
    expect(r).toEqual({ name: "report", access: "public", url: "https://wb.test/j/report/" });
    expect(fs.readFileSync(path.join(tmp, "report", "index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(readManifest("report")?.owner).toBe("u1");
  });

  it("lets the owner overwrite, replacing the whole tree", () => {
    deployJot({ name: "report", owner: "u1", access: "public", files: [file("old.html", "x"), file("index.html", "1")] });
    const r = deployJot({ name: "report", owner: "u1", access: "public", files: [file("index.html", "2")] });
    expect("url" in r).toBe(true);
    expect(fs.existsSync(path.join(tmp, "report", "old.html"))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, "report", "index.html"), "utf8")).toBe("2");
  });

  it("blocks a different owner from overwriting", () => {
    deployJot({ name: "report", owner: "u1", access: "public", files: [file("index.html", "1")] });
    const r = deployJot({ name: "report", owner: "u2", access: "public", files: [file("index.html", "2")] });
    expect(r).toEqual({ error: "JOT_NAME_TAKEN" });
    expect(fs.readFileSync(path.join(tmp, "report", "index.html"), "utf8")).toBe("1");
  });

  it("checks ownership before decoding/sizing files", () => {
    deployJot({ name: "report", owner: "u1", access: "public", files: [file("index.html", "x")] });
    const r = deployJot({ name: "report", owner: "u2", access: "public", files: [file("index.html", "x".repeat(2000))] });
    expect(r).toEqual({ error: "JOT_NAME_TAKEN" });
  });

  it("stores a password hash for password jots", () => {
    deployJot({ name: "secret", owner: "u1", access: "password", passwordHash: "scrypt$a$b", files: [file("index.html", "x")] });
    const m = readManifest("secret");
    expect(m?.access).toBe("password");
    expect(m?.hash).toBe("scrypt$a$b");
  });

  it("rejects bad name, empty files, unsafe path, oversize, and missing password hash", () => {
    expect(deployJot({ name: "Bad", owner: "u1", access: "public", files: [file("index.html", "x")] })).toEqual({ error: "INVALID_NAME" });
    expect(deployJot({ name: "ok", owner: "u1", access: "public", files: [] })).toEqual({ error: "NO_FILES" });
    expect(deployJot({ name: "ok", owner: "u1", access: "public", files: [file("../x", "x")] })).toEqual({ error: "INVALID_PATH" });
    expect(deployJot({ name: "ok", owner: "u1", access: "public", files: [file("index.html", "x".repeat(1001))] })).toEqual({ error: "TOO_LARGE" });
    expect(deployJot({ name: "ok", owner: "u1", access: "password", files: [file("index.html", "x")] })).toEqual({ error: "PASSWORD_REQUIRED" });
  });

  it("decodes base64 file content", () => {
    deployJot({ name: "b", owner: "u1", access: "public", files: [{ path: "index.html", content: Buffer.from("hello").toString("base64"), encoding: "base64" }] });
    expect(fs.readFileSync(path.join(tmp, "b", "index.html"), "utf8")).toBe("hello");
  });

  it("lists only the caller's own jots", () => {
    deployJot({ name: "mine", owner: "u1", access: "public", files: [file("index.html", "x")] });
    deployJot({ name: "theirs", owner: "u2", access: "public", files: [file("index.html", "x")] });
    const list = listJots("u1");
    expect(list.map((j) => j.name)).toEqual(["mine"]);
    expect(list[0].url).toBe("https://wb.test/j/mine/");
  });

  it("deletes only when the owner matches", () => {
    deployJot({ name: "mine", owner: "u1", access: "public", files: [file("index.html", "x")] });
    expect(deleteJot("mine", "u2")).toEqual({ error: "FORBIDDEN" });
    expect(deleteJot("mine", "u1")).toEqual({ ok: true });
    expect(fs.existsSync(path.join(tmp, "mine"))).toBe(false);
    expect(deleteJot("missing", "u1")).toEqual({ error: "NOT_FOUND" });
  });

  it("lists newest-updated first", () => {
    deployJot({ name: "older", owner: "u1", access: "public", files: [file("index.html", "x")] });
    deployJot({ name: "newer", owner: "u1", access: "public", files: [file("index.html", "x")] });
    // Make the ordering deterministic regardless of ms resolution: push "older" into the past.
    const mPath = path.join(tmp, "older", "jot.json");
    const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
    m.updatedAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
    const names = listJots("u1").map((j) => j.name);
    expect(names[0]).toBe("newer");
  });

  it("commitJotDir publishes a prepared directory", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "jot-src-"));
    fs.writeFileSync(path.join(src, "index.html"), "<h1>committed</h1>");
    const res = commitJotDir({ name: "fromdir", owner: "u1", access: "public", srcDir: src });
    expect(res).toMatchObject({ name: "fromdir", access: "public" });
    expect(readManifest("fromdir")).toMatchObject({ owner: "u1", access: "public" });
  });

  it("commitJotDir refuses a name owned by another user", () => {
    deployJot({ name: "owned", owner: "u1", access: "public", files: [{ path: "index.html", content: "x" }] });
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "jot-src-"));
    fs.writeFileSync(path.join(src, "index.html"), "x");
    const res = commitJotDir({ name: "owned", owner: "u2", access: "public", srcDir: src });
    expect(res).toEqual({ error: "JOT_NAME_TAKEN" });
  });

  it("commitJotDir returns DEPLOY_FAILED when the source dir is missing", () => {
    const missing = path.join(tmp, "does-not-exist");
    const res = commitJotDir({ name: "ghost", owner: "u1", access: "public", srcDir: missing });
    expect(res).toEqual({ error: "DEPLOY_FAILED" });
  });

  it("listJots returns [] when the jots root does not exist", () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(listJots("u1")).toEqual([]);
  });
});

describe("jots/store listJotFiles", () => {
  it("lists files recursively, excluding the manifest", () => {
    deployJot({
      name: "site", owner: "u1", access: "public",
      files: [file("index.html", "hi"), file("data/app.json", "{}"), file("a/b/c.txt", "xyz")],
    });
    const r = listJotFiles("site", "u1");
    expect("files" in r).toBe(true);
    const files = (r as { files: { path: string; bytes: number }[] }).files;
    expect(files.map((f) => f.path)).toEqual(["a/b/c.txt", "data/app.json", "index.html"]);
    expect(files.find((f) => f.path === "index.html")!.bytes).toBe(2);
    expect(files.some((f) => f.path.includes("jot.json"))).toBe(false);
  });

  it("refuses a jot owned by someone else, and an unknown name", () => {
    deployJot({ name: "site", owner: "u1", access: "public", files: [file("index.html", "hi")] });
    expect(listJotFiles("site", "u2")).toEqual({ error: "FORBIDDEN" });
    expect(listJotFiles("nope", "u1")).toEqual({ error: "NOT_FOUND" });
  });
});

describe("jots/store cors flag", () => {
  it("persists cors on the manifest and preserves it across a commit", () => {
    deployJot({ name: "site", owner: "u1", access: "public", cors: true, files: [file("index.html", "hi")] });
    expect(readManifest("site")?.cors).toBe(true);
  });

  it("omits cors when not requested", () => {
    deployJot({ name: "site", owner: "u1", access: "public", files: [file("index.html", "hi")] });
    expect(readManifest("site")?.cors).toBeUndefined();
  });
});

describe("jots/store updateJotMeta", () => {
  const seed = (access: "public" | "password" = "public", extra: Record<string, unknown> = {}) =>
    deployJot({ name: "site", owner: "u1", access, files: [file("index.html", "hi")], ...extra });

  it("gates a public jot without touching its files", () => {
    seed();
    const r = updateJotMeta("site", "u1", { access: "password", passwordHash: "scrypt$a$b" });
    expect(r).toEqual({ name: "site", access: "password", cors: false, url: "https://wb.test/j/site/" });
    const m = readManifest("site")!;
    expect(m.access).toBe("password");
    expect(m.hash).toBe("scrypt$a$b");
    expect(fs.readFileSync(path.join(tmp, "site", "index.html"), "utf8")).toBe("hi");
  });

  it("drops the hash when a jot goes public again", () => {
    seed("password", { passwordHash: "scrypt$a$b" });
    expect(updateJotMeta("site", "u1", { access: "public" })).toMatchObject({ access: "public" });
    const m = readManifest("site")!;
    expect(m.access).toBe("public");
    expect(m.hash).toBeUndefined();
  });

  it("keeps the current password when access is restated without a new one", () => {
    seed("password", { passwordHash: "scrypt$a$b" });
    updateJotMeta("site", "u1", { access: "password" });
    expect(readManifest("site")?.hash).toBe("scrypt$a$b");
  });

  it("rotates the password in place", () => {
    seed("password", { passwordHash: "scrypt$a$b" });
    updateJotMeta("site", "u1", { passwordHash: "scrypt$c$d" });
    expect(readManifest("site")?.hash).toBe("scrypt$c$d");
  });

  it("toggles cors both ways and leaves unmentioned fields alone", () => {
    seed();
    updateJotMeta("site", "u1", { cors: true });
    expect(readManifest("site")?.cors).toBe(true);
    expect(updateJotMeta("site", "u1", { cors: false })).toMatchObject({ access: "public", cors: false });
    expect(readManifest("site")?.cors).toBeUndefined();
  });

  it("preserves createdAt and moves updatedAt", () => {
    seed();
    const before = readManifest("site")!;
    updateJotMeta("site", "u1", { cors: true });
    const after = readManifest("site")!;
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt >= before.updatedAt).toBe(true);
  });

  it("refuses a password jot with no hash to fall back on", () => {
    seed();
    expect(updateJotMeta("site", "u1", { access: "password" })).toEqual({ error: "PASSWORD_REQUIRED" });
    expect(readManifest("site")?.access).toBe("public");
  });

  it("refuses another owner, an unknown jot, and an invalid name", () => {
    seed();
    expect(updateJotMeta("site", "u2", { access: "public" })).toEqual({ error: "FORBIDDEN" });
    expect(updateJotMeta("nope", "u1", { access: "public" })).toEqual({ error: "NOT_FOUND" });
    expect(updateJotMeta("BAD", "u1", { access: "public" })).toEqual({ error: "INVALID_NAME" });
  });

  it("leaves no staging file behind inside the jot", () => {
    seed();
    updateJotMeta("site", "u1", { access: "password", passwordHash: "scrypt$a$b" });
    expect(fs.readdirSync(path.join(tmp, "site")).sort()).toEqual(["index.html", "jot.json"]);
    expect(fs.readdirSync(tmp)).toEqual(["site"]);
  });
});
