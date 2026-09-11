import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { config } from "./config";
import { handleMcpRequest } from "./mcp/server";
import { registerApiRoutes } from "./api/routes";
import { registerOAuthRoutes } from "./api/oauth-routes";
import { registerOAuthRedirectRoute } from "./api/oauth-redirect";
import { registerPortal } from "./portal";
import { registerJotRoutes } from "./jots/routes";
import { registerCurlProxy } from "./api/curl-proxy";
import { registerRestRoutes } from "./api/rest-routes";
import { startUploadReaper } from "./jots/pending";
import { loadPlugins } from "./plugins/loader";
import { verifySession } from "./auth/session";
import { resolveMcpUser } from "./auth/oauth-server/resolve";
import { startBrowserReaper } from "./auth/browser-session";
import { startProfileDiskReaper } from "./auth/profile-disk";
import { authorizeCdpFrame } from "./auth/cdp-authz";
import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { db } from "./db.js";
import "./telemetry/tracing";
import { metricsRegistry, httpRequestsTotal, httpRequestDuration } from "./telemetry/metrics";

// Session JWT (Authorization: Bearer) — used by the portal and the CDP WS frame.
async function getUserIdFromAuth(auth?: string): Promise<string | null> {
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const session = await verifySession(auth.slice(7));
    return session.userId;
  } catch {
    return null;
  }
}

