import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { FastifyInstance } from "fastify";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";

let tmp: string;

vi.mock("../../src/jots/dir", () => ({ jotsRoot: () => tmp }));
vi.mock("../../src/config", () => ({
  config: { JOTS_MAX_BYTES: 1_000_000, JOTS_MAX_FILES: 1000, JOTS_UPLOAD_TTL_SECONDS: 300, SERVER_PUBLIC_URL: "https://wb.test", SESSION_SECRET: "test-secret-32-chars-long-xxxxxx", NODE_ENV: "test" },
}));

import { registerJotRoutes } from "../../src/jots/routes";
import { deployJot, readManifest, updateJotMeta } from "../../src/jots/store";
import { hashPassword, makeToken, cookieName } from "../../src/jots/auth";
import { mint } from "../../src/jots/pending";

let app: FastifyInstance;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jots-routes-"));
  app = Fastify();
  await registerJotRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("jots/routes", () => {
  it("serves a public jot", async () => {
    deployJot({ name: "pub", owner: "u1", access: "public", files: [{ path: "index.html", content: "<h1>hi</h1>" }] });
    const res = await app.inject({ method: "GET", url: "/j/pub/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("hi");
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("404s an unknown jot and an invalid name", async () => {
    expect((await app.inject({ method: "GET", url: "/j/nope/" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/j/Bad/" })).statusCode).toBe(404);
  });

  it("never serves the manifest", async () => {
    deployJot({ name: "pub", owner: "u1", access: "public", files: [{ path: "index.html", content: "x" }] });
    expect((await app.inject({ method: "GET", url: "/j/pub/jot.json" })).statusCode).toBe(404);
  });

  it("blocks traversal", async () => {
    deployJot({ name: "pub", owner: "u1", access: "public", files: [{ path: "index.html", content: "x" }] });
    const res = await app.inject({ method: "GET", url: "/j/pub/..%2f..%2fetc%2fpasswd" });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("shows the unlock page for an HTML request to a password jot", async () => {
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("pw"), files: [{ path: "index.html", content: "secret" }] });
    const res = await app.inject({ method: "GET", url: "/j/sec/", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Unlock");
    expect(res.body).not.toContain("secret");
  });

  it("401s a non-HTML request to a locked password jot", async () => {
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("pw"), files: [{ path: "data.json", content: "{}" }] });
    const res = await app.inject({ method: "GET", url: "/j/sec/data.json", headers: { accept: "application/json" } });
    expect(res.statusCode).toBe(401);
  });

  it("unlocks with the right password and sets a scoped cookie", async () => {
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("pw"), files: [{ path: "index.html", content: "secret" }] });
    const bad = await app.inject({ method: "POST", url: "/j/sec/__auth", payload: "password=nope", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/j/sec/__auth", payload: "password=pw", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(ok.statusCode).toBe(302);
    const setCookie = String(ok.headers["set-cookie"]);
    expect(setCookie).toContain("jot_sec=");
    expect(setCookie).toContain("Path=/j/sec/");
  });

  it("serves a password jot when a valid cookie is present", async () => {
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("pw"), files: [{ path: "index.html", content: "secret" }] });
    const hash = readManifest("sec")!.hash!;
    const token = makeToken("test-secret-32-chars-long-xxxxxx", "sec", hash);
    const res = await app.inject({ method: "GET", url: "/j/sec/", headers: { cookie: `${cookieName("sec")}=${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("secret");
  });

  it("rejects a cookie minted for a different jot", async () => {
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("pw"), files: [{ path: "index.html", content: "secret" }] });
    const hash = readManifest("sec")!.hash!;
    const wrong = makeToken("test-secret-32-chars-long-xxxxxx", "other", hash);
    const res = await app.inject({ method: "GET", url: "/j/sec/", headers: { accept: "application/json", cookie: `jot_sec=${wrong}` } });
    expect(res.statusCode).toBe(401);
  });

  it("invalidates an unlock cookie after the jot password is rotated", async () => {
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("old"), files: [{ path: "index.html", content: "secret" }] });
    const oldHash = readManifest("sec")!.hash!;
    const token = makeToken("test-secret-32-chars-long-xxxxxx", "sec", oldHash);
    // Cookie works under the original password.
    let res = await app.inject({ method: "GET", url: "/j/sec/", headers: { cookie: `${cookieName("sec")}=${token}` } });
    expect(res.statusCode).toBe(200);
    // Owner re-deploys with a new password → old cookie must stop working.
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("new"), files: [{ path: "index.html", content: "secret" }] });
    res = await app.inject({ method: "GET", url: "/j/sec/", headers: { accept: "application/json", cookie: `${cookieName("sec")}=${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it("keeps two password jots independently authorized in one session", async () => {
    deployJot({ name: "alpha", owner: "u1", access: "password", passwordHash: hashPassword("a"), files: [{ path: "index.html", content: "ALPHA" }] });
    deployJot({ name: "beta", owner: "u1", access: "password", passwordHash: hashPassword("b"), files: [{ path: "index.html", content: "BETA" }] });
    const tAlpha = makeToken("test-secret-32-chars-long-xxxxxx", "alpha", readManifest("alpha")!.hash!);
    // Both cookies present (same browser). Each is Path-scoped + name+hash bound.
    const bothCookies = `${cookieName("alpha")}=${tAlpha}`;
    // alpha authorized.
    const a = await app.inject({ method: "GET", url: "/j/alpha/", headers: { cookie: bothCookies } });
    expect(a.statusCode).toBe(200);
    expect(a.body).toContain("ALPHA");
    // beta still locked — alpha's cookie does nothing for beta.
    const b = await app.inject({ method: "GET", url: "/j/beta/", headers: { accept: "application/json", cookie: bothCookies } });
    expect(b.statusCode).toBe(401);
  });

  it("redirects /j/:name to /j/:name/", async () => {
    deployJot({ name: "pub", owner: "u1", access: "public", files: [{ path: "index.html", content: "x" }] });
    const res = await app.inject({ method: "GET", url: "/j/pub" });
    expect(res.statusCode).toBe(301);
    expect(res.headers["location"]).toBe("/j/pub/");
  });

  it("sets sandbox CSP + hardening headers on served jots", async () => {
    deployJot({ name: "pub", owner: "u1", access: "public", files: [{ path: "index.html", content: "<h1>hi</h1>" }] });
    const res = await app.inject({ method: "GET", url: "/j/pub/" });
    expect(res.headers["content-security-policy"]).toBe("sandbox allow-scripts allow-forms");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("sets sandbox CSP on the unlock page too", async () => {
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("pw"), files: [{ path: "index.html", content: "secret" }] });
    const res = await app.inject({ method: "GET", url: "/j/sec/", headers: { accept: "text/html" } });
    expect(res.headers["content-security-policy"]).toContain("sandbox");
  });

  it("does not throw when a urlencoded parser is already registered (boot order)", async () => {
    const a = Fastify();
    a.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, b, d) => d(null, b));
    await expect(registerJotRoutes(a)).resolves.not.toThrow();
    await a.close();
  });

  it("unlocks when an OAuth-style object body parser won registration (boot order)", async () => {
    // Mirror the real boot order: the OAuth route group registers a urlencoded
    // parser that yields an OBJECT, so the jot string parser is skipped and
    // __auth sees req.body as an object — password jots must still unlock.
    const a = Fastify();
    a.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_r, b, d) => d(null, Object.fromEntries(new URLSearchParams(b as string)))
    );
    await registerJotRoutes(a);
    await a.ready();
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("pw"), files: [{ path: "index.html", content: "secret" }] });
    const bad = await a.inject({ method: "POST", url: "/j/sec/__auth", payload: "password=nope", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(bad.statusCode).toBe(401);
    const ok = await a.inject({ method: "POST", url: "/j/sec/__auth", payload: "password=pw", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(ok.statusCode).toBe(302);
    expect(String(ok.headers["set-cookie"])).toContain("jot_sec=");
    await a.close();
  });
});

function tarGz(files: { name: string; content: string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarPack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    gzip.on("data", (c: Buffer) => chunks.push(c));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    pack.pipe(gzip);
    (function next(i: number) {
      if (i >= files.length) { pack.finalize(); return; }
      pack.entry({ name: files[i].name }, files[i].content, () => next(i + 1));
    })(0);
  });
}

describe("jots/routes upload", () => {
  it("publishes an uploaded tarball and then serves it", async () => {
    const { token } = mint({ owner: "u1", name: "uploaded", access: "public" });
    const body = await tarGz([{ name: "index.html", content: "<h1>UP</h1>" }]);
    const up = await app.inject({
      method: "POST",
      url: `/j/upload/${token}`,
      payload: body,
      headers: { "content-type": "application/gzip" },
    });
    expect(up.statusCode).toBe(200);
    expect(JSON.parse(up.body)).toMatchObject({ name: "uploaded", access: "public" });
    const served = await app.inject({ method: "GET", url: "/j/uploaded/" });
    expect(served.statusCode).toBe(200);
    expect(served.body).toContain("UP");
  });

  it("404s an unknown or already-used token", async () => {
    const { token } = mint({ owner: "u1", name: "once", access: "public" });
    const body = await tarGz([{ name: "index.html", content: "x" }]);
    const first = await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: { "content-type": "application/gzip" } });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: { "content-type": "application/gzip" } });
    expect(replay.statusCode).toBe(404);
    const unknown = await app.inject({ method: "POST", url: "/j/upload/deadbeef", payload: body, headers: { "content-type": "application/gzip" } });
    expect(unknown.statusCode).toBe(404);
  });

  it("400s a traversal entry in the tarball", async () => {
    const { token } = mint({ owner: "u1", name: "evil", access: "public" });
    const body = await tarGz([{ name: "../escape", content: "x" }]);
    const res = await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: { "content-type": "application/gzip" } });
    expect(res.statusCode).toBe(400);
  });

  it("413s an oversized archive", async () => {
    const { token } = mint({ owner: "u1", name: "toobig", access: "public" });
    const body = await tarGz([{ name: "big.bin", content: "x".repeat(1_000_001) }]);
    const res = await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: { "content-type": "application/gzip" } });
    expect(res.statusCode).toBe(413);
  });

  it("publishes a password jot via upload (locked until unlocked)", async () => {
    const { token } = mint({ owner: "u1", name: "locked", access: "password", passwordHash: hashPassword("pw") });
    const body = await tarGz([{ name: "index.html", content: "<h1>SECRET</h1>" }]);
    const up = await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: { "content-type": "application/gzip" } });
    expect(up.statusCode).toBe(200);
    // No cookie → locked (non-HTML request gets 401).
    const locked = await app.inject({ method: "GET", url: "/j/locked/", headers: { accept: "application/json" } });
    expect(locked.statusCode).toBe(401);
  });

  it("400s an upload with no root index.html", async () => {
    const { token } = mint({ owner: "u1", name: "noindex", access: "public" });
    const body = await tarGz([{ name: "about.html", content: "x" }]);
    const res = await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: { "content-type": "application/gzip" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "NO_INDEX" });
    // nothing was published
    expect((await app.inject({ method: "GET", url: "/j/noindex/" })).statusCode).toBe(404);
  });
});

