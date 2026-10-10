import Fastify from "fastify";
import { config } from "./config";
import { registerMcpRoute } from "./mcp/route";
import { registerApiRoutes } from "./api/routes";
import { registerAdminRoutes } from "./api/admin-routes";
import { registerOAuthRoutes } from "./api/oauth-routes";
import { registerOAuthRedirectRoute } from "./api/oauth-redirect";
import { registerPortal } from "./portal";
import { registerJotRoutes } from "./jots/routes";
import { registerCurlProxy } from "./api/curl-proxy";
import { registerRestRoutes } from "./api/rest-routes";
import { registerWorkspaceRoutes } from "./workspace/routes";
import { registerAudioRoutes } from "./audio/routes";
import { initBrowserAudio } from "./audio/manager";
import { loggerOptions } from "./telemetry/logger";
import { shutdownAllPulse } from "./audio/pulse";
import { registerVaultRoutes } from "./vault/routes";
import { startVaultReaper } from "./vault/otl";
import { startRecentReaper } from "./vault/recent";
import { startUploadReaper } from "./jots/pending";
import { loadPlugins } from "./plugins/loader";
import { registry } from "./plugins/registry";
import { isIntegrationDisabled, loadSettings, startSettingsPoll } from "./settings/instance-settings";
import { startBrowserReaper } from "./auth/browser-session";
import { registerCdpBridgeRoutes, startChannelReaper } from "./auth/cdp-bridge";
import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { db } from "./db.js";
import "./telemetry/tracing";
import { metricsRegistry, httpRequestsTotal, httpRequestDuration } from "./telemetry/metrics";

async function main() {
  const app = Fastify({
    logger: loggerOptions,
  });

  const { initDb } = await import("./db.js");
  await initDb();
  // Load instance settings before any request can be served, and keep them fresh
  // against changes made through other workers or pods.
  await loadSettings();
  registry.setDisabledPredicate(isIntegrationDisabled);
  startSettingsPoll();
  await loadPlugins();
  await registerApiRoutes(app);
  await registerAdminRoutes(app);
  await registerOAuthRoutes(app);
  await registerOAuthRedirectRoute(app);
  startBrowserReaper();
  startChannelReaper();

  // HTTP metrics — track every request except /metrics itself.
  app.addHook("onRequest", async (request) => {
    (request as { _metricStart?: number })._metricStart = Date.now();
  });
  app.addHook("onResponse", async (request, reply) => {
    const start = (request as { _metricStart?: number })._metricStart;
    if (!start) return;
    // routerPath was removed in Fastify 5; the matched route pattern now
    // lives on routeOptions. An unmatched request has no pattern, and its raw
    // URL must not stand in: every id would become its own label, and a path
    // can carry a credential (an audio capability).
    const route = request.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, (Date.now() - start) / 1000);
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  // Live-view CDP bridge: REST + SSE, no WebSocket upgrade anywhere in the
  // browser-facing path. See auth/cdp-bridge.ts.
  registerCdpBridgeRoutes(app);
  registerMcpRoute(app);

  // Plain-REST twin of /mcp — same credentials and same execution engine,
  // without JSON-RPC framing or the MCP result cap.
  await registerRestRoutes(app);

  await registerCurlProxy(app);
  await registerWorkspaceRoutes(app);
  await registerAudioRoutes(app);
  if (config.BROWSER_AUDIO_ENABLED) initBrowserAudio();
  await registerVaultRoutes(app);
  await registerJotRoutes(app);
  startUploadReaper();
  startVaultReaper();
  startRecentReaper();

  // Serve the built portal (static + SPA fallback). Registered last so API,
  // MCP, and the CDP bridge routes take precedence and the SPA fallback only
  // catches genuine client-route 404s.
  await registerPortal(app);

  await app.listen({ port: parseInt(config.PORT), host: "0.0.0.0" });
  console.log(`Server running on port ${config.PORT}`);
}

if (config.CLUSTER_ENABLED) {
  const isPostgres =
    config.DATABASE_URL.startsWith("postgres://") ||
    config.DATABASE_URL.startsWith("postgresql://");
  if (!isPostgres) {
    console.error(
      "[cluster] CLUSTER_ENABLED requires a PostgreSQL DATABASE_URL." +
      " SQLite cannot be safely shared across processes."
    );
    process.exit(1);
  }

  const numWorkers = availableParallelism();
  if (cluster.isPrimary) {
    console.log(`[cluster] primary ${process.pid} — forking ${numWorkers} workers`);
    for (let i = 0; i < numWorkers; i++) cluster.fork();
    cluster.on("exit", (worker, code) => {
      console.warn(`[cluster] worker ${worker.process.pid} exited (code=${code}), restarting`);
      cluster.fork();
    });
  } else {
    registerShutdown();
    main().catch(console.error);
  }
} else {
  registerShutdown();
  main().catch(console.error);
}

function registerShutdown() {
  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal} received — draining connection pool`);
    await shutdownAllPulse().catch(() => undefined);
    await db.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT",  () => shutdown("SIGINT"));
  // A crash must not leave PulseAudio daemons behind. 'exit' handlers run
  // synchronously: shutdownAllPulse sends the kills before its first await.
  process.once("exit", () => { void shutdownAllPulse(); });
}
