import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";

// Portal dist is baked into the image at /app/portal but was never served.
// registerPortal must serve those static files and SPA-fallback client routes
// (e.g. the v0.2.0 /connect/:integration page) to index.html, while leaving
// API / MCP 404s as JSON. cwd during vitest is packages/server.
const DIST = path.resolve("./tmp-portal-dist");

vi.mock("../src/config", () => ({
  config: { PORTAL_DIST_DIR: "./tmp-portal-dist", NODE_ENV: "test" },
}));

beforeAll(() => {
  fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(DIST, "index.html"),
    "<!doctype html><title>portal-root</title>"
  );
  fs.writeFileSync(path.join(DIST, "assets", "app.js"), "console.log('app-bundle')");
});

afterAll(() => {
  fs.rmSync(DIST, { recursive: true, force: true });
});

async function build() {
  const Fastify = (await import("fastify")).default;
  const { registerPortal } = await import("../src/portal");
  const app = Fastify();
  app.get("/api/ping", async () => ({ ok: true }));
  app.post("/mcp", async () => ({ ok: true }));
  await registerPortal(app);
  await app.ready();
  return app;
}

describe("portal static serving", () => {
  it("serves index.html at /", async () => {
    const app = await build();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("portal-root");
    await app.close();
  });

  it("serves built asset files", async () => {
    const app = await build();
    const r = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("app-bundle");
    await app.close();
  });

  it("SPA-falls back to index.html for client routes (/connect/jira)", async () => {
    const app = await build();
    const r = await app.inject({ method: "GET", url: "/connect/jira" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("portal-root");
    await app.close();
  });

  it("keeps real API routes working", async () => {
    const app = await build();
    const r = await app.inject({ method: "GET", url: "/api/ping" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    await app.close();
  });

  it("does NOT SPA-fallback unknown API routes (JSON 404)", async () => {
    const app = await build();
    const r = await app.inject({ method: "GET", url: "/api/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain("portal-root");
    await app.close();
  });

  it("does NOT SPA-fallback unknown REST routes (JSON 404)", async () => {
    const app = await build();
    const r = await app.inject({ method: "GET", url: "/rest/github/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain("portal-root");
    await app.close();
  });
});
