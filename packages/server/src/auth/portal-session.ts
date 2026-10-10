import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { resolveMcpUser } from "./oauth-server/resolve";
import { verifySession } from "./session";

// Portal-session-only authentication, narrower than an agent credential.
//
// `resolveMcpUser` accepts an API key or an OAuth access token - the agent's
// own credential. Routes that change what an agent may read or type (the
// vault, auto-reconnect bindings) must not be reachable with it, so these
// require the portal-session JWT, which only a signed-in human holds.
//
// 401 = no usable credential (missing, malformed, expired or disabled
// session), with WWW-Authenticate so the portal re-signs-in. 403 = a
// credential the server accepts, just not for this; re-authenticating would
// not help, so the portal must not log the human out over it.
export async function authenticatePortal(
  request: FastifyRequest,
  reply: FastifyReply,
  forbiddenMessage: string
): Promise<string | null> {
  const header = (request.headers.authorization as string | undefined) ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token) {
    try {
      const { userId } = await verifySession(token);
      if (userId) return userId;
    } catch {
      // Not a portal session. It may still be an agent credential - ask.
    }
    if (await resolveMcpUser(request.headers as Record<string, string>)) {
      reply.status(403).send({ error: "PORTAL_SESSION_REQUIRED", message: forbiddenMessage });
      return null;
    }
  }
  const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  reply.header("WWW-Authenticate", `Bearer realm="a-workbench", resource_metadata="${prm}"`);
  reply.status(401).send({ error: "Unauthorized", resource_metadata: prm });
  return null;
}
