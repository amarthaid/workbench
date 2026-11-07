import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { effectOf } from "@a-workbench/shared";
import { noteRequestAuth, currentAuditContext } from "../audit/context";
import { verifySession } from "../auth/session";
import { getUserById } from "../auth/users";
import { getToken } from "../auth/tokens";
import { hasValidCookies } from "../auth/cookie";
import { registry, type PluginTool } from "../plugins/registry";
import { isInternalIntegration } from "../plugins/internal-names";
import { executeSingle } from "../mcp/meta-tools";
import { canView, type Viewer } from "./access";
import {
  getShares,
  getSpace,
  grantConsent,
  hasConsent,
  hasFiles,
  isValidKvKey,
  kvDelete,
  kvGet,
  kvKeys,
  kvPut,
  listAllSpaces,
  ownerEmailOf,
  revokeConsent,
  type Space,
} from "./store";
import { mintSig } from "./sig";
import { takeToken } from "./rate-limit";

// The portal API behind the Space shell. Portal session only: the shell is the
// one place a human drives a Space, and an agent credential (API key, OAuth
// token) must not be able to act as a Space's viewer. See the admin scope
// (src/api/admin-scope.ts) for the same pattern, and
// docs/findings/2026-11-07-spaces-bridge.md for why the session itself is
// never handed to the Space.

const viewers = new WeakMap<object, Viewer>();

function viewerOf(request: object): Viewer {
  const v = viewers.get(request);
  if (!v) throw new Error("viewerOf called outside the spaces scope");
  return v;
}

interface ErrorBody {
  code: string;
  message: string;
  integration?: string;
  tool?: string;
  retryAfterMs?: number;
}

function fail(reply: FastifyReply, status: number, body: ErrorBody) {
  return reply.code(status).send(body);
}

function notFound(reply: FastifyReply) {
  return fail(reply, 404, { code: "NOT_FOUND", message: "This Space does not exist or was not shared with you." });
}

/**
 * The Space when the viewer may open it, else null (always answered as 404,
 * so names cannot be probed). A Space whose first upload has not landed is
 * not visible to anyone yet.
 */
async function openable(name: string, viewer: Viewer): Promise<Space | null> {
  const space = await getSpace(name);
  if (!space || !hasFiles(space.name)) return null;
  return (await canView(space, viewer)) ? space : null;
}

async function isConnected(integration: string, userId: string): Promise<boolean> {
  const integ = registry.getIntegration(integration);
  if (!integ) return false;
  if (integ.auth.type === "none") return true;
  if (integ.auth.type === "cookie") return hasValidCookies(userId, integration);
  return !!(await getToken(userId, integration));
}

function isInternal(tool: PluginTool): boolean {
  return isInternalIntegration(tool.integration);
}

/**
 * Resolve a requested tool to one of the Space's declared tools. Accepts the
 * fully-qualified name, or a bare suffix like /rest: with an integration hint,
 * `<integration>_<tool>` or a declared tool of that integration ending in
 * `_<tool>` (so `atlassian-bitbucket` + `list_prs` finds `bitbucket_list_prs`);
 * without one, the single declared tool ending in `_<tool>`. Never lands
 * outside the declared list.
 */
export function resolveDeclaredTool(declared: readonly string[], tool: unknown, integration?: unknown): string | null {
  if (typeof tool !== "string" || tool === "") return null;
  const hint = typeof integration === "string" && integration !== "" ? integration : undefined;
  const ofHint = (name: string) => !hint || registry.getTool(name)?.integration === hint;

  if (declared.includes(tool) && ofHint(tool)) return tool;
  if (hint && declared.includes(`${hint}_${tool}`)) return `${hint}_${tool}`;
  const suffix = `_${tool}`;
  const matches = declared.filter((d) => d.endsWith(suffix) && (hint ? registry.getTool(d)?.integration === hint : true));
  return matches.length === 1 ? matches[0] : null;
}

/** True when any string (or object key) anywhere in `value` contains `{{vault:`. */
export function containsVaultRef(value: unknown, depth = 0): boolean {
  if (depth > 64) return true; // absurd nesting: refuse rather than recurse forever
  if (typeof value === "string") return value.includes("{{vault:");
  if (Array.isArray(value)) return value.some((v) => containsVaultRef(v, depth + 1));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.includes("{{vault:")) return true;
      if (containsVaultRef(v, depth + 1)) return true;
    }
  }
  return false;
}

