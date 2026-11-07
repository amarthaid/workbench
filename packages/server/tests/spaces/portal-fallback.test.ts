import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

// The real boot order: Space routes first, the portal (static + SPA fallback)
// last. /s/<name> must reach the SPA; misses on the server-owned /s/ paths must
// not come back as index.html.
const { DIST } = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  return { DIST: fs.mkdtempSync(path.join(os.tmpdir(), "spaces-portal-dist-")) };
});

vi.mock("../../src/config", () => ({
  config: {
    PORTAL_DIST_DIR: DIST,
    NODE_ENV: "test",
    SERVER_PUBLIC_URL: "https://wb.example.com",
    PORTAL_URL: "https://wb.example.com",
    SESSION_SECRET: "test-secret-32-chars-long-xxxxxx",
    DATABASE_URL: process.env.DATABASE_URL,
    JOTS_MAX_BYTES: 1_000_000,
    JOTS_MAX_FILES: 1000,
    JOTS_UPLOAD_TTL_SECONDS: 300,
  },
}));

import { registerSpaceRoutes } from "../../src/spaces/routes";
import { registerPortal } from "../../src/portal";

let app: FastifyInstance;

beforeAll(async () => {
  fs.writeFileSync(path.join(DIST, "index.html"), "<!doctype html><title>portal-root</title>");
  app = Fastify();
  await registerSpaceRoutes(app);
  await registerPortal(app);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  fs.rmSync(DIST, { recursive: true, force: true });
});

describe("spaces and the portal SPA fallback", () => {
  it("serves index.html for the shell routes /s/<name> and /s/<name>/", async () => {
    for (const url of ["/s/pr-timeline", "/s/pr-timeline/", "/spaces"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain("portal-root");
    }
  });

  it("keeps server-owned /s/ misses as non-HTML 404s", async () => {
    for (const url of ["/s/_sdk/other.js", "/s/upload/tok", "/s/pr-timeline/app/bad-sig/", "/s/pr-timeline/app"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain("portal-root");
    }
  });

  it("the SDK still wins over the fallback", async () => {
    const r = await app.inject({ method: "GET", url: "/s/_sdk/workbench.js" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("javascript");
  });
});
