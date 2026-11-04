// Who/where a request came from, for the audit events it produces: source IP,
// user agent, how it authenticated, and the OAuth client, when there is one.
//
// Every route handler runs inside an AsyncLocalStorage store created from its
// request (installAuditContext, an onRoute hook at the app root, so no route
// can be missed). The credential checks fill in the auth fields when they
// succeed (noteAuth), and the audit logger reads the store when it writes an
// event. Events written outside any request (background reconnects) carry
// none of these fields.
//
// The IP is clientIp() (src/trust-proxy.ts): CLIENT_IP_HEADER (e.g.
// CF-Connecting-IP) from a trusted peer, else Fastify's request.ip, which is
// the load balancer's address unless TRUST_PROXY names it (then
// X-Forwarded-For is used). The client name is the one the client chose at dynamic registration:
// self-declared, not verified.

import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance, FastifyRequest, RouteOptions } from "fastify";
import { clientIp } from "../trust-proxy";

export type AuthMethod = "api_key" | "oauth" | "session" | "curl_token";

export interface AuditRequestContext {
  source_ip?: string;
  user_agent?: string;
  auth_method?: AuthMethod;
  client_id?: string;
}

const USER_AGENT_MAX = 512;
const store = new AsyncLocalStorage<AuditRequestContext>();
// Auth decided in a hook that runs before the handler (the admin gate).
const preAuth = new WeakMap<object, { method: AuthMethod; clientId?: string }>();

export function currentAuditContext(): AuditRequestContext | undefined {
  return store.getStore();
}

/** Record how the current request authenticated. A no-op outside a request. */
export function noteAuth(method: AuthMethod, clientId?: string): void {
  const c = store.getStore();
  if (!c) return;
  c.auth_method = method;
  c.client_id = clientId;
}

/** For hooks that authenticate before the handler (and so before its store exists). */
export function noteRequestAuth(request: object, method: AuthMethod, clientId?: string): void {
  preAuth.set(request, { method, clientId });
}

export function auditContextFrom(request: FastifyRequest): AuditRequestContext {
  const ua = request.headers["user-agent"];
  const pre = preAuth.get(request);
  return {
    source_ip: clientIp(request),
    user_agent: typeof ua === "string" && ua ? ua.slice(0, USER_AGENT_MAX) : undefined,
    auth_method: pre?.method,
    client_id: pre?.clientId,
  };
}

/** Run `fn` with `ctx` as the current request's audit context (tests, non-route entry points). */
export function runWithAuditContext<T>(ctx: AuditRequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/**
 * Wrap every route handler registered after this call (in this instance and
 * every plugin registered under it) so it runs inside its request's store.
 */
export function installAuditContext(app: FastifyInstance): void {
  app.addHook("onRoute", (route: RouteOptions) => {
    const handler = route.handler;
    if (typeof handler !== "function") return;
    route.handler = function (this: unknown, request, reply) {
      return store.run(auditContextFrom(request), () => (handler as Function).call(this, request, reply));
    } as RouteOptions["handler"];
  });
}
