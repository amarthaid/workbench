import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_HEADER, mintSessionKey, verifySessionKey } from "./cdp-bridge";

// A browser session is process-local (docs/findings/2026-09-10-browser-session-pod-affinity.md),
// so under CLUSTER_ENABLED every call that touches one must reach the replica
// that owns the user's chromium. The mesh hashes on X-Browser-Session; this
// helper sets it on a second hop to the internal service.
//
// The value is derived from the authenticated user, never taken from the
// agent: the endpoint has already resolved the bearer to a userId by the time
// it decides to forward, and the routing key is a pure function of that id.
// The agent's `session_id` names a tab and has nothing to do with routing.

/** True when any execution, or the directly named tool, is a browser_* tool. */
export function touchesBrowser(executions: unknown, directTool?: unknown): boolean {
  if (typeof directTool === "string" && directTool.startsWith("browser_")) return true;
  if (!Array.isArray(executions)) return false;
  return executions.some(
    (e) => e && typeof e === "object" && typeof (e as { tool?: unknown }).tool === "string" &&
      ((e as { tool: string }).tool).startsWith("browser_")
  );
}

/** Forward budget for a browser_* call. */
export const FORWARD_TIMEOUT_MS = 30_000;
/** Forward budget for a call that may run a reconnect recipe (max run 120s plus the tool). */
export const RECIPE_FORWARD_TIMEOUT_MS = 150_000;

// Errors raised before any byte of the request left this process.
const CONNECT_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
]);

function isConnectFailure(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" && CONNECT_CODES.has(code);
}

export interface ForwardOpts {
  userId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  /** Absolute URL on the internal service, e.g. `${INTERNAL_MCP_URL}` or `/rest/browser` on its origin. */
  target: string;
  body: unknown;
  /** Hop budget; defaults to FORWARD_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Forward `body` to `target` with the caller's routing key. Returns true when
 * a reply has been sent (the upstream answered, or 504/502 when the hop broke
 * after the request was sent), false when the caller should handle the
 * request locally: the inbound request already carried *our own* routing key
 * (we are the owning replica), or the connect itself failed.
 *
 * The inbound header is checked against the bearer's user, not merely for
 * presence: an authenticated agent that sent any value would otherwise
 * suppress forwarding, the mesh would hash its value onto an arbitrary
 * replica, and that replica would spawn a second chromium on the shared
 * profile and fight the owner for SingletonLock. A header that does not
 * verify is ignored and the request is forwarded with the correct key.
 */
export async function forwardForBrowserAffinity(opts: ForwardOpts): Promise<boolean> {
  const { userId, request, reply, target, body } = opts;
  const inbound = request.headers[SESSION_HEADER];
  if (verifySessionKey(Array.isArray(inbound) ? inbound[0] : inbound, userId)) return false;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [SESSION_HEADER]: mintSessionKey(userId),
  };
  const auth = request.headers.authorization as string | undefined;
  if (auth) headers.authorization = auth;
  const apiKey = request.headers["x-workbench-api-key"] as string | undefined;
  if (apiKey) headers["x-workbench-api-key"] = apiKey;
  let res: Response;
  let text: string;
  try {
    res = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? FORWARD_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    // Only a failed connect proves the owner never saw the request. After
    // that, the owner may still be running the tool (a slow recipe), and
    // running it here as well would duplicate its side effects.
    if (isConnectFailure(e)) return false;
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      reply.status(504).send({ error: "UPSTREAM_TIMEOUT" });
    } else {
      reply.status(502).send({ error: "UPSTREAM_ERROR" });
    }
    return true;
  }
  if (res.status === 202 || !text) {
    reply.status(202).send();
    return true;
  }
  reply.status(res.status).send(JSON.parse(text) as Record<string, unknown>);
  return true;
}