export async function registerSpaceApiRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (scope) => {
      // Authorization: Bearer <portal session JWT> only. The shared
      // authenticate() prefers x-workbench-api-key, so it is not used here and
      // that header is ignored. verifySession also refuses disabled users.
      scope.addHook("preHandler", async (request, reply) => {
        const auth = request.headers.authorization;
        let session: { userId: string; email: string } | null = null;
        if (typeof auth === "string" && auth.startsWith("Bearer ")) {
          try {
            session = await verifySession(auth.slice(7));
          } catch {
            session = null;
          }
        }
        if (!session) {
          return fail(reply, 401, { code: "UNAUTHENTICATED", message: "Sign in to the portal to open Spaces." });
        }
        // The email from the database, not the JWT: a token minted before an
        // email change must not keep matching the old share list.
        const user = await getUserById(session.userId);
        const email = user?.email ?? session.email ?? null;
        viewers.set(request, { userId: session.userId, email: email ? email.toLowerCase() : null });
        noteRequestAuth(request, "session");
      });

      scope.get("/", async (request) => {
        const viewer = viewerOf(request);
        const out = [];
        for (const s of await listAllSpaces()) {
          if (!hasFiles(s.name)) continue;
          if (!(await canView(s, viewer))) continue;
          out.push({
            name: s.name,
            title: s.title,
            description: s.description,
            ownerEmail: s.ownerEmail,
            visibility: s.visibility,
            updatedAt: s.updatedAt,
            mine: s.ownerId === viewer.userId,
          });
        }
        return { spaces: out };
      });

      scope.get<{ Params: { name: string } }>("/:name", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        const mine = space.ownerId === viewer.userId;

        const tools = [];
        for (const name of space.tools) {
          const tool = registry.getTool(name);
          const integ = tool ? registry.getIntegration(tool.integration) : undefined;
          if (!tool || !integ || isInternal(tool)) {
            tools.push({
              name,
              integration: "",
              integrationName: "",
              effect: "destructive" as const,
              connected: false,
              description: "",
              missing: true,
            });
            continue;
          }
          tools.push({
            name,
            integration: tool.integration,
            integrationName: integ.displayName ?? tool.integration,
            effect: effectOf(tool),
            connected: await isConnected(tool.integration, viewer.userId),
            description: tool.description ?? "",
          });
        }

        return {
          name: space.name,
          title: space.title,
          description: space.description,
          ownerEmail: await ownerEmailOf(space.ownerId),
          mine,
          visibility: space.visibility,
          users: mine ? await getShares(space.name) : [],
          updatedAt: space.updatedAt,
          tools,
          consented: await hasConsent(space, viewer.userId),
          appUrl: `/s/${space.name}/app/${mintSig(space.name, viewer.userId)}/`,
        };
      });

      scope.post<{ Params: { name: string } }>("/:name/consent", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        await grantConsent(space, viewer.userId);
        return { ok: true };
      });

      scope.delete<{ Params: { name: string } }>("/:name/consent", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        await revokeConsent(space.name, viewer.userId);
        return { ok: true };
      });

      scope.post<{ Params: { name: string } }>("/:name/call", async (request, reply) => {
        const viewer = viewerOf(request);
        const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;

        // 1. Access.
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);

        // 2. Consent to the current tool list.
        if (!(await hasConsent(space, viewer.userId))) {
          return fail(reply, 403, { code: "CONSENT_REQUIRED", message: "Approve this Space's tools first." });
        }

        // 3. Declared.
        const requested = typeof body.tool === "string" ? body.tool : undefined;
        const toolName = resolveDeclaredTool(space.tools, body.tool, body.integration);
        if (!toolName) {
          return fail(reply, 403, {
            code: "TOOL_NOT_DECLARED",
            message: `This Space did not declare ${requested ? `"${requested}"` : "that tool"}.`,
            ...(requested ? { tool: requested } : {}),
          });
        }

        // 4. Exists (plugin removed or integration disabled since deploy).
        const tool = registry.getTool(toolName);
        if (!tool || isInternal(tool)) {
          return fail(reply, 404, { code: "TOOL_UNAVAILABLE", message: `${toolName} is not available.`, tool: toolName });
        }

        // 5. Destructive calls need the shell's own confirmation.
        if (effectOf(tool) === "destructive" && body.confirmed !== true) {
          return fail(reply, 428, {
            code: "CONFIRMATION_REQUIRED",
            message: `${toolName} needs your confirmation.`,
            integration: tool.integration,
            tool: toolName,
          });
        }

        // 6. Arguments: an object, with no vault reference anywhere. Vault
        // references are never resolved for a Space (step 8 passes an empty
        // pre-substituted map); refusing them outright makes that loud.
        const args = body.args === undefined ? {} : body.args;
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          return fail(reply, 400, { code: "INVALID_ARGS", message: "args must be an object.", integration: tool.integration, tool: toolName });
        }
        if (containsVaultRef(args)) {
          return fail(reply, 400, {
            code: "INVALID_ARGS",
            message: "Vault references are not allowed in a Space.",
            integration: tool.integration,
            tool: toolName,
          });
        }

        // 7. Rate limit.
        const rate = takeToken(viewer.userId, space.name);
        if (!rate.ok) {
          return fail(reply, 429, {
            code: "RATE_LIMITED",
            message: "Too many calls. Try again shortly.",
            retryAfterMs: rate.retryAfterMs,
            integration: tool.integration,
            tool: toolName,
          });
        }

        // 8. Run as the viewer, attributed to the Space in the audit log.
        const audit = currentAuditContext();
        if (audit) audit.client_name = `space:${space.name}`;
        const outcome = await executeSingle(viewer.userId, toolName, args as Record<string, unknown>, new Map());
        if ("result" in outcome) return { result: outcome.result };
        if (outcome.error === "NOT_CONNECTED") {
          return fail(reply, 409, {
            code: "NOT_CONNECTED",
            message: outcome.message ?? `${tool.integration} is not connected.`,
            integration: outcome.integration ?? tool.integration,
            tool: toolName,
          });
        }
        if (outcome.error.startsWith("Invalid arguments for ")) {
          return fail(reply, 400, { code: "INVALID_ARGS", message: outcome.error, integration: tool.integration, tool: toolName });
        }
        return fail(reply, 502, {
          code: "UPSTREAM_ERROR",
          message: outcome.message ?? outcome.error,
          integration: tool.integration,
          tool: toolName,
        });
      });

      // ---- per-viewer KV: access and consent required ----

      const kvGate = async (request: FastifyRequest<{ Params: { name: string } }> | FastifyRequest<{ Params: { name: string; "*": string } }>, reply: FastifyReply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) {
          notFound(reply);
          return null;
        }
        if (!(await hasConsent(space, viewer.userId))) {
          fail(reply, 403, { code: "CONSENT_REQUIRED", message: "Approve this Space's tools first." });
          return null;
        }
        // Same bucket as /call: a Space cannot hammer the database through
        // the store any more than through its tools.
        const rate = takeToken(viewer.userId, space.name);
        if (!rate.ok) {
          fail(reply, 429, { code: "RATE_LIMITED", message: "Too many calls. Try again shortly.", retryAfterMs: rate.retryAfterMs });
          return null;
        }
        return { space, viewer };
      };

      // The key is the wildcard tail, not a :param: find-my-way caps params at
      // 100 characters (414 beyond), and keys may be up to 128.
      type KvParams = { name: string; "*": string };
      const keyOf = (request: FastifyRequest<{ Params: KvParams }>) => request.params["*"] ?? "";

      const badKey = (reply: FastifyReply) =>
        fail(reply, 400, { code: "INVALID_ARGS", message: "key must be 1 to 128 characters." });

      scope.get<{ Params: { name: string } }>("/:name/kv", async (request, reply) => {
        const g = await kvGate(request, reply);
        if (!g) return reply;
        return { keys: await kvKeys(g.space.name, g.viewer.userId) };
      });

      scope.get<{ Params: KvParams }>("/:name/kv/*", async (request, reply) => {
        const g = await kvGate(request, reply);
        if (!g) return reply;
        if (!isValidKvKey(keyOf(request))) return badKey(reply);
        const raw = await kvGet(g.space.name, g.viewer.userId, keyOf(request));
        // KEY_NOT_FOUND, not NOT_FOUND: the shell maps a missing key to
        // undefined, and must not confuse it with a Space that is gone.
        if (raw === null) return fail(reply, 404, { code: "KEY_NOT_FOUND", message: "No value for that key." });
        return { value: JSON.parse(raw) };
      });

      scope.put<{ Params: KvParams }>("/:name/kv/*", async (request, reply) => {
        const g = await kvGate(request, reply);
        if (!g) return reply;
        if (!isValidKvKey(keyOf(request))) return badKey(reply);
        const body = request.body as Record<string, unknown> | undefined;
        if (!body || typeof body !== "object" || !("value" in body) || body.value === undefined) {
          return fail(reply, 400, { code: "INVALID_ARGS", message: 'Body must be { "value": <any JSON> }.' });
        }
        const res = await kvPut(g.space.name, g.viewer.userId, keyOf(request), JSON.stringify(body.value));
        if (res === "TOO_LARGE") {
          return fail(reply, 413, {
            code: "TOO_LARGE",
            message: "Values are limited to 64 KiB each and 256 KiB per Space.",
          });
        }
        return { ok: true };
      });

      scope.delete<{ Params: KvParams }>("/:name/kv/*", async (request, reply) => {
        const g = await kvGate(request, reply);
        if (!g) return reply;
        if (!isValidKvKey(keyOf(request))) return badKey(reply);
        await kvDelete(g.space.name, g.viewer.userId, keyOf(request));
        return { ok: true };
      });
    },
    { prefix: "/api/spaces" }
  );
}