describe("jots/routes patch upload", () => {
  const gz = { "content-type": "application/gzip" };

  const seed = (name: string, extra: { path: string; content: string }[] = []) =>
    deployJot({
      name, owner: "u1", access: "public",
      files: [{ path: "index.html", content: "<h1>site</h1>" }, { path: "data.json", content: '{"v":1}' }, ...extra],
    });

  it("overlays uploaded files and leaves the rest of the tree alone", async () => {
    seed("site");
    const { token } = mint({ owner: "u1", name: "site", mode: "patch" });
    const body = await tarGz([{ name: "data.json", content: '{"v":2}' }]);
    const up = await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz });
    expect(up.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/j/site/data.json" })).body).toBe('{"v":2}');
    expect((await app.inject({ method: "GET", url: "/j/site/" })).body).toContain("site");
  });

  it("accepts a patch whose archive has no index.html", async () => {
    seed("site");
    const { token } = mint({ owner: "u1", name: "site", mode: "patch" });
    const body = await tarGz([{ name: "data.json", content: "{}" }]);
    expect((await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz })).statusCode).toBe(200);
  });

  it("applies the delete list", async () => {
    seed("site", [{ path: "stale/old.txt", content: "x" }]);
    const { token } = mint({ owner: "u1", name: "site", mode: "patch", deletes: ["stale"] });
    const body = await tarGz([{ name: "data.json", content: "{}" }]);
    await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz });
    expect((await app.inject({ method: "GET", url: "/j/site/stale/old.txt" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/j/site/" })).statusCode).toBe(200);
  });

  it("lets an uploaded path win over a delete of the same path", async () => {
    seed("site");
    const { token } = mint({ owner: "u1", name: "site", mode: "patch", deletes: ["data.json"] });
    const body = await tarGz([{ name: "data.json", content: "kept" }]);
    await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz });
    expect((await app.inject({ method: "GET", url: "/j/site/data.json" })).body).toBe("kept");
  });

  it("404s a patch for a jot that no longer exists", async () => {
    const { token } = mint({ owner: "u1", name: "gone", mode: "patch" });
    const body = await tarGz([{ name: "data.json", content: "{}" }]);
    expect((await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz })).statusCode).toBe(404);
  });

  it("403s a patch by a user who does not own the jot", async () => {
    seed("site");
    const { token } = mint({ owner: "u2", name: "site", mode: "patch" });
    const body = await tarGz([{ name: "data.json", content: "{}" }]);
    expect((await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz })).statusCode).toBe(403);
  });

  it("keeps the jot password-gated across a patch", async () => {
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("pw"), files: [{ path: "index.html", content: "secret" }] });
    const { token } = mint({ owner: "u1", name: "sec", mode: "patch" });
    const body = await tarGz([{ name: "data.json", content: "{}" }]);
    await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz });
    expect(readManifest("sec")?.access).toBe("password");
    expect((await app.inject({ method: "GET", url: "/j/sec/data.json", headers: { accept: "application/json" } })).statusCode).toBe(401);
  });

  it("rejects a merged tree over the byte cap", async () => {
    deployJot({ name: "site", owner: "u1", access: "public", files: [{ path: "index.html", content: "x".repeat(600_000) }] });
    const { token } = mint({ owner: "u1", name: "site", mode: "patch" });
    const body = await tarGz([{ name: "big.bin", content: "y".repeat(600_000) }]);
    const res = await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "TOO_LARGE" });
    // the live jot is untouched
    expect((await app.inject({ method: "GET", url: "/j/site/big.bin" })).statusCode).toBe(404);
  });

  it("rejects a merged tree over the file-count cap", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
    deployJot({ name: "site", owner: "u1", access: "public", files: [{ path: "index.html", content: "x" }, ...many] });
    const { token } = mint({ owner: "u1", name: "site", mode: "patch" });
    const body = await tarGz([{ name: "one-more.txt", content: "x" }]);
    const res = await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "TOO_MANY_FILES" });
  });

  it("carries the cors flag from a patch token onto the manifest", async () => {
    seed("site");
    const { token } = mint({ owner: "u1", name: "site", mode: "patch", cors: true });
    const body = await tarGz([{ name: "data.json", content: "{}" }]);
    await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz });
    expect(readManifest("site")?.cors).toBe(true);
  });

  it("preserves an existing cors flag when the patch does not mention it", async () => {
    deployJot({ name: "site", owner: "u1", access: "public", cors: true, files: [{ path: "index.html", content: "x" }] });
    const { token } = mint({ owner: "u1", name: "site", mode: "patch" });
    const body = await tarGz([{ name: "data.json", content: "{}" }]);
    await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz });
    expect(readManifest("site")?.cors).toBe(true);
  });
});

