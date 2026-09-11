import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { config } from "../config";
import { registry } from "../plugins/registry";
import { executeSingle, executeMany, type ExecResult } from "../mcp/meta-tools";
import { resolveMcpUser } from "../auth/oauth-server/resolve";
import { getToken } from "../auth/tokens";
import { hasValidCookies } from "../auth/cookie";

// Plain-REST alternative to `POST /mcp`: same credentials, same execution
// engine (`executeSingle`/`executeMany` from the meta-tools module), same
// audit rows and metrics — only the envelope differs. JSON-RPC framing and
// MCP content blocks are gone, and with them the 60,000-character result cap,
// which lives in the MCP renderer (`capResultText`) and never in execution.
// A caller that wants a whole 2 MB payload uses this endpoint.

const SingleBody = z.object({ tool: z.string().min(1), args: z.record(z.unknown()).optional() });
const BatchBody = z.object({
  executions: z.array(SingleBody).min(1),
});

// Keys that are part of the envelope, not tool arguments. Everything else in
// a flat body is forwarded to the tool.
const ENVELOPE_KEYS = new Set(["tool", "args", "executions"]);

type Resolution = { ok: true; name: string } | { ok: false; error: string };

// Resolve a body-supplied tool name inside the integration named in the path.
// Both spellings work: the fully-qualified registry name (`github_list_repos`)
// and the bare suffix (`list_repos`). Built-in tools that don't carry the
// integration prefix (`list_jots`) resolve by their literal name.
//
// The integration in the path is authoritative: a tool that exists but belongs
// to another integration is refused rather than silently executed, so
// `POST /rest/github` can never reach a Jira tool.
function resolveToolName(integration: string, tool: string): Resolution {
  const prefix = `${integration}_`;
  const candidates = tool.startsWith(prefix) ? [tool] : [tool, `${prefix}${tool}`];
  let foreign: string | null = null;
  for (const candidate of candidates) {
    const found = registry.getTool(candidate);
    if (!found) continue;
    if (found.integration === integration) return { ok: true, name: candidate };
    foreign ??= found.integration;
  }
  if (foreign) {
    return {
      ok: false,
      error: `Tool "${tool}" belongs to integration "${foreign}", not "${integration}"`,
    };
  }
  return { ok: false, error: `Tool not found: ${tool}` };
}

// Map an execution error onto an HTTP status. The engine reports failures as
// `{ error }` strings shared with `/mcp`; only the status code is a REST-layer
// concern.
function statusForError(error: string): number {
  if (error === "NOT_CONNECTED") return 409; // credential missing — connect first
  if (error.startsWith("Invalid arguments for ")) return 400; // schema rejected the args
  return 502; // the plugin handler or its upstream failed
}

async function isConnected(name: string, userId: string): Promise<boolean> {
  const integ = registry.getIntegration(name);
  if (!integ) return false;
  if (integ.auth.type === "none") return true;
  if (integ.auth.type === "cookie") return hasValidCookies(userId, name);
  return !!(await getToken(userId, name));
}

// Same three credentials as `/mcp`, in the same order: API-key header, OAuth
// 2.1 access token, portal session JWT. The 401 carries the same
// `WWW-Authenticate` challenge so an OAuth-capable client can discover the
// flow from here too — the body is plain JSON, not JSON-RPC.
async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = await resolveMcpUser(request.headers as Record<string, string>);
  if (userId) return userId;
  const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  reply.header("WWW-Authenticate", `Bearer realm="a-workbench", resource_metadata="${prm}"`);
  reply.status(401).send({ error: "Unauthorized", resource_metadata: prm });
  return null;
}

