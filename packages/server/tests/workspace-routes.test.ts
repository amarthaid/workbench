import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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
    SERVER_PUBLIC_URL: "http://localhost:3000",
    NODE_ENV: "test",
  },
}));

vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) => {
    const auth = headers.authorization;
    if (auth === "Bearer u1-token") return "u1";
    if (auth === "Bearer u2-token") return "u2";
    return null;
  }),
}));

import { registerWorkspaceRoutes } from "../src/workspace/routes";
import { writeFileBytes } from "../src/workspace/store";

const U1 = { authorization: "Bearer u1-token" };
const U2 = { authorization: "Bearer u2-token" };

let app: FastifyInstance;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-routes-"));
  app = Fastify();
  await registerWorkspaceRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("workspace routes", () => {
  it("refuses an unauthenticated request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/files" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("lists only the caller's files, with the quota", async () => {
    await writeFileBytes("u1", "mine.csv", Buffer.from("a,b"));
    await writeFileBytes("u2", "theirs.csv", Buffer.from("c,d"));

    const res = await app.inject({ method: "GET", url: "/api/files", headers: U1 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files.map((f: any) => f.name)).toEqual(["mine.csv"]);
    expect(body.quotaBytes).toBe(2500);
    expect(body.ttlHours).toBe(24);
  });

  it("streams a file out with forced-attachment headers", async () => {
    await writeFileBytes("u1", "statement.csv", Buffer.from("a,b\n1,2\n"));
    const res = await app.inject({ method: "GET", url: "/api/files/statement.csv", headers: U1 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("a,b\n1,2\n");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="statement.csv"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves an uploaded .html as an octet-stream attachment, never inline", async () => {
    // The portal SPA shares this origin and holds a bearer client-side, so an
    // inline text/html response here would be stored XSS against it.
    await writeFileBytes("u1", "evil.html", Buffer.from("<script>alert(1)</script>"));
    const res = await app.inject({ method: "GET", url: "/api/files/evil.html", headers: U1 });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-security-policy"]).toBe("sandbox");
  });

  it("does not let one user read another's file", async () => {
    await writeFileBytes("u2", "secret.csv", Buffer.from("x"));
    const res = await app.inject({ method: "GET", url: "/api/files/secret.csv", headers: U1 });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a traversal name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/files/..%2F..%2Fetc%2Fpasswd",
      headers: U1,
    });
    expect([400, 404]).toContain(res.statusCode);
  });

  it("uploads a raw body and reads it back", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/files/upload.csv",
      headers: { ...U1, "content-type": "application/octet-stream" },
      payload: Buffer.from("x,y\n3,4\n"),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().bytes).toBe(8);

    const back = await app.inject({ method: "GET", url: "/api/files/upload.csv", headers: U1 });
    expect(back.body).toBe("x,y\n3,4\n");
  });

  it("stores a form-urlencoded upload byte-for-byte when an app-level parser owns that type", async () => {
    // Boot order in app.ts: registerOAuthRoutes registers an exact-match
    // application/x-www-form-urlencoded parser on the app before the workspace
    // scope adds its "*" catch-all, and Fastify's exact match beats the catch-all.
    // The body then arrived as a parsed object, the route streamed nothing and
    // committed a 0-byte file with a 201. curl --data-binary sends this type by
    // default, so the loss was silent and common.
    const strict = Fastify();
    strict.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string)))
    );
    await registerWorkspaceRoutes(strict);
    await strict.ready();
    try {
      const payload = Buffer.from("twenty-one bytes here\n");
      const res = await strict.inject({
        method: "POST",
        url: "/api/files/form.txt",
        headers: { ...U1, "content-type": "application/x-www-form-urlencoded" },
        payload,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().bytes).toBe(payload.length);

      const back = await strict.inject({ method: "GET", url: "/api/files/form.txt", headers: U1 });
      expect(back.body).toBe(payload.toString());
    } finally {
      await strict.close();
    }
  });

  it("refuses an upload over the per-file cap and leaves nothing behind", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/files/big.bin",
      headers: { ...U1, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(1200),
    });
    expect(res.statusCode).toBe(413);

    const listed = await app.inject({ method: "GET", url: "/api/files", headers: U1 });
    expect(listed.json().files).toEqual([]);
  });

  it("deletes a file and then 404s", async () => {
    await writeFileBytes("u1", "gone.csv", Buffer.from("x"));
    const del = await app.inject({ method: "DELETE", url: "/api/files/gone.csv", headers: U1 });
    expect(del.statusCode).toBe(200);
    const again = await app.inject({ method: "DELETE", url: "/api/files/gone.csv", headers: U1 });
    expect(again.statusCode).toBe(404);
  });

  it("cannot delete another user's file", async () => {
    await writeFileBytes("u2", "theirs.csv", Buffer.from("x"));
    const res = await app.inject({ method: "DELETE", url: "/api/files/theirs.csv", headers: U2 });
    expect(res.statusCode).toBe(200);
  });

  it("sanitizes a filename that would break the disposition header", async () => {
    await writeFileBytes("u1", 'we"ird.csv', Buffer.from("x"));
    const res = await app.inject({
      method: "GET",
      url: `/api/files/${encodeURIComponent('we"ird.csv')}`,
      headers: U1,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="we_ird.csv"');
  });
});
