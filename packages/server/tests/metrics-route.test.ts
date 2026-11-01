import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";

// METRICS_TOKEN varies per test, so config is (re)mocked with vi.doMock and
// the route module reimported fresh each time rather than vi.mock'd once at
// the top (config is read once, at module-eval time, by metrics-route.ts).
async function buildApp(metricsToken: string | undefined) {
  vi.resetModules();
  vi.doMock("../src/config", () => ({
    config: { METRICS_TOKEN: metricsToken },
  }));
  const { registerMetricsRoute } = await import("../src/telemetry/metrics-route");
  const app = Fastify();
  registerMetricsRoute(app);
  await app.ready();
  return app;
}

describe("GET /metrics", () => {
  afterEach(() => {
    vi.doUnmock("../src/config");
  });

  it("404s with no Authorization header when no token is configured (closed by default)", async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s an unauthenticated request even when a token is configured", async () => {
    const app = await buildApp("scrape-secret");
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s the wrong token", async () => {
    const app = await buildApp("scrape-secret");
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("serves metrics for the correct bearer token", async () => {
    const app = await buildApp("scrape-secret");
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer scrape-secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    await app.close();
  });
});
