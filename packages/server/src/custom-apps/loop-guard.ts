import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { config } from "../config";

/**
 * A custom app is any MCP server a user points workbench at — including this
 * workbench's own /mcp, or another workbench whose custom app points back
 * here. Either one turns a tool call into a loop: the custom app's tools are
 * workbench's meta-tools, so `execute_tools` can call itself through the app
 * without end.
 *
 * Two layers:
 *  - create time: `isOwnResource` refuses an app whose protected-resource
 *    metadata names this instance's /mcp. The metadata is what the server says
 *    it is, so it catches a second hostname, a CNAME or a bare IP that the
 *    typed URL would hide.
 *  - call time: every outbound custom-app request carries `X-Workbench-Via`,
 *    the chain of workbench instances it has passed through. /mcp refuses a
 *    request whose chain already names this instance (A → A, A → B → A), or
 *    is longer than MAX_HOPS.
 */

export const VIA_HEADER = "x-workbench-via";
/** Longest chain /mcp accepts. Legitimate chaining is one or two hops. */
export const MAX_HOPS = 4;

/**
 * This instance's id in the chain: an HMAC of SESSION_SECRET, so every
 * replica of one deployment shares it (a loop through a sibling replica is
 * still a loop) and the secret itself never leaves the process.
 */
export function instanceId(): string {
  return createHmac("sha256", config.SESSION_SECRET).update("workbench-instance-id").digest("hex").slice(0, 16);
}

const ID = /^[0-9a-f]{16}$/;

/** The chain an inbound request carries. Malformed entries are dropped. */
export function parseVia(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  const raw = Array.isArray(header) ? header.join(",") : header;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ID.test(s));
}

/** Why an inbound /mcp request must be refused, or null if it may run. */
export function loopReason(via: string[]): "self" | "hops" | null {
  if (via.includes(instanceId())) return "self";
  if (via.length >= MAX_HOPS) return "hops";
  return null;
}

const inbound = new AsyncLocalStorage<string[]>();

/** Run a /mcp request with its inbound chain, so outbound calls extend it. */
export function runWithVia<T>(via: string[], fn: () => T): T {
  return inbound.run(via, fn);
}

/** The chain to send on an outbound custom-app request: inbound + this instance. */
export function outboundVia(): string {
  return [...(inbound.getStore() ?? []), instanceId()].join(",");
}

/**
 * Wrap a fetch so each request carries the chain as it stands when the
 * request is made. Read per request, not per connection: a custom-app session
 * is cached and reused across /mcp requests with different chains.
 */
export function withVia(fetchFn: (url: string | URL, init?: RequestInit) => Promise<Response>) {
  return (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set(VIA_HEADER, outboundVia());
    return fetchFn(url, { ...init, headers });
  };
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** True when a protected-resource `resource` is this instance's own /mcp. */
export function isOwnResource(resourceUrl: string | undefined): boolean {
  if (!resourceUrl) return false;
  try {
    const own = new URL(`${trimSlash(config.SERVER_PUBLIC_URL)}/mcp`);
    const got = new URL(resourceUrl);
    return got.origin === own.origin && trimSlash(got.pathname) === trimSlash(own.pathname);
  } catch {
    return false;
  }
}

/**
 * The response /mcp sends instead of running a looping request, or null to
 * run it. 508 Loop Detected, with a JSON-RPC error so the calling workbench
 * reports it as a failed tool call rather than a transport fault.
 */
export function mcpLoopRefusal(
  header: string | string[] | undefined,
  body: unknown
): { status: 508; body: Record<string, unknown> } | null {
  const reason = loopReason(parseVia(header));
  if (!reason) return null;
  const id = (body as { id?: string | number | null } | undefined)?.id ?? null;
  const message =
    reason === "self"
      ? "Loop detected: this request already passed through this workbench (a custom app points back at it)"
      : `Loop detected: the request passed through ${MAX_HOPS} or more workbench instances`;
  return { status: 508, body: { jsonrpc: "2.0", id, error: { code: -32000, message } } };
}
