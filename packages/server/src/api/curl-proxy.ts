import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { verifyCurlToken } from "../auth/curl-session";
import { createContext, type ToolContext } from "../plugins/context";
import { registry } from "../plugins/registry";
import { auditLogger } from "../audit/logger";
import { noteAuth } from "../audit/context";

const AUDIT_PATH_MAX = 300;

/**
 * A fixed, body-free reason for a failed proxied call. Raw error messages are
 * never recorded: some carry upstream response text (a failed token refresh
 * throws `Refresh failed <status>: <response body>`), and an undici error can
 * name the full URL with its query string. Only the status, a network error
 * code, and a category from this list reach the audit row.
 */
export function curlFailureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const refresh = /^Refresh failed (\d{3})/.exec(msg);
  if (refresh) return `token refresh failed (HTTP ${refresh[1]})`;
  if (/^NOT_CONNECTED$|^Not connected$/.test(msg)) return "not connected";
  if (/^Token expired/.test(msg)) return "token expired";
  if (/not in declared (allowedHosts|cookieDomains)$/.test(msg)) return "target host not allowed";
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) return `upstream request failed (${code})`;
  return "upstream request failed";
}

/**
 * One CURL_REQUEST audit row per proxied call: who, which integration, and
 * `METHOD /path`, plus success, the upstream status or a fixed failure reason
 * (curlFailureReason), and duration. Never recorded: the query string (search
 * terms, filters, sometimes tokens), request or response headers, and request
 * or response bodies. An audit failure is logged, never turned into a failed
 * proxy response.
 */
async function auditCurl(
  userId: string,
  integration: string,
  method: string,
  tail: string,
  start: number,
  outcome: { status?: number; error?: string }
): Promise<void> {
  const ok = outcome.status !== undefined && outcome.status < 400 && !outcome.error;
  await auditLogger
    .log({
      user_id: userId,
      integration,
      tool: `${method} /${tail}`.slice(0, AUDIT_PATH_MAX),
      action: "CURL_REQUEST",
      success: ok,
      error: ok ? undefined : (outcome.error ?? `HTTP ${outcome.status}`).slice(0, 500),
      duration_ms: Date.now() - start,
    })
    .catch((e) => console.error("[curl-proxy] audit write failed:", e));
}

type IntegrationProxy = NonNullable<ReturnType<typeof registry.getIntegration>>["proxy"];

// Headers that must not be forwarded between client ↔ proxy ↔ upstream.
const REQUEST_HOP_BY_HOP = new Set([
  "host",
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "authorization", // stripped — proxy injects the real credential
  "upgrade",
  "content-length", // recomputed from the forwarded body
]);

const RESPONSE_HOP_BY_HOP = new Set([
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "keep-alive",
  "upgrade",
]);

// Resolve the proxy base URL for an integration. Static integrations return
// proxy.baseUrl directly (Atlassian's "cloud-id" placeholder is resolved
// transparently by ctx.http). Dynamic integrations read per-connection config
// stored at connect time.
async function resolveProxyBaseUrl(proxy: NonNullable<IntegrationProxy>, ctx: ToolContext, name: string): Promise<string> {

  if (proxy.baseUrl) return proxy.baseUrl.replace(/\/$/, "");

  const cfg = ctx.getConfig();

  if (proxy.resolver === "instance-url") {
    const instanceUrl = (cfg.instanceUrl as string | undefined)?.replace(/\/$/, "");
    if (!instanceUrl) throw new Error(`No instanceUrl in connection config for ${name}`);
    return `${instanceUrl}${proxy.pathPrefix ?? ""}`;
  }

  if (proxy.resolver === "newrelic-region") {
    const region = (cfg.region as string | undefined)?.toUpperCase();
    return region === "EU"
      ? "https://api.eu.newrelic.com/graphql"
      : "https://api.newrelic.com/graphql";
  }

  throw new Error(`Cannot resolve proxy base URL for ${name}`);
}