describe("jots/routes settings change without an upload", () => {
  const gz = { "content-type": "application/gzip" };

  it("gates a live public jot as soon as the manifest changes", async () => {
    deployJot({ name: "site", owner: "u1", access: "public", files: [{ path: "index.html", content: "hi" }] });
    expect((await app.inject({ method: "GET", url: "/j/site/" })).statusCode).toBe(200);
    updateJotMeta("site", "u1", { access: "password", passwordHash: hashPassword("pw") });
    const res = await app.inject({ method: "GET", url: "/j/site/", headers: { accept: "application/json" } });
    expect(res.statusCode).toBe(401);
  });

  it("unlocks a gated jot again, and the old cookie is moot", async () => {
    const hash = hashPassword("pw");
    deployJot({ name: "site", owner: "u1", access: "password", passwordHash: hash, files: [{ path: "index.html", content: "hi" }] });
    updateJotMeta("site", "u1", { access: "public" });
    expect((await app.inject({ method: "GET", url: "/j/site/" })).statusCode).toBe(200);
    expect(readManifest("site")?.hash).toBeUndefined();
  });

  it("invalidates an issued unlock cookie when the password is rotated", async () => {
    const oldHash = hashPassword("old");
    deployJot({ name: "site", owner: "u1", access: "password", passwordHash: oldHash, files: [{ path: "index.html", content: "hi" }] });
    const cookie = `${cookieName("site")}=${makeToken("test-secret-32-chars-long-xxxxxx", "site", oldHash)}`;
    expect((await app.inject({ method: "GET", url: "/j/site/", headers: { cookie } })).statusCode).toBe(200);
    updateJotMeta("site", "u1", { passwordHash: hashPassword("new") });
    const res = await app.inject({ method: "GET", url: "/j/site/", headers: { cookie, accept: "application/json" } });
    expect(res.statusCode).toBe(401);
  });

  it("keeps the new gating across a later patch upload", async () => {
    deployJot({ name: "site", owner: "u1", access: "public", files: [{ path: "index.html", content: "hi" }] });
    updateJotMeta("site", "u1", { access: "password", passwordHash: hashPassword("pw") });
    const { token } = mint({ owner: "u1", name: "site", mode: "patch" });
    const body = await tarGz([{ name: "data.json", content: "{}" }]);
    expect((await app.inject({ method: "POST", url: `/j/upload/${token}`, payload: body, headers: gz })).statusCode).toBe(200);
    const m = readManifest("site")!;
    expect(m.access).toBe("password");
    expect(m.hash).toBeTruthy();
  });
});

