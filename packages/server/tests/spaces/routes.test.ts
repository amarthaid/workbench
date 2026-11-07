import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

let tmp: string;
vi.mock("../../src/spaces/dir", () => ({ spacesRoot: () => tmp }));

import { config } from "../../src/config";
import { registerSpaceRoutes, spaceCsp } from "../../src/spaces/routes";
import { mint } from "../../src/spaces/pending";
import { mintSig, SIG_TTL_MS } from "../../src/spaces/sig";
import { getSpace, upsertSpace, deleteSpace } from "../../src/spaces/store";
import { SDK_SOURCE } from "../../src/spaces/sdk";
import { isServerOwnedSpacePath } from "../../src/portal";
import { resetSpacesDb, tarball, writeSpaceFiles } from "./helpers";

let app: FastifyInstance;
function cspFor(origins: string): string {
  return (
    "sandbox allow-scripts; default-src 'none'; " +
    `script-src 'self' ${origins} 'unsafe-inline' 'unsafe-eval'; ` +
    `style-src 'self' ${origins} 'unsafe-inline'; ` +
    `img-src 'self' ${origins} data: blob:; ` +
    `font-src 'self' ${origins} data:; ` +
    `media-src 'self' ${origins} data: blob:; ` +
    "connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; " +
    `frame-ancestors ${origins}`
  );
}

const saved = { server: config.SERVER_PUBLIC_URL, portal: config.PORTAL_URL };
// The default test layout: portal and server on different origins (dev).
const SPLIT = "https://wb.example.com https://portal.example.com";
const EXPECTED_CSP = cspFor(SPLIT);