export async function registerCurlProxy(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    // Parse every content-type as a raw buffer so the proxy can forward the
    // exact bytes without re-serialising. Scoped to this plugin only.
    scope.addContentTypeParser(/.*/, { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    scope.route({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
      url: "/c/:integration/*",
      handler: async (request, reply) => {
        // 1. Verify the curl session JWT.
        const authHeader = (request.headers.authorization ?? "") as string;
        if (!authHeader.startsWith("Bearer ")) {
          return reply.code(401).send({ error: "Authorization: Bearer <curl-session-token> required" });
        }
        let session: { userId: string; integrations: string[] };
        try {
          session = await verifyCurlToken(authHeader.slice(7));
          noteAuth("curl_token");
        } catch {
          return reply.code(401).send({ error: "Invalid or expired curl session token" });
        }

        const params = request.params as { integration: string; "*": string };
        const integration = params.integration;
        const tail = params["*"] ?? "";
        const start = Date.now();
        const audit = (outcome: { status?: number; error?: string }) =>
          auditCurl(session.userId, integration, request.method, tail, start, outcome);

        // 2. Integration must be in the session.
        if (!session.integrations.includes(integration)) {
          await audit({ status: 403, error: "integration not in this curl session" });
          return reply.code(403).send({ error: `Integration "${integration}" is not in this curl session` });
        }

        // 3. Integration must have the proxy enabled.
        const integ = registry.getIntegration(integration);
        if (!integ?.proxy) {
          await audit({ status: 400, error: "curl proxy not enabled" });
          return reply.code(400).send({ error: `Integration "${integration}" does not support curl proxy` });
        }

        // 4. Create context (needed for token refresh + dynamic base URL resolution).
        const ctx = await createContext(session.userId, integration);

        // 5. Resolve the base URL (static from manifest or dynamic from connection config).
        let base: string;
        try {
          base = await resolveProxyBaseUrl(integ.proxy, ctx, integration);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await audit({ status: 502, error: "cannot resolve proxy base URL" });
          return reply.code(502).send({ error: `Cannot resolve proxy base URL: ${msg}` });
        }

        // 6. Build the target URL, preserving the original query string.
        const rawUrl = request.url; // e.g. "/c/github/repos/owner/repo?page=2"
        const qIdx = rawUrl.indexOf("?");
        const qs = qIdx >= 0 ? rawUrl.slice(qIdx) : "";
        const targetUrl = tail ? `${base}/${tail}${qs}` : `${base}${qs}`;

        // 7. Build the forwarded header set (strip hop-by-hop + auth).
        const forwardHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (REQUEST_HOP_BY_HOP.has(key.toLowerCase())) continue;
          if (Array.isArray(value)) {
            forwardHeaders[key] = value.join(", ");
          } else if (value !== undefined) {
            forwardHeaders[key] = value;
          }
        }

        // 8. Forward the request. ctx.http handles token refresh and injects
        //    the real credential (oauth2 Bearer / apikey / cookie). For
        //    Atlassian integrations it also auto-resolves "cloud-id" in the URL.
        const hasBody = !["GET", "HEAD", "OPTIONS"].includes(request.method);
        const rawBody = request.body as Buffer | undefined;

        let upstream: Response;
        try {
          upstream = await ctx.http(targetUrl, {
            method: request.method,
            headers: forwardHeaders,
            body: hasBody && rawBody?.length ? (rawBody as unknown as BodyInit) : undefined,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await audit({ status: 502, error: curlFailureReason(err) });
          return reply.code(502).send({ error: `Upstream request failed: ${msg}` });
        }

        // Audited once the upstream status is known, before the body streams.
        await audit({ status: upstream.status });

        // 9. Forward the response (stream body, no buffering).
        reply.code(upstream.status);
        for (const [key, value] of upstream.headers) {
          if (!RESPONSE_HOP_BY_HOP.has(key.toLowerCase())) {
            reply.header(key, value);
          }
        }
        if (upstream.body) {
          // Convert WHATWG ReadableStream → Node.js Readable so Fastify can pipe it.
          return reply.send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
        }
        return reply.send("");
      },
    });
  });
}