describe("jots/routes cors headers", () => {
  it("sends no cross-origin headers by default", async () => {
    deployJot({ name: "pub", owner: "u1", access: "public", files: [{ path: "data.json", content: "{}" }] });
    const res = await app.inject({ method: "GET", url: "/j/pub/data.json" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("allows cross-origin reads for a public jot with cors enabled", async () => {
    deployJot({ name: "pub", owner: "u1", access: "public", cors: true, files: [{ path: "data.json", content: "{}" }] });
    const res = await app.inject({ method: "GET", url: "/j/pub/data.json" });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    // the sandbox is not weakened by cors
    expect(res.headers["content-security-policy"]).toBe("sandbox allow-scripts allow-forms");
  });

  it("ignores cors on a password jot", async () => {
    deployJot({ name: "sec", owner: "u1", access: "password", passwordHash: hashPassword("pw"), cors: true, files: [{ path: "index.html", content: "x" }] });
    const hash = readManifest("sec")!.hash!;
    const token = makeToken("test-secret-32-chars-long-xxxxxx", "sec", hash);
    const res = await app.inject({ method: "GET", url: "/j/sec/", headers: { cookie: `${cookieName("sec")}=${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a preflight for a cors-enabled public jot", async () => {
    deployJot({ name: "pub", owner: "u1", access: "public", cors: true, files: [{ path: "data.json", content: "{}" }] });
    const res = await app.inject({ method: "OPTIONS", url: "/j/pub/data.json", headers: { origin: "https://other.test", "access-control-request-method": "GET" } });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(String(res.headers["access-control-allow-methods"])).toContain("GET");
  });

  it("does not answer a preflight for a jot without cors", async () => {
    deployJot({ name: "pub", owner: "u1", access: "public", files: [{ path: "data.json", content: "{}" }] });
    const res = await app.inject({ method: "OPTIONS", url: "/j/pub/data.json", headers: { origin: "https://other.test", "access-control-request-method": "GET" } });
    expect(res.statusCode).toBe(404);
  });
});
