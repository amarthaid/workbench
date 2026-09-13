import Fastify from "fastify";
import { config } from "./config";
import { handleMcpRequest } from "./mcp/server";
import { registerApiRoutes } from "./api/routes";
import { registerOAuthRoutes } from "./api/oauth-routes";
import { registerOAuthRedirectRoute } from "./api/oauth-redirect";
import { registerPortal } from "./portal";
import { registerJotRoutes } from "./jots/routes";
import { registerCurlProxy } from "./api/curl-proxy";
import { registerRestRoutes } from "./api/rest-routes";
import { startUploadReaper, MAX_TOKEN_CHARS } from "./jots/pending";
import { loadPlugins } from "./plugins/loader";
import { resolveMcpUser } from "./auth/oauth-server/resolve";
import { startBrowserReaper } from "./auth/browser-session";
import { startProfileDiskReaper } from "./auth/profile-disk";
import { registerCdpBridgeRoutes, startChannelReaper } from "./auth/cdp-bridge";
import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { db } from "./db.js";
import "./telemetry/tracing";
import { metricsRegistry, httpRequestsTotal, httpRequestDuration } from "./telemetry/metrics";

async function main() {
  const app = Fastify({
    // The jot upload token is a JWE carried as a path parameter — ~320 chars
    // for a plain deploy, more with a delete list — far over find-my-way's
    // 100-char default, which rejects the request before the route runs.
    // `mint` refuses to issue a token longer than this, so the router's bound
    // and the mint bound are the same number.
    routerOptions: { maxParamLength: MAX_TOKEN_CHARS },
    logger: {
      // Redact secrets from logs. req.url is intentionally NOT redacted:
      // keeping the URL visible is necessary for request tracing. The one
      // credential still in a URL is the jot upload token (/j/upload/<token>),
      // which is single-use, expires in minutes, and is encrypted rather than
      // merely signed — but it does reach the logs, so treat them accordingly.
      redact: {
        paths: [
          "req.headers.authorization",
          'req.headers["x-workbench-api-key"]',
          'req.query.token',
          'req.query.cdpToken',
        ],
        remove: false,
        censor: "[REDACTED]",
      },
    },
  });

  const { initDb } = await import("./db.js");
  await initDb();
  await loadPlugins();
  await registerApiRoutes(app);
  await registerOAuthRoutes(app);
  await registerOAuthRedirectRoute(app);
  startBrowserReaper();
  startProfileDiskReaper();
  startChannelReaper();

  // HTTP metrics — track every request except /metrics itself.
  app.addHook("onRequest", async (request) => {
    (request as { _metricStart?: number })._metricStart = Date.now();
  });
  app.addHook("onResponse", async (request, reply) => {
    const start = (request as { _metricStart?: number })._metricStart;
    if (!start) return;
    // routerPath was removed in Fastify 5; the matched route pattern now
    // lives on routeOptions. Falling back to the raw URL would explode the
    // metric's cardinality, since every id would become its own label.
    const route = request.routeOptions?.url ?? request.url;
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

  app.post("/mcp", async (request, reply) => {
    // /mcp accepts: x-workbench-api-key (headless), OAuth Bearer (browser flow),
    // or portal session JWT.
    const userId = await resolveMcpUser(request.headers as Record<string, string>);
    if (!userId) {
      const reqBody = request.body as { id?: string | number | null } | undefined;
      const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
      reply.header(
        "WWW-Authenticate",
        `Bearer realm="a-workbench", resource_metadata="${prm}"`
      );
      return reply.status(401).send({
        jsonrpc: "2.0",
        id: reqBody?.id ?? null,
        error: { code: -32001, message: "Unauthorized", data: { resource_metadata: prm } },
      });
    }
    const body = request.body as Record<string, unknown>;
    const result = await handleMcpRequest(body, userId);
    // JSON-RPC notifications return null — no body, just 202 Accepted.
    if (result === null) {
      reply.status(202).send();
      return;
    }
    reply.send(result);
  });

  // Plain-REST twin of /mcp — same credentials and same execution engine,
  // without JSON-RPC framing or the MCP result cap.
  await registerRestRoutes(app);

  await registerCurlProxy(app);
  await registerJotRoutes(app);
  startUploadReaper();

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
    await db.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT",  () => shutdown("SIGINT"));
}
