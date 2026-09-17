import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_HEADER, mintSessionKey } from "./cdp-bridge";

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

export interface ForwardOpts {
  userId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  /** Absolute URL on the internal service, e.g. `${INTERNAL_MCP_URL}` or `/rest/browser` on its origin. */
  target: string;
  body: unknown;
}

/**
 * Forward `body` to `target` with the caller's routing key. Returns true when
 * the reply has been sent (the upstream answered), false when the caller
 * should handle the request locally: the inbound request already carried the
 * header (we are the owning replica), or the hop failed at the network layer.
 */
export async function forwardForBrowserAffinity(opts: ForwardOpts): Promise<boolean> {
  const { userId, request, reply, target, body } = opts;
  if (request.headers[SESSION_HEADER]) return false;
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
      signal: AbortSignal.timeout(30_000),
    });
    text = await res.text();
  } catch {
    return false;
  }
  if (res.status === 202 || !text) {
    reply.status(202).send();
    return true;
  }
  reply.status(res.status).send(JSON.parse(text) as Record<string, unknown>);
  return true;
}