beforeEach(async () => {
  config.SERVER_PUBLIC_URL = "https://wb.example.com/";
  config.PORTAL_URL = "https://portal.example.com";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spaces-routes-"));
  await resetSpacesDb();
  app = Fastify();
  await registerSpaceRoutes(app);
  await app.ready();
});
afterEach(async () => {
  config.SERVER_PUBLIC_URL = saved.server;
  config.PORTAL_URL = saved.portal;
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function upload(token: string, files: Array<{ name: string; content: string }>) {
  return app.inject({
    method: "POST",
    url: `/s/upload/${token}`,
    payload: await tarball(files),
    headers: { "content-type": "application/gzip" },
  });
}

async function seedSpace(name = "s1", owner = "u1") {
  await upsertSpace({ name, ownerId: owner, title: "T", tools: [], visibility: "org" });
}

describe("spaces/routes upload", () => {
  it("publishes a tarball, then a second use of the token 404s", async () => {
    await seedSpace();
    const before = (await getSpace("s1"))!.updatedAt;
    const { token } = await mint({ owner: "u1", name: "s1" });
    const res = await upload(token, [
      { name: "index.html", content: "<h1>hi</h1>" },
      { name: "app.js", content: "1" },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "s1", url: `${config.PORTAL_URL}/s/s1` });
    expect(fs.readFileSync(path.join(tmp, "s1", "index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect((await getSpace("s1"))!.updatedAt).toBeGreaterThanOrEqual(before);
    expect((await upload(token, [{ name: "index.html", content: "x" }])).statusCode).toBe(404);
  });

  it("requires a root index.html and keeps the live tree on failure", async () => {
    await seedSpace();
    writeSpaceFiles(tmp, "s1", { "index.html": "live" });
    const { token } = await mint({ owner: "u1", name: "s1" });
    const res = await upload(token, [{ name: "page.html", content: "x" }]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "NO_INDEX" });
    expect(fs.readFileSync(path.join(tmp, "s1", "index.html"), "utf8")).toBe("live");
  });

  it("rejects traversal in the archive", async () => {
    await seedSpace();
    const { token } = await mint({ owner: "u1", name: "s1" });
    const res = await upload(token, [{ name: "../escape.html", content: "x" }, { name: "index.html", content: "x" }]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_PATH" });
    expect(fs.existsSync(path.join(tmp, "escape.html"))).toBe(false);
  });

  it("413s an archive over JOTS_MAX_BYTES", async () => {
    await seedSpace();
    const prev = config.JOTS_MAX_BYTES;
    config.JOTS_MAX_BYTES = 10;
    try {
      const { token } = await mint({ owner: "u1", name: "s1" });
      const res = await upload(token, [{ name: "index.html", content: "x".repeat(100) }]);
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: "TOO_LARGE" });
    } finally {
      config.JOTS_MAX_BYTES = prev;
    }
  });

  it("patch overlays, applies deletes, and keeps unmentioned files", async () => {
    await seedSpace();
    writeSpaceFiles(tmp, "s1", { "index.html": "old", "keep.js": "k", "gone.js": "g" });
    const { token } = await mint({ owner: "u1", name: "s1", mode: "patch", deletes: ["gone.js"] });
    const res = await upload(token, [{ name: "index.html", content: "new" }]);
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(tmp, "s1", "index.html"), "utf8")).toBe("new");
    expect(fs.existsSync(path.join(tmp, "s1", "keep.js"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "s1", "gone.js"))).toBe(false);
  });

  it("404s when the Space was deleted after mint, 403s when it changed owner", async () => {
    await seedSpace();
    const a = await mint({ owner: "u1", name: "s1" });
    await deleteSpace("s1");
    expect((await upload(a.token, [{ name: "index.html", content: "x" }])).statusCode).toBe(404);
    await seedSpace("s1", "u2");
    const b = await mint({ owner: "u1", name: "s1" });
    expect((await upload(b.token, [{ name: "index.html", content: "x" }])).statusCode).toBe(403);
  });
});

describe("spaces/routes app files", () => {
  beforeEach(async () => {
    await seedSpace();
    writeSpaceFiles(tmp, "s1", { "index.html": "<p>space</p>", "js/app.js": "run()", "sub/index.html": "sub" });
  });

  it("serves with a valid sig and the exact headers", async () => {
    const sig = mintSig("s1", "u1");
    const res = await app.inject({ method: "GET", url: `/s/s1/app/${sig}/` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<p>space</p>");
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["content-security-policy"]).toBe(EXPECTED_CSP);
    expect(spaceCsp()).toBe(EXPECTED_CSP);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("private, no-store");

    const js = await app.inject({ method: "GET", url: `/s/s1/app/${sig}/js/app.js` });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["content-security-policy"]).toBe(EXPECTED_CSP);

    const dir = await app.inject({ method: "GET", url: `/s/s1/app/${sig}/sub/` });
    expect(dir.body).toBe("sub");
  });

  it("the CSP lists the server and portal origins, once each", async () => {
    expect(spaceCsp()).toBe(cspFor(SPLIT));
    config.PORTAL_URL = "https://wb.example.com";
    expect(spaceCsp()).toBe(cspFor("https://wb.example.com"));
    const res = await app.inject({ method: "GET", url: `/s/s1/app/${mintSig("s1", "u1")}/` });
    expect(res.headers["content-security-policy"]).toBe(cspFor("https://wb.example.com"));
  });

  it("serves a sig for a user id far past find-my-way's 100-char param cap", async () => {
    const sig = mintSig("s1", "x".repeat(300));
    expect(sig.length).toBeGreaterThan(100);
    const res = await app.inject({ method: "GET", url: `/s/s1/app/${sig}/` });
    expect(res.statusCode).toBe(200);
  });

  it("404s a sig with no trailing path segment", async () => {
    expect((await app.inject({ method: "GET", url: `/s/s1/app/${mintSig("s1", "u1")}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/s/s1/app/" })).statusCode).toBe(404);
  });

  it("404s a bad, expired, other-Space or other-user sig", async () => {
    const good = mintSig("s1", "u1");
    const expired = mintSig("s1", "u1", Date.now() - SIG_TTL_MS - 1000);
    const otherSpace = mintSig("s2", "u1");
    const [e, , m] = good.split(".");
    const otherUser = [e, Buffer.from("u2").toString("base64url"), m].join(".");
    for (const sig of ["nope", expired, otherSpace, otherUser]) {
      const res = await app.inject({ method: "GET", url: `/s/s1/app/${sig}/` });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("space");
    }
  });

  it("a sig minted for another viewer still serves only that Space's files", async () => {
    // The sig is a capability for files, not data: any valid viewer sig works.
    const res = await app.inject({ method: "GET", url: `/s/s1/app/${mintSig("s1", "u2")}/` });
    expect(res.statusCode).toBe(200);
  });

  it("blocks traversal out of the Space directory", async () => {
    writeSpaceFiles(tmp, "secret", { "index.html": "secret" });
    const sig = mintSig("s1", "u1");
    for (const p of ["..%2fsecret%2findex.html", "%2e%2e/secret/index.html", "../secret/index.html"]) {
      const res = await app.inject({ method: "GET", url: `/s/s1/app/${sig}/${p}` });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("secret");
    }
  });

  it("404s a Space with no upload yet, and an unknown file", async () => {
    await seedSpace("empty");
    expect((await app.inject({ method: "GET", url: `/s/empty/app/${mintSig("empty", "u1")}/` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/s/s1/app/${mintSig("s1", "u1")}/missing.js` })).statusCode).toBe(404);
  });
});

describe("spaces/routes SDK and route ownership", () => {
  it("serves the SDK with the strict headers and a long cache", async () => {
    const res = await app.inject({ method: "GET", url: "/s/_sdk/workbench.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SDK_SOURCE);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers["content-security-policy"]).toBe(EXPECTED_CSP);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toMatch(/max-age=\d{4,}/);
  });

  it("registers nothing for /s/:name or /s/:name/ (the SPA owns them)", async () => {
    await seedSpace();
    writeSpaceFiles(tmp, "s1", { "index.html": "x" });
    expect((await app.inject({ method: "GET", url: "/s/s1" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/s/s1/" })).statusCode).toBe(404);
  });

  it("the portal fallback leaves /s/<name> to the SPA and keeps server paths non-HTML", () => {
    expect(isServerOwnedSpacePath("/s/pr-timeline")).toBe(false);
    expect(isServerOwnedSpacePath("/s/pr-timeline/")).toBe(false);
    expect(isServerOwnedSpacePath("/s/_sdk/missing.js")).toBe(true);
    expect(isServerOwnedSpacePath("/s/upload/abc")).toBe(true);
    expect(isServerOwnedSpacePath("/s/pr-timeline/app/sig/x.js")).toBe(true);
    expect(isServerOwnedSpacePath("/s/pr-timeline/app")).toBe(true);
    expect(isServerOwnedSpacePath("/spaces")).toBe(false);
  });
});
