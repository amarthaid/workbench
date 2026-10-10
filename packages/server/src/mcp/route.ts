import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { handleMcpRequest } from "./server";
import { resolveMcpUser } from "../auth/oauth-server/resolve";
import { SESSION_HEADER, verifySessionKey } from "../auth/cdp-bridge";
import { forwardForBrowserAffinity } from "../auth/affinity-forward";
import { needsBrowserAffinity, runWithBrowserAffinity } from "../auth/reconnect/affinity";
import { VIA_HEADER, mcpLoopRefusal, parseVia, runWithVia } from "../custom-apps/loop-guard";

export function registerMcpRoute(app: FastifyInstance): void {
  app.post("/mcp", async (request, reply) => {
    // A custom app (here, or on another workbench) that leads back to this
    // instance would loop without end. See custom-apps/loop-guard.ts.
    const via = request.headers[VIA_HEADER];
    const loop = mcpLoopRefusal(via, request.body);
    if (loop) return reply.status(loop.status).send(loop.body);

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

    // Under CLUSTER_ENABLED a browser_* call must reach the replica that owns
    // this user's chromium. The routing key is derived from the bearer, not
    // read from the agent's arguments. See auth/affinity-forward.ts.
    const params = body.params as { name?: unknown; arguments?: { executions?: unknown } } | undefined;
    if (
      config.INTERNAL_MCP_URL &&
      body.method === "tools/call" &&
      needsBrowserAffinity(params?.arguments?.executions, params?.name)
    ) {
      const sent = await forwardForBrowserAffinity({
        userId, request, reply, target: config.INTERNAL_MCP_URL, body,
      });
      if (sent) return reply;
    }

    // Outbound custom-app calls made while handling this request extend its chain.
    const run = () => runWithVia(parseVia(via), () => handleMcpRequest(body, userId));
    // A verified routing key means this replica owns the user's chromium, so a
    // cookie reconnect recipe may drive it. Without a cluster mayOwnBrowser()
    // is already true and there is nothing to verify.
    let owner = false;
    if (config.INTERNAL_MCP_URL) {
      const inboundKey = request.headers[SESSION_HEADER];
      owner = verifySessionKey(Array.isArray(inboundKey) ? inboundKey[0] : inboundKey, userId);
    }
    const result = await (owner ? runWithBrowserAffinity(run) : run());
    // JSON-RPC notifications return null — no body, just 202 Accepted.
    if (result === null) {
      reply.status(202).send();
      return;
    }
    reply.send(result);
  });
}
