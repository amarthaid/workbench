import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerRobots, ROBOTS_TXT } from "../src/robots";

async function build() {
  const app = Fastify();
  registerRobots(app);
  app.get("/api/ping", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("robots", () => {
  it("serves a disallow-all robots.txt", async () => {
    const app = await build();
    const r = await app.inject({ method: "GET", url: "/robots.txt" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/plain");
    expect(r.body).toBe(ROBOTS_TXT);
    expect(r.body).toContain("Disallow: /");
    await app.close();
  });

  it("sets X-Robots-Tag on API responses and 404s", async () => {
    const app = await build();
    for (const url of ["/api/ping", "/nope"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.headers["x-robots-tag"]).toContain("noindex");
      expect(r.headers["x-robots-tag"]).toContain("nofollow");
    }
    await app.close();
  });
});
