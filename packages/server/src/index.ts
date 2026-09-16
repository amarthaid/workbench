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
import { registerWorkspaceRoutes } from "./workspace/routes";
import { registerVaultRoutes } from "./vault/routes";
import { startVaultReaper } from "./vault/otl";
import { startUploadReaper } from "./jots/pending";
import { loadPlugins } from "./plugins/loader";
import { resolveMcpUser } from "./auth/oauth-server/resolve";
import { startBrowserReaper } from "./auth/browser-session";
import { registerCdpBridgeRoutes, startChannelReaper, SESSION_HEADER } from "./auth/cdp-bridge";
import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { db } from "./db.js";
import "./telemetry/tracing";
import { metricsRegistry, httpRequestsTotal, httpRequestDuration } from "./telemetry/metrics";

async function main() {
  const app = Fastify({
    logger: {
      // Redact secrets from logs. req.url is intentionally NOT redacted:
      // keeping the URL visible is necessary for request tracing. The one
      // credential still in a URL is the jot upload token (/j/upload/<token>),
      // which is an opaque handle carrying nothing — the deploy it authorises
      // lives in the database — and is single-use with a few minutes' TTL. It
      // does still reach the logs, so treat them accordingly.
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

    // Forward browser_* tools/call requests through the mesh so that Istio's
    // consistent-hash DestinationRule (keyed on X-Browser-Session) routes them
    // to the replica that owns this user's Chromium. Without this, each call
    // may land on a different replica and spawn a second Chromium that fights
    // the first over the profile directory's SingletonLock.
    //
    // The agent first calls browser_start (no session_id → handled locally,
    // returns session_id = HMAC(SESSION_SECRET, userId)). Every subsequent
    // browser_* call is wrapped by the execute_tools meta-tool:
    //   { name:"execute_tools", arguments:{ executions:[{ tool:"browser_*",
    //     args:{ session_id:"...", ... } }] } }
    // session_id is in executions[i].args — NOT at the top-level arguments.
    // We scan executions for the first session_id and proxy to INTERNAL_MCP_URL
    // with X-Browser-Session set from it. Istio hashes on that header and routes
    // to the owning replica. The target pod sees the header and handles locally
    // (no second proxy).
    //
    // Auth is passed through transparently (Bearer / api-key). INTERNAL_MCP_URL
    // should be the k8s ClusterIP service URL (e.g. http://a-workbench/mcp);
    // leave unset for single-replica / local-dev.
    //
    // See docs/findings/2026-09-10-browser-session-pod-affinity.md.
    const sessionHeader = request.headers[SESSION_HEADER] as string | undefined;
    const callArgs = (body.params as Record<string, unknown> | undefined)?.arguments as Record<string, unknown> | undefined;
    // Real MCP clients wrap all tool calls inside execute_tools:
    //   { name: "execute_tools", arguments: { executions: [{ tool: "browser_*", args: { session_id, ... } }] } }
    // session_id is in executions[i].args, NOT at the top-level arguments.
    const executions = Array.isArray(callArgs?.executions)
      ? (callArgs!.executions as { tool?: unknown; args?: Record<string, unknown> }[])
      : [];
    const sessionId: string | undefined =
      executions.find((e) => typeof e?.args?.session_id === "string")?.args?.session_id as string | undefined;
    if (
      config.INTERNAL_MCP_URL &&
      !sessionHeader &&
      body.method === "tools/call" &&
      sessionId
    ) {
      const fwdHeaders: Record<string, string> = {
        "content-type": "application/json",
        [SESSION_HEADER]: sessionId,
      };
      const auth = request.headers.authorization as string | undefined;
      if (auth) fwdHeaders.authorization = auth;
      const apiKey = request.headers["x-workbench-api-key"] as string | undefined;
      if (apiKey) fwdHeaders["x-workbench-api-key"] = apiKey;
      try {
        const res = await fetch(config.INTERNAL_MCP_URL, {
          method: "POST",
          headers: fwdHeaders,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        if (res.status === 202 || !text) {
          reply.status(202).send();
          return;
        }
        reply.status(res.status).send(JSON.parse(text) as Record<string, unknown>);
        return;
      } catch {
        // Network error — fall through to local handling
      }
    }

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
  await registerWorkspaceRoutes(app);
  await registerVaultRoutes(app);
  await registerJotRoutes(app);
  startUploadReaper();
  startVaultReaper();

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
