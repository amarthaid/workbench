import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { metricsRegistry } from "./metrics";

/**
 * GET /metrics. Closed unless a scrape credential is configured
 * (config.METRICS_TOKEN): this page carries Prometheus process/app metrics,
 * including the full internal route table (every matched route pattern,
 * even ones absent from the public SPA bundle) and per-integration
 * tool-execution counters — previously served to anyone with no
 * authentication at all.
 *
 * 404 rather than 401 on every failure path (missing token, wrong token, or
 * the deployment never configuring one at all): an anonymous caller learns
 * nothing about whether the route exists or why it failed.
 */
export function registerMetricsRoute(app: FastifyInstance): void {
  app.get("/metrics", async (request, reply) => {
    if (!config.METRICS_TOKEN) return reply.status(404).send();
    const header = String(request.headers.authorization ?? "");
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented);
    const b = Buffer.from(config.METRICS_TOKEN);
    if (a.length === 0 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return reply.status(404).send();
    }
    reply.header("Content-Type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}