async function main() {
  const app = Fastify({
    logger: {
      // Redact secrets from logs. req.url is intentionally NOT redacted —
      // tokens were once in URLs but no longer are; keeping the URL visible
      // is necessary for request tracing.
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

  // Origin allowlist for browser-driven endpoints (specifically the CDP WS
  // proxy). Without this, a malicious page could open a WebSocket to our
  // proxy from the user's already-authenticated portal session.
  const allowedOrigins = new Set<string>(
    [config.PORTAL_URL, config.SERVER_PUBLIC_URL].filter(Boolean)
  );
  function isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return false;
    try {
      const u = new URL(origin);
      const normalized = `${u.protocol}//${u.host}`;
      return allowedOrigins.has(normalized);
    } catch {
      return false;
    }
  }

  const { initDb } = await import("./db.js");
  await initDb();
  await app.register(fastifyWebsocket);
  await loadPlugins();
  await registerApiRoutes(app);
  await registerOAuthRoutes(app);
  await registerOAuthRedirectRoute(app);
  startBrowserReaper();
  startProfileDiskReaper();

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

  // Reject the WS upgrade itself when the Origin header doesn't match the
  // portal — blocks Cross-Site WebSocket Hijacking. Applies BEFORE the
  // websocket handshake completes.
  app.addHook("preValidation", async (request, reply) => {
    const isCookieCdp = request.url.startsWith("/api/auth/cookie/") && request.url.includes("/cdp");
    const isBrowserCdp = request.url.startsWith("/api/browser-session/cdp");
    if (isCookieCdp || isBrowserCdp) {
      const origin = request.headers.origin;
      if (!isOriginAllowed(origin)) {
        return reply.code(403).send({ error: "Origin not allowed" });
      }
    }
  });

  // Proxy raw Chrome DevTools Protocol WebSocket from the browser to the
  // per-user Chromium owned by browser-session.ts.
  //
  // Auth is intentionally NOT in the URL. The client must send a single
  // JSON auth frame as its first message:
  //   { "type": "auth", "sessionId": "...", "cdpToken": "..." }
  // The server then validates the (sessionId, cdpToken) pair against the
  // in-memory session map; only on success does it dial chromium and start
  // proxying frames. Anything else closes the connection with 4401.
  app.get<{ Params: { integration: string } }>(
    "/api/auth/cookie/:integration/cdp",
    { websocket: true },
    (conn, request) => {
      const browserWs = conn as unknown as WebSocket;

      // Re-check origin in the handler too — defense in depth against any
      // route ordering or hook-skipping regression.
      if (!isOriginAllowed(request.headers.origin)) {
        try { browserWs.close(4403, "Origin not allowed"); } catch { /* noop */ }
        return;
      }

      // CDP frames are JSON text — chromium closes the socket (1006) if we
      // forward Buffer with the default binary opcode. Normalize both ways.
      const toText = (data: WebSocket.RawData): string => {
        if (typeof data === "string") return data;
        if (Buffer.isBuffer(data)) return data.toString("utf8");
        if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
        return Buffer.from(data as ArrayBuffer).toString("utf8");
      };

      let upstream: WebSocket | null = null;
      let upstreamReady = false;
      const pending: string[] = [];
      const authTimeout = setTimeout(() => {
        try { browserWs.close(4408, "auth timeout"); } catch { /* noop */ }
      }, 5000);

      function startProxy(target: string) {
        // Chromium's CDP WebSocket gates Origin against
        // --remote-allow-origins. Send a known origin from our side and
        // match it on the chromium args (`http://127.0.0.1`).
        upstream = new WebSocket(target, {
          perMessageDeflate: false,
          origin: "http://127.0.0.1",
        });
        upstream.on("open", () => {
          upstreamReady = true;
          for (const msg of pending) upstream!.send(msg);
          pending.length = 0;
        });
        upstream.on("message", (data: WebSocket.RawData) => {
          if (browserWs.readyState === WebSocket.OPEN) browserWs.send(toText(data));
        });
        const upstreamClosed = () => {
          try { browserWs.close(); } catch { /* noop */ }
        };
        upstream.on("close", upstreamClosed);
        upstream.on("error", upstreamClosed);
      }

      browserWs.on("message", async (data: WebSocket.RawData) => {
        const text = toText(data);
        if (!upstream) {
          // First frame must be the auth handshake.
          let msg: { type?: string; sessionId?: string; cdpToken?: string; bearer?: string };
          try {
            msg = JSON.parse(text);
          } catch {
            try { browserWs.close(4400, "Bad auth frame"); } catch { /* noop */ }
            return;
          }
          if (
            msg.type !== "auth" ||
            !msg.sessionId ||
            !msg.cdpToken ||
            !msg.bearer
          ) {
            try { browserWs.close(4401, "Unauthorized"); } catch { /* noop */ }
            return;
          }
          // Verify the caller is the same portal user who started the
          // cookie session. The browser can't set Authorization on a WS, but
          // it can include its bearer in the first auth frame.
          const portalUserId = await getUserIdFromAuth(`Bearer ${msg.bearer}`);
          const target = await authorizeCdpFrame(msg, portalUserId);
          if (!target) {
            try { browserWs.close(4401, "Unauthorized"); } catch { /* noop */ }
            return;
          }
          clearTimeout(authTimeout);
          startProxy(target);
          // Tell the client it can start sending CDP commands now.
          try { browserWs.send(JSON.stringify({ type: "ready" })); } catch { /* noop */ }
          return;
        }
        if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
          upstream.send(text);
        } else {
          pending.push(text);
        }
      });

      browserWs.on("close", () => {
        clearTimeout(authTimeout);
        try { upstream?.close(); } catch { /* noop */ }
      });
      browserWs.on("error", () => {
        clearTimeout(authTimeout);
        try { upstream?.close(); } catch { /* noop */ }
      });
    }
  );

  // Browser-session live-view: same auth-framed CDP proxy as cookie capture,
  // but the target is the user's warm browser page resolved via cdpToken.
  app.get("/api/browser-session/cdp", { websocket: true }, (conn, request) => {
    const browserWs = conn as unknown as WebSocket;
    if (!isOriginAllowed(request.headers.origin)) {
      try { browserWs.close(4403, "Origin not allowed"); } catch { /* noop */ }
      return;
    }
    const toText = (data: WebSocket.RawData): string => {
      if (typeof data === "string") return data;
      if (Buffer.isBuffer(data)) return data.toString("utf8");
      if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
      return Buffer.from(data as ArrayBuffer).toString("utf8");
    };

    let upstream: WebSocket | null = null;
    let upstreamReady = false;
    const pending: string[] = [];
    const authTimeout = setTimeout(() => {
      try { browserWs.close(4408, "auth timeout"); } catch { /* noop */ }
    }, 5000);

    function startProxy(target: string) {
      upstream = new WebSocket(target, { perMessageDeflate: false, origin: "http://127.0.0.1" });
      upstream.on("open", () => {
        upstreamReady = true;
        for (const msg of pending) upstream!.send(msg);
        pending.length = 0;
      });
      upstream.on("message", (data: WebSocket.RawData) => {
        if (browserWs.readyState === WebSocket.OPEN) browserWs.send(toText(data));
      });
      const upstreamClosed = () => { try { browserWs.close(); } catch { /* noop */ } };
      upstream.on("close", upstreamClosed);
      upstream.on("error", upstreamClosed);
    }

    browserWs.on("message", async (data: WebSocket.RawData) => {
      const text = toText(data);
      if (!upstream) {
        let msg: { type?: string; sessionId?: string; cdpToken?: string; bearer?: string };
        try { msg = JSON.parse(text); } catch {
          try { browserWs.close(4400, "Bad auth frame"); } catch { /* noop */ }
          return;
        }
        if (msg.type !== "auth" || !msg.sessionId || !msg.cdpToken || !msg.bearer) {
          try { browserWs.close(4401, "Unauthorized"); } catch { /* noop */ }
          return;
        }
        const portalUserId = await getUserIdFromAuth(`Bearer ${msg.bearer}`);
        const target = await authorizeCdpFrame(msg, portalUserId);
        if (!target) {
          try { browserWs.close(4401, "Unauthorized"); } catch { /* noop */ }
          return;
        }
        clearTimeout(authTimeout);
        startProxy(target);
        try { browserWs.send(JSON.stringify({ type: "ready" })); } catch { /* noop */ }
        return;
      }
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else pending.push(text);
    });

    browserWs.on("close", () => { clearTimeout(authTimeout); try { upstream?.close(); } catch { /* noop */ } });
    browserWs.on("error", () => { clearTimeout(authTimeout); try { upstream?.close(); } catch { /* noop */ } });
  });

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
  // MCP, and the CDP WS routes take precedence and the SPA fallback only
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