export async function registerRestRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    // Body parsing, scoped to this plugin so the rest of the server keeps
    // Fastify's strict defaults (encapsulation makes the removals local):
    //
    //  * A bodyless POST has to work — a tool with no arguments is a natural
    //    `curl -X POST`, and the built-in JSON parser rejects an empty body
    //    with FST_ERR_CTP_EMPTY_JSON_BODY as soon as a content-type is
    //    present (docs/findings/2026-06-10-empty-json-body-bodyless-post.md).
    //    An exact-match parser must replace the built-in one, because exact
    //    matches always win over a regex.
    //  * Anything that is not JSON is refused outright rather than reaching a
    //    tool as a string: form-encoded args would arrive all-strings and be
    //    rejected by the plugin's own Zod schema anyway, with a far more
    //    confusing message.
    scope.removeContentTypeParser(["application/json", "text/plain"]);
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      const text = (body as string).trim();
      if (!text) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        done(Object.assign(new Error("Body is not valid JSON"), { statusCode: 400 }));
      }
    });
    scope.addContentTypeParser(/^.*$/, { parseAs: "string" }, (req, _body, done) => {
      const type = req.headers["content-type"] ?? "none";
      done(
        Object.assign(new Error(`Unsupported content type: ${type} — send application/json`), {
          statusCode: 415,
        })
      );
    });

    // Discovery: which integrations exist and whether this user can call them.
    scope.get("/rest", async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      const integrations = await Promise.all(
        registry.listIntegrations().map(async (i) => ({
          name: i.name,
          displayName: i.displayName,
          authType: i.auth.type,
          connected: await isConnected(i.name, userId),
          toolCount: registry.listToolsByIntegration(i.name).length,
          url: `/rest/${i.name}`,
        }))
      );
      return { integrations };
    });

    // Discovery: the tools of one integration, with their JSON Schemas, so a
    // REST caller never has to open an MCP session to learn the arguments.
    scope.get<{ Params: { integration: string } }>(
      "/rest/:integration",
      async (request, reply) => {
        const userId = await authenticate(request, reply);
        if (!userId) return reply;
        const { integration } = request.params;
        if (!registry.getIntegration(integration)) {
          return reply.status(404).send({ error: `Integration not found: ${integration}` });
        }
        return {
          integration,
          connected: await isConnected(integration, userId),
          tools: registry.listToolsByIntegration(integration).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema:
              t.inputSchema instanceof z.ZodType
                ? zodToJsonSchema(t.inputSchema as z.ZodTypeAny)
                : t.inputSchema,
          })),
        };
      }
    );

    // Execute. Everything the call needs is in the body:
    //   { "tool": "github_list_repos", "args": { "perPage": 100 } }
    //   { "tool": "github_list_repos", "perPage": 100 }        (flat form)
    //   { "executions": [ { "tool": …, "args": … }, … ] }      (batch form)
    scope.post<{ Params: { integration: string } }>(
      "/rest/:integration",
      async (request, reply) => {
        const userId = await authenticate(request, reply);
        if (!userId) return reply;

        const { integration } = request.params;
        if (!registry.getIntegration(integration)) {
          return reply.status(404).send({ error: `Integration not found: ${integration}` });
        }

        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return reply.status(400).send({ error: "Body must be a JSON object" });
        }
        const raw = body as Record<string, unknown>;

        // Batch form — same semantics as the `execute_tools` meta-tool: HTTP
        // 200 with an index-aligned `results` array, one failing item never
        // aborting the others.
        if (raw.executions !== undefined) {
          const parsed = BatchBody.safeParse(raw);
          if (!parsed.success) {
            return reply.status(400).send({ error: `Invalid body: ${parsed.error.message}` });
          }
          const items = parsed.data.executions;
          const resolutions = items.map((i) => resolveToolName(integration, i.tool));
          const runnable = items
            .map((item, index) => ({ item, index, resolution: resolutions[index] }))
            .filter((e) => e.resolution.ok);
          const { results } = await executeMany(
            userId,
            runnable.map((e) => ({
              tool: (e.resolution as { ok: true; name: string }).name,
              args: e.item.args ?? {},
            }))
          );
          // Unresolvable names never reach the engine; they get their own
          // entry so the array stays index-aligned with `executions`.
          const merged: ExecResult[] = new Array(items.length);
          resolutions.forEach((r, i) => {
            if (!r.ok) merged[i] = { error: r.error };
          });
          runnable.forEach((e, k) => {
            merged[e.index] = results[k];
          });
          return reply.send({ integration, results: merged });
        }

        // Single form. `args` wins when present; otherwise every non-envelope
        // key in the body is treated as a tool argument, which is what makes
        // the flat spelling work. A tool with an argument literally named
        // `tool` or `args` must use the `args` wrapper.
        const parsed = SingleBody.safeParse(raw);
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Body must carry a "tool" string (or an "executions" array)',
            details: parsed.error.issues,
          });
        }
        const args =
          parsed.data.args ??
          Object.fromEntries(Object.entries(raw).filter(([k]) => !ENVELOPE_KEYS.has(k)));

        const resolution = resolveToolName(integration, parsed.data.tool);
        if (!resolution.ok) {
          return reply.status(404).send({ error: resolution.error, integration });
        }

        const outcome = await executeSingle(userId, resolution.name, args);
        if ("error" in outcome) {
          return reply
            .status(statusForError(outcome.error))
            .send({ ...outcome, integration, tool: resolution.name });
        }
        // No result cap: the whole payload is serialized as-is. That is the
        // point of this endpoint.
        return reply.send({ integration, tool: resolution.name, result: outcome.result });
      }
    );
  });
}
