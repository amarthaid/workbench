import { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";

/**
 * HttpOnly binding cookie for the third-party "connect" OAuth flows
 * (plugin integrations and custom apps). Mirrors awb_oauth_binding on the
 * MCP authorization server: ties the provider's callback to the browser
 * that started the flow, so a second workbench user can't start it under
 * their own account and have a victim's provider approval land there.
 *
 * Scoped to the specific callback path (not just Path=/) so a connect flow
 * in flight for one integration can't be confused with another.
 */
const COOKIE_PREFIX = "awb_connect_binding_";

function cookieName(key: string): string {
  return `${COOKIE_PREFIX}${key}`;
}

export function setConnectBindingCookie(reply: FastifyReply, key: string, binding: string, path: string): void {
  const secure = config.SERVER_PUBLIC_URL.startsWith("https://") ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${cookieName(key)}=${binding}; HttpOnly; Path=${path}; Max-Age=600; SameSite=Lax${secure}`
  );
}

export function clearConnectBindingCookie(reply: FastifyReply, key: string, path: string): void {
  reply.header("Set-Cookie", `${cookieName(key)}=; HttpOnly; Path=${path}; Max-Age=0; SameSite=Lax`);
}

export function readConnectBindingCookie(request: FastifyRequest, key: string): string | undefined {
  const cookie = request.headers.cookie ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${cookieName(key)}=([^;]+)`));
  return m ? m[1] : undefined;
}
