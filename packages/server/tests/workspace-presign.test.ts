import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

vi.mock("../src/workspace/dir", () => ({ workspaceRoot: () => tmp }));

vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) =>
    headers.authorization === "Bearer u1-token" ? "u1" : null
  ),
}));

import { registerWorkspaceRoutes } from "../src/workspace/routes";
import { writeFileBytes, listFiles } from "../src/workspace/store";
import {
  mintPresign,
  peekDownload,
  consumeUpload,
  reapExpiredPresigns,
  revokeFor,
  _setNowForTest,
} from "../src/workspace/presign";
import { mint as mintJotUpload, consume as consumeJotUpload } from "../src/jots/pending";
import { db } from "../src/db";

const U1 = { authorization: "Bearer u1-token" };
const RAW = { "content-type": "application/octet-stream" };

let app: FastifyInstance;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-presign-"));
  _setNowForTest(() => Date.now());
  await db.run("DELETE FROM pending_auth");
  app = Fastify();
  await registerWorkspaceRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  _setNowForTest(() => Date.now());
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("workspace presign", () => {
  it("lets a download token be spent more than once inside its TTL", async () => {
    await writeFileBytes("u1", "a.csv", Buffer.from("a,b"));
    const { token } = await mintPresign("u1", "a.csv", "download");

    // A fetch gets retried, and some clients HEAD before GET.
    const first = await app.inject({ method: "GET", url: `/api/files/dl/${token}` });
    const second = await app.inject({ method: "GET", url: `/api/files/dl/${token}` });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe("a,b");
  });

  it("refuses a download token past its TTL", async () => {
    await writeFileBytes("u1", "a.csv", Buffer.from("a,b"));
    const { token } = await mintPresign("u1", "a.csv", "download", 60);

    _setNowForTest(() => Date.now() + 61_000);
    expect(await peekDownload(token)).toBeNull();
    const res = await app.inject({ method: "GET", url: `/api/files/dl/${token}` });
    expect(res.statusCode).toBe(404);
  });

  it("spends an upload token exactly once", async () => {
    const { token } = await mintPresign("u1", "up.csv", "upload");

    const first = await app.inject({
      method: "PUT",
      url: `/api/files/ul/${token}`,
      headers: RAW,
      payload: Buffer.from("x,y"),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "PUT",
      url: `/api/files/ul/${token}`,
      headers: RAW,
      payload: Buffer.from("z,z"),
    });
    expect(second.statusCode).toBe(404);
  });

  it("gives exactly one winner when two redemptions race", async () => {
    const { token } = await mintPresign("u1", "race.csv", "upload");
    // The DELETE arbitrates, not the SELECT: both read the row, the database
    // serialises the deletes, one reports changes === 1.
    const results = await Promise.all([consumeUpload(token), consumeUpload(token)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("writes to the name in the row and ignores one supplied at redeem", async () => {
    const { token } = await mintPresign("u1", "intended.csv", "upload");
    const res = await app.inject({
      method: "PUT",
      url: `/api/files/ul/${token}?name=attacker.csv`,
      headers: RAW,
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(201);

    const names = (await listFiles("u1")).map((f) => f.name);
    expect(names).toEqual(["intended.csv"]);
  });

  it("refuses a download grant whose file was deleted and revoked", async () => {
    await writeFileBytes("u1", "doomed.csv", Buffer.from("x"));
    const { token } = await mintPresign("u1", "doomed.csv", "download");

    const del = await app.inject({ method: "DELETE", url: "/api/files/doomed.csv", headers: U1 });
    expect(del.statusCode).toBe(200);

    expect(await peekDownload(token)).toBeNull();
    const res = await app.inject({ method: "GET", url: `/api/files/dl/${token}` });
    expect(res.statusCode).toBe(404);
  });

  it("aborts a presigned upload over the per-file cap and leaves nothing", async () => {
    const { token } = await mintPresign("u1", "big.bin", "upload");
    const res = await app.inject({
      method: "PUT",
      url: `/api/files/ul/${token}`,
      headers: RAW,
      payload: Buffer.alloc(200 * 1024 * 1024),
    });
    expect(res.statusCode).toBe(413);
    expect(await listFiles("u1")).toEqual([]);
    expect(fs.readdirSync(path.join(tmp, fs.readdirSync(tmp)[0]))).toEqual([]);
  });

  it("serves a presigned download with the same forced-attachment headers", async () => {
    await writeFileBytes("u1", "evil.html", Buffer.from("<script>alert(1)</script>"));
    const { token } = await mintPresign("u1", "evil.html", "download");
    const res = await app.inject({ method: "GET", url: `/api/files/dl/${token}` });
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does not collide with a file literally named dl", async () => {
    await writeFileBytes("u1", "dl", Buffer.from("plain file"));
    const res = await app.inject({ method: "GET", url: "/api/files/dl", headers: U1 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("plain file");
  });

  it("keeps the sentinels apart from the jot upload flow", async () => {
    const { token: fileToken } = await mintPresign("u1", "a.csv", "upload");
    const { token: jotToken } = await mintJotUpload({ owner: "u1", name: "site", access: "public" });

    // Neither flow can see or spend the other's row.
    expect(await consumeJotUpload(fileToken)).toBeNull();
    expect(await consumeUpload(jotToken)).toBeNull();
    expect(await peekDownload(jotToken)).toBeNull();

    // And each still works for its own token.
    expect(await consumeUpload(fileToken)).toMatchObject({ userId: "u1", name: "a.csv" });
  });

  it("reaps only its own expired rows", async () => {
    await mintPresign("u1", "a.csv", "download", 60);
    await mintJotUpload({ owner: "u1", name: "site", access: "public" });

    _setNowForTest(() => Date.now() + 10 * 60_000);
    await reapExpiredPresigns();

    const rows = await db.all<{ integration: string }>(
      "SELECT integration FROM pending_auth WHERE user_id = ?",
      ["u1"]
    );
    expect(rows.map((r) => r.integration)).toEqual(["__jot_upload__"]);
  });

  it("revokes both directions for one name", async () => {
    const dl = await mintPresign("u1", "x.csv", "download");
    const ul = await mintPresign("u1", "x.csv", "upload");
    const other = await mintPresign("u1", "y.csv", "download");

    await revokeFor("u1", "x.csv");

    expect(await peekDownload(dl.token)).toBeNull();
    expect(await consumeUpload(ul.token)).toBeNull();
    expect(await peekDownload(other.token)).not.toBeNull();
  });
});
