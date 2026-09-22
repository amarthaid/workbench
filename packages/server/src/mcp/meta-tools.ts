import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registry } from "../plugins/registry";
import { createContext } from "../plugins/context";
import { auditLogger } from "../audit/logger";
import { getToken } from "../auth/tokens";
import { getToolForUser, searchForUser, type IndexedTool } from "../custom-apps/index";
import { getCustomApp, listCustomApps, integrationKey } from "../custom-apps/store";
import { ensureCustomAppToken } from "../custom-apps/oauth";
import { callRemoteTool } from "../custom-apps/client";
import { getUserById } from "../auth/users";
import { hasValidCookies } from "../auth/cookie";
import { withSpan } from "../telemetry/tracing";
import { toolExecutionsTotal, toolExecutionDuration } from "../telemetry/metrics";
import { config } from "../config";
import { createPending, getPending, reapOne } from "../auth/connections";
import { signConnectToken } from "../auth/connect-token";
import { signCurlToken } from "../auth/curl-session";
import { resolveVaultRefs, scrubVaultValues, scrubString, VaultRefError, VaultScrubError } from "../vault/interpolate";
import { touchUsed } from "../vault/store";
import { rememberSubstituted, recentSubstituted } from "../vault/recent";

// `connect` and `get_auth_url` are the same tool under two names (kept for
// backward compatibility) — one description, so the security claim in it
// can't drift between the two copies.
const CONNECT_DESCRIPTION =
  "Begin connecting an integration. Returns a connectionId and a workbench URL for the user to open. The user must be signed in to workbench as the same account this agent is connected to; the link will not work for anyone else. Call wait_for_connection afterward.";

// A ring value shorter than this only scrubs as a whole-string match, never
// as a substring inside unrelated prose — see the `substringOk` build below.
const VAULT_RECENT_SUBSTRING_MIN_LEN = 8;

// Shape of a meta-tool definition. `inputSchema` is a real Zod schema so we
// can call `.safeParse` directly without hand-rolled casts. `handler` is kept
// loosely typed because each tool has its own ctx/args signature.
interface MetaTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (ctx: never, args: never) => Promise<unknown>;
}

async function startConnect(
  userId: string,
  integration: string
): Promise<
  | { connectionId: string; type: "oauth2" | "cookie"; url: string }
  | { error: string }
> {
  const integ = registry.getIntegration(integration);
  if (!integ) return { error: "Integration not found" };
  if (integ.auth.type === "none") {
    return { error: `${integration} is built-in and always connected — no connect needed.` };
  }
  const ttl = config.CONNECT_TTL_SECONDS;
  if (integ.auth.type !== "cookie" && integ.auth.type !== "oauth2") {
    return { error: `${integration} cannot be connected from the agent — connect it from the portal.` };
  }

  // The link is a claim, not a capability: it names the integration and the
  // workbench user it was minted for, and nothing else. Warming a browser
  // session or building a provider consent URL happens at /api/connect/redeem,
  // once a human has proved they own this account.
  const rec = createPending({ userId, integration, type: integ.auth.type, ttlSeconds: ttl });
  const jwt = await signConnectToken(
    { connectionId: rec.connectionId, userId, integration, sessionId: userId },
    ttl
  );
  return {
    connectionId: rec.connectionId,
    type: integ.auth.type,
    url: `${config.PORTAL_URL}/connect/${integration}?t=${jwt}`,
  };
}

// Core single-tool execution: connection check, schema validation, audit, run.
// The per-item engine behind `execute_tools` (batch) and the REST endpoint
// (`POST /rest/:integration`). Never throws — failures come back as { error }.
export type ExecResult = { result: unknown } | { error: string; integration?: string; message?: string };

const STEP_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STEP_REF_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;

class ComposeRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeRefError";
  }
}

function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function resolveStepRefs(value: unknown, results: Map<string, unknown>): unknown {
  if (typeof value === "string") {
    const m = STEP_REF_RE.exec(value);
    if (!m) return value;
    const id = m[1];
    if (!results.has(id)) throw new ComposeRefError(`unknown step '${id}'`);
    const path = m[2] ? m[2].slice(1).split(".") : [];
    if (path.length === 0) return results.get(id);
    const got = getPath(results.get(id), path);
    if (got === undefined) throw new ComposeRefError(`missing '${id}.${path.join(".")}'`);
    return got;
  }
  if (Array.isArray(value)) return value.map((v) => resolveStepRefs(v, results));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveStepRefs(v, results);
    }
    return out;
  }
  return value;
}

function pickComposeReturn(
  results: Map<string, unknown>,
  paths: string[]
): ExecResult {
  const data: Record<string, unknown> = {};
  for (const raw of paths) {
    const parts = raw.split(".");
    const id = parts[0];
    if (!id || !results.has(id)) return { error: `BAD_REF: unknown step '${id ?? raw}'` };
    const val = parts.length === 1 ? results.get(id) : getPath(results.get(id), parts.slice(1));
    if (val === undefined) return { error: `BAD_REF: missing '${raw}'` };
    let cursor = data;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      const next = cursor[key];
      if (!next || typeof next !== "object") cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = val;
  }
  return { result: data };
}

export type ComposeStep = { id: string; tool: string; args?: Record<string, unknown> };

// Sequential pipe: each step may read earlier results via `$id.field` (whole
// arg values only). Intermediate blobs stay in-process. The agent sees only
// `return` paths, so a CSV/file body never has to enter the chat.
export async function composeTools(
  userId: string,
  steps: ComposeStep[],
  returnPaths: string[]
): Promise<ExecResult> {
  const seen = new Set<string>();
  for (const step of steps) {
    if (!STEP_ID_RE.test(step.id)) return { error: `Invalid step id '${step.id}'` };
    if (seen.has(step.id)) return { error: `Duplicate step id '${step.id}'` };
    seen.add(step.id);
  }

  const results = new Map<string, unknown>();
  for (const step of steps) {
    let args: Record<string, unknown>;
    try {
      args = resolveStepRefs(step.args ?? {}, results) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof ComposeRefError) return { error: `BAD_REF: ${e.message}` };
      throw e;
    }
    const out = await executeSingle(userId, step.tool, args);
    if ("error" in out) return out;
    results.set(step.id, out.result);
  }
  return pickComposeReturn(results, returnPaths);
}

export async function executeSingle(
  userId: string,
  toolName: string,
  rawArgs: Record<string, unknown>
): Promise<ExecResult> {
  const targetTool = registry.getTool(toolName);
  if (!targetTool) {
    const appTool = await getToolForUser(userId, toolName);
    if (appTool) return executeCustomAppSingle(userId, appTool, rawArgs);
  }
  return withSpan(
    "execute_single",
    async () => {
      const start = Date.now();

      if (!targetTool) {
        await auditLogger.log({
          user_id: userId,
          tool: toolName,
          action: "EXECUTE",
          success: false,
          error: "Tool not found",
          duration_ms: Date.now() - start,
        });
        return { error: "Tool not found" };
      }

      const integ = registry.getIntegration(targetTool.integration);
      const isConnected =
        integ?.auth.type === "none"
          ? true
          : integ?.auth.type === "cookie"
            ? await hasValidCookies(userId, targetTool.integration)
            : !!(await getToken(userId, targetTool.integration));

      if (!isConnected) {
        await auditLogger.log({
          user_id: userId,
          integration: targetTool.integration,
          tool: toolName,
          action: "EXECUTE",
          success: false,
          error: "NOT_CONNECTED",
          duration_ms: Date.now() - start,
        });
        return {
          error: "NOT_CONNECTED",
          integration: targetTool.integration,
          message: `${targetTool.integration} not connected. Use connect('${targetTool.integration}') to connect.`,
        };
      }

      // Vault references: `{{vault:name}}` → value, before validation so the
      // tool's own zod coercion still applies. The vault's own tools take names
      // as arguments, so a reference there is literal, not a lookup.
      let effectiveArgs: Record<string, unknown> = rawArgs ?? {};
      let substituted = new Map<string, string>();
      if (!toolName.startsWith("vault_")) {
        try {
          const resolved = await resolveVaultRefs(userId, effectiveArgs);
          effectiveArgs = resolved.args;
          substituted = resolved.substituted;
        } catch (e) {
          if (e instanceof VaultRefError) {
            await auditLogger.log({
              user_id: userId,
              integration: targetTool.integration,
              tool: toolName,
              action: "EXECUTE",
              success: false,
              error: e.code,
              duration_ms: Date.now() - start,
            });
            return { error: e.code, message: e.message };
          }
          throw e;
        }
        if (substituted.size > 0) {
          void touchUsed(userId, [...substituted.keys()]).catch(() => undefined);
        }
      }

      // Values substituted in earlier calls within the recent window. Read
      // the ring BEFORE remembering this call's own substitutions, so a name
      // reused across calls with a different value (e.g. a secret rotated
      // mid-session) still scrubs the stale value too, not just the fresh
      // one.
      const recent = recentSubstituted(userId);
      if (substituted.size > 0) rememberSubstituted(userId, substituted);

      // ONE combined list for scrubString/scrubVaultValues below, not two
      // sequential calls: sequential passes defeat the longest-value-first
      // ordering across the substituted/recent boundary (a short ring value
      // can eat part of a longer current-call value first) and can corrupt
      // an already-inserted `{{vault:name}}` placeholder if a later pass's
      // value happens to appear inside that syntax (e.g. the literal
      // "vault"). Deduped by VALUE, not name, so the same name with two
      // different values (the rotation case above) keeps both entries, and
      // an identical value in both sources keeps the current call's name —
      // first occurrence wins, and `substituted` is listed first.
      //
      // `substringOk` holds every value allowed to match inside a larger
      // string. This call's own substitutions always qualify (the agent
      // just opted into using them). A ring value only qualifies once it's
      // at least VAULT_RECENT_SUBSTRING_MIN_LEN chars — a short remembered
      // value (a PIN, a port) otherwise only scrubs where it is the WHOLE
      // string, not wherever it happens to appear in unrelated prose. See
      // docs/site/_content/integrations/vault.md for the trade-off this
      // accepts (a confirmation oracle, disclosed there) in exchange for not
      // over-scrubbing.
      const seenScrubValues = new Set<string>();
      const scrubEntries: Array<readonly [string, string]> = [];
      const substringOk = new Set<string>();
      for (const [name, value] of substituted) {
        if (value === "") continue;
        substringOk.add(value);
        if (!seenScrubValues.has(value)) {
          seenScrubValues.add(value);
          scrubEntries.push([name, value]);
        }
      }
      for (const [name, value] of recent) {
        if (value === "") continue;
        if (value.length >= VAULT_RECENT_SUBSTRING_MIN_LEN) substringOk.add(value);
        if (!seenScrubValues.has(value)) {
          seenScrubValues.add(value);
          scrubEntries.push([name, value]);
        }
      }

      // Validate args against the plugin tool's own schema so that
      // Zod defaults (e.g. pageSize=10) get applied. Without this,
      // we'd blindly forward whatever the caller sent and the plugin
      // would see `undefined` for optional-with-default fields.
      let parsedArgs: unknown = effectiveArgs;
      try {
        const parsed = targetTool.inputSchema.safeParse(effectiveArgs);
        if (!parsed.success) {
          await auditLogger.log({
            user_id: userId,
            integration: targetTool.integration,
            tool: toolName,
            action: "EXECUTE",
            success: false,
            error: "INVALID_ARGS",
            duration_ms: Date.now() - start,
          });
          return {
            error: `Invalid arguments for ${toolName}: ${scrubString(parsed.error?.message ?? "schema mismatch", scrubEntries, substringOk)}`,
          };
        }
        parsedArgs = parsed.data;
      } catch (e) {
        // Unexpected throw during schema parsing (e.g. a malformed schema).
        // Don't swallow silently: record it observably, then fall through
        // with raw args so execution still proceeds.
        const err = scrubString(e instanceof Error ? e.message : String(e), scrubEntries, substringOk);
        await auditLogger.log({
          user_id: userId,
          integration: targetTool.integration,
          tool: toolName,
          action: "EXECUTE",
          success: false,
          error: `SAFEPARSE_ERROR: ${err}`,
          duration_ms: Date.now() - start,
        });
      }

      try {
        const toolCtx = await createContext(userId, targetTool.integration);
        const result = scrubVaultValues(
          await targetTool.handler(toolCtx, parsedArgs as Record<string, unknown>),
          scrubEntries,
          substringOk
        );
        const duration_ms = Date.now() - start;
        await auditLogger.log({
          user_id: userId,
          integration: targetTool.integration,
          tool: toolName,
          action: "EXECUTE",
          success: true,
          duration_ms,
        });
        console.log(JSON.stringify({
          level: 30,
          msg: "tool executed",
          user_id: userId,
          integration: targetTool.integration,
          tool: toolName,
          success: true,
          duration_ms,
        }));
        const durationS = duration_ms / 1000;
        toolExecutionsTotal.inc({ integration: targetTool.integration, tool: toolName, success: "true" });
        toolExecutionDuration.observe({ integration: targetTool.integration, tool: toolName, success: "true" }, durationS);
        return { result };
      } catch (e) {
        if (e instanceof VaultScrubError) {
          // The result could not be scrubbed structurally (e.g. a BigInt or
          // circular value the handler returned). Never fall back to
          // returning it unscrubbed — fail closed instead.
          const duration_ms = Date.now() - start;
          await auditLogger.log({
            user_id: userId,
            integration: targetTool.integration,
            tool: toolName,
            action: "EXECUTE",
            success: false,
            error: e.code,
            duration_ms,
          });
          // Same failure line and metrics as the generic path: a fail-closed
          // scrub is still a failed tool call, and if it were invisible here
          // the only signal would be the model's own error text. No args and
          // no result — the reason we are in this branch is that the result
          // could not be made safe to print.
          console.log(JSON.stringify({
            level: 50,
            msg: "tool execute failed",
            user_id: userId,
            integration: targetTool.integration,
            tool: toolName,
            success: false,
            error: e.code,
            duration_ms,
          }));
          const durationS = duration_ms / 1000;
          toolExecutionsTotal.inc({ integration: targetTool.integration, tool: toolName, success: "false" });
          toolExecutionDuration.observe({ integration: targetTool.integration, tool: toolName, success: "false" }, durationS);
          return { error: e.code };
        }
        const err = scrubString(e instanceof Error ? e.message : String(e), scrubEntries, substringOk);
        const duration_ms = Date.now() - start;
        await auditLogger.log({
          user_id: userId,
          integration: targetTool.integration,
          tool: toolName,
          action: "EXECUTE",
          success: false,
          error: err,
          duration_ms,
        });
        console.log(JSON.stringify({
          level: 50,
          msg: "tool execute failed",
          user_id: userId,
          integration: targetTool.integration,
          tool: toolName,
          success: false,
          error: err,
          duration_ms,
        }));
        const durationS = duration_ms / 1000;
        toolExecutionsTotal.inc({ integration: targetTool.integration, tool: toolName, success: "false" });
        toolExecutionDuration.observe({ integration: targetTool.integration, tool: toolName, success: "false" }, durationS);
        return { error: err };
      }
    },
    { tool: toolName, integration: targetTool?.integration || "unknown" }
  );
}

// CustomApp execution: an external MCP server registered per-user. Args pass
// through unvalidated (JSON Schema, no zod) — the remote server rejects bad
// args. Vault refs still interpolate and the result is still scrub-checked.
// ponytail: does not wire the recent-substitution ring (scrub covers this
// call's substitutions only) and does not render image blocks (data dropped
// to a marker). Add both if custom apps start round-tripping vault values or
// returning images.
export async function executeCustomAppSingle(
  userId: string,
  tool: IndexedTool,
  rawArgs: Record<string, unknown>
): Promise<ExecResult> {
  return withSpan(
    "execute_custom_app",
    async () => {
      const start = Date.now();

      const app = await getCustomApp(userId, tool.appId);
      if (!app) {
        return { error: "CustomApp not found" };
      }

      let accessToken: string;
      try {
        accessToken = await ensureCustomAppToken(userId, app);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await auditLogger.log({
          user_id: userId,
          integration: tool.integration,
          tool: tool.name,
          action: "EXECUTE",
          success: false,
          error: message,
          duration_ms: Date.now() - start,
        });
        return { error: message, integration: tool.integration };
      }

      let effectiveArgs: Record<string, unknown> = rawArgs ?? {};
      let substituted = new Map<string, string>();
      try {
        const resolved = await resolveVaultRefs(userId, effectiveArgs);
        effectiveArgs = resolved.args;
        substituted = resolved.substituted;
      } catch (e) {
        if (e instanceof VaultRefError) {
          return { error: e.code, message: e.message };
        }
        throw e;
      }
      if (substituted.size > 0) {
        void touchUsed(userId, [...substituted.keys()]).catch(() => undefined);
      }

      const scrubEntries: Array<readonly [string, string]> = [];
      const substringOk = new Set<string>();
      for (const [name, value] of substituted) {
        if (value === "") continue;
        substringOk.add(value);
        scrubEntries.push([name, value]);
      }

      try {
        const result = scrubVaultValues(
          await callRemoteTool(userId, app.baseUrl, accessToken, tool.remoteName, effectiveArgs),
          scrubEntries,
          substringOk
        ) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
        const duration_ms = Date.now() - start;

        if (result.isError) {
          // The remote MCP server reported a failed tool call — audit, metrics
          // and REST status must reflect that, not a 200 "success".
          const errText = (result.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
            .slice(0, 500) || "Remote tool returned isError";
          await auditLogger.log({
            user_id: userId,
            integration: tool.integration,
            tool: tool.name,
            action: "EXECUTE",
            success: false,
            error: errText,
            duration_ms,
          });
          const durationS = duration_ms / 1000;
          toolExecutionsTotal.inc({ integration: tool.integration, tool: tool.name, success: "false" });
          toolExecutionDuration.observe({ integration: tool.integration, tool: tool.name, success: "false" }, durationS);
          return { error: errText };
        }

        await auditLogger.log({
          user_id: userId,
          integration: tool.integration,
          tool: tool.name,
          action: "EXECUTE",
          success: true,
          duration_ms,
        });
        const durationS = duration_ms / 1000;
        toolExecutionsTotal.inc({ integration: tool.integration, tool: tool.name, success: "true" });
        toolExecutionDuration.observe({ integration: tool.integration, tool: tool.name, success: "true" }, durationS);
        return { result };
      } catch (e) {
        const err = scrubString(e instanceof Error ? e.message : String(e), scrubEntries, substringOk);
        const duration_ms = Date.now() - start;
        await auditLogger.log({
          user_id: userId,
          integration: tool.integration,
          tool: tool.name,
          action: "EXECUTE",
          success: false,
          error: err,
          duration_ms,
        });
        const durationS = duration_ms / 1000;
        toolExecutionsTotal.inc({ integration: tool.integration, tool: tool.name, success: "false" });
        toolExecutionDuration.observe({ integration: tool.integration, tool: tool.name, success: "false" }, durationS);
        return { error: err };
      }
    },
    { tool: tool.name, integration: tool.integration }
  );
}

// Batch execution engine, shared by the `execute_tools` meta-tool and the REST
// endpoint so both get identical semantics: bounded concurrency, index-aligned
// results, and one failing item never aborting the rest.
export async function executeMany(
  userId: string,
  executions: { tool: string; args?: Record<string, unknown> }[]
): Promise<{ results: ExecResult[] }> {
  const results: ExecResult[] = new Array(executions.length);
  // Bounded worker pool: cap concurrency so a large batch can't open an
  // unbounded number of upstream connections at once. Results stay ordered
  // because each worker writes to its claimed index.
  const CONCURRENCY = 8;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= executions.length) return;
      const ex = executions[i];
      results[i] = await executeSingle(userId, ex.tool, ex.args ?? {});
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, executions.length) }, () => worker())
  );
  return { results };
}

// `satisfies` (not an explicit annotation) keeps each element's `name` as a
// string literal, so `metaToolSchemas` below can require exactly these keys.
export const metaTools = [
  {
    name: "search_tools",
    description: "Search available tools by name or description",
    inputSchema: z.object({ query: z.string() }),
    handler: async (ctx: { userId: string }, args: { query: string }) => {
      const builtin = registry.searchTools(args.query).map((t) => ({
        name: t.name,
        description: t.description,
        integration: t.integration,
      }));
      const customApps = (await searchForUser(ctx.userId, args.query)).map((t) => ({
        name: t.name,
        description: t.description,
        integration: t.integration,
      }));
      return { tools: [...builtin, ...customApps] };
    },
  },
  {
    name: "get_tool_schema",
    description: "Get input schema for a specific tool",
    inputSchema: z.object({ tool: z.string() }),
    handler: async (ctx: { userId: string }, args: { tool: string }) => {
      const t = registry.getTool(args.tool);
      if (t) {
        // Return portable JSON Schema, not raw Zod internals, so any MCP client
        // can consume it without Zod knowledge. Non-Zod schemas pass through.
        const schema =
          t.inputSchema instanceof z.ZodType
            ? zodToJsonSchema(t.inputSchema as z.ZodTypeAny)
            : t.inputSchema;
        return { schema };
      }
      const ct = await getToolForUser(ctx.userId, args.tool);
      if (!ct) return { error: "Tool not found" };
      return { schema: ct.inputSchema };
    },
  },
  {
    name: "execute_tools",
    description:
      "Execute one or more tools in a single call. Runs them concurrently (bounded) and returns a `results` array in the same order as `executions`. A single tool failing does not abort the others — its entry carries an `error` instead of a `result`. For a single tool, pass a one-element `executions` array.",
    inputSchema: z.object({
      executions: z
        .array(z.object({ tool: z.string(), args: z.record(z.unknown()).default({}) }))
        .min(1),
    }),
    handler: (
      ctx: { userId: string },
      args: { executions: { tool: string; args: Record<string, unknown> }[] }
    ) => executeMany(ctx.userId, args.executions),
  },
  {
    name: "whoami",
    description: "Return the current authenticated workbench user (id + email). Like /me — identity only, not connected integrations.",
    inputSchema: z.object({}),
    handler: async (ctx: { userId: string }) => {
      const user = await getUserById(ctx.userId);
      if (!user) return { error: "User not found" };
      return { id: user.id, email: user.email };
    },
  },
  {
    name: "list_integrations",
    description: "List all available integrations and connection status",
    inputSchema: z.object({}),
    handler: async (ctx: { userId: string }) => {
      const integrations = registry.listIntegrations();
      const items = await Promise.all(
        integrations.map(async (i) => ({
          name: i.name,
          version: i.version,
          connected:
            i.auth.type === "none"
              ? true
              : i.auth.type === "cookie"
                ? await hasValidCookies(ctx.userId, i.name)
                : !!(await getToken(ctx.userId, i.name)),
        }))
      );
      const customApps = await listCustomApps(ctx.userId);
      const customAppItems = await Promise.all(
        customApps.map(async (c) => ({
          // Same key as search_tools/execute_tools (`custom:<id>`), so agents
          // see one consistent identifier.
          name: integrationKey(c.id),
          version: "MCP",
          connected: !!(await getToken(ctx.userId, integrationKey(c.id))),
        }))
      );
      return { integrations: [...items, ...customAppItems] };
    },
  },
  {
    name: "connect",
    description: CONNECT_DESCRIPTION,
    inputSchema: z.object({ integration: z.string() }),
    handler: (ctx: { userId: string }, args: { integration: string }) => startConnect(ctx.userId, args.integration),
  },
  {
    name: "wait_for_connection",
    description: "Block until a connection started by connect() completes. Returns status CONNECTED, TIMEOUT, or EXPIRED.",
    inputSchema: z.object({ connectionId: z.string(), timeoutSec: z.number().int().positive().max(900).default(300) }),
    handler: async (ctx: { userId: string }, args: { connectionId: string; timeoutSec: number }) => {
      const deadline = Date.now() + args.timeoutSec * 1000;
      for (;;) {
        const rec = getPending(args.connectionId);
        if (!rec) return { error: "Unknown connectionId" };
        if (rec.userId !== ctx.userId) return { error: "Unknown connectionId" }; // same shape — no existence oracle
        if (rec.status === "CONNECTED") return { status: "CONNECTED" };
        if (rec.status === "EXPIRED") return { status: "EXPIRED" };
        if (Date.now() >= deadline) { await reapOne(args.connectionId); return { status: "TIMEOUT" }; }
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
  },
  {
    name: "get_auth_url",
    description: CONNECT_DESCRIPTION,
    inputSchema: z.object({ integration: z.string() }),
    handler: (ctx: { userId: string }, args: { integration: string }) => startConnect(ctx.userId, args.integration),
  },
  {
    name: "compose",
    description:
      "Run tools sequentially and pass data between them. Each step may use `$id.field` " +
      "as a whole argument value to read an earlier step's result (e.g. content: \"$export.csv\"). " +
      "Intermediate payloads stay on the server. Only the paths in `return` are sent back — " +
      "omit fat fields (csv, content, bytes) so they never enter the chat.",
    inputSchema: z.object({
      steps: z
        .array(
          z.object({
            id: z.string().regex(STEP_ID_RE, "step id must be a JS identifier"),
            tool: z.string(),
            args: z.record(z.unknown()).default({}),
          })
        )
        .min(2)
        .max(8),
      return: z.array(z.string().min(1)).min(1),
    }),
    handler: async (
      ctx: { userId: string },
      args: { steps: ComposeStep[]; return: string[] }
    ) => {
      const out = await composeTools(ctx.userId, args.steps, args.return);
      if ("error" in out) return out;
      return out.result;
    },
  },
  {
    name: "curl_session",
    description:
      "HIGH RISK — do not call without explicit user approval. Mints a short-lived (15 min) proxy token granting ARBITRARY API calls (GET/POST/PUT/PATCH/DELETE), including destructive writes, against the listed integration(s) — the proxy injects the user's real credential transparently at /c/<integration>/<path>, so anything reachable via that credential is reachable through this token. Before invoking, tell the user exactly which integration(s) and what action you intend to perform, and wait for their explicit go-ahead; do not mint speculatively or as a default first step. Only integrations that have curl proxy enabled are accepted.",
    inputSchema: z.object({
      integrations: z.array(z.string()).min(1),
    }),
    handler: async (ctx: { userId: string }, args: { integrations: string[] }) => {
      const EXPIRES_SECONDS = 900;
      const errors: string[] = [];
      for (const name of args.integrations) {
        const integ = registry.getIntegration(name);
        if (!integ) { errors.push(`${name}: integration not found`); continue; }
        if (!integ.proxy) { errors.push(`${name}: curl proxy not enabled`); continue; }
        const isConnected =
          integ.auth.type === "none"
            ? true
            : integ.auth.type === "cookie"
              ? await hasValidCookies(ctx.userId, name)
              : !!(await getToken(ctx.userId, name));
        if (!isConnected) errors.push(`${name}: not connected`);
      }
      if (errors.length) return { error: errors.join("; ") };
      const token = await signCurlToken(ctx.userId, args.integrations, EXPIRES_SECONDS);
      return {
        token,
        expiresIn: EXPIRES_SECONDS,
        proxyBaseUrl: `${config.SERVER_PUBLIC_URL}/c`,
        usage: `Send requests to ${config.SERVER_PUBLIC_URL}/c/<integration>/<path> with Authorization: Bearer <token>`,
      };
    },
  },
] satisfies readonly MetaTool[];

// JSON Schema descriptions for the meta-tools, surfaced via MCP `tools/list`.
// Kept here so the tool definitions and their wire schemas stay co-located.
// Keyed by tool name so adding a meta-tool without a wire schema is a
// compile error rather than a silent fallback in tools/list.
export const metaToolSchemas: Record<(typeof metaTools)[number]["name"], Record<string, unknown>> = {
  search_tools: {
    type: "object",
    properties: { query: { type: "string", description: "Search keyword" } },
    required: ["query"],
  },
  get_tool_schema: {
    type: "object",
    properties: { tool: { type: "string", description: "Tool name" } },
    required: ["tool"],
  },
  execute_tools: {
    type: "object",
    properties: {
      executions: {
        type: "array",
        description: "Tools to run; results are returned in this same order.",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Tool name returned by search_tools" },
            args: { type: "object", description: "Arguments for the tool", additionalProperties: true },
          },
          required: ["tool"],
        },
      },
    },
    required: ["executions"],
  },
  whoami: { type: "object", properties: {} },
  list_integrations: { type: "object", properties: {} },
  connect: {
    type: "object",
    properties: { integration: { type: "string", description: "Integration name" } },
    required: ["integration"],
  },
  wait_for_connection: {
    type: "object",
    properties: {
      connectionId: { type: "string", description: "ID returned by connect()" },
      timeoutSec: { type: "number", description: "Max seconds to wait (default 300)" },
    },
    required: ["connectionId"],
  },
  get_auth_url: {
    type: "object",
    properties: { integration: { type: "string", description: "Integration name" } },
    required: ["integration"],
  },
  compose: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Tools to run in order. Later steps read earlier results via $id.field.",
        minItems: 2,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Step id; referenced as $id.field" },
            tool: { type: "string", description: "Tool name returned by search_tools" },
            args: { type: "object", description: "Arguments; string values matching $id.field are substituted", additionalProperties: true },
          },
          required: ["id", "tool"],
        },
      },
      return: {
        type: "array",
        items: { type: "string" },
        description: "Result paths to return (e.g. upload.id, export.row_count). Fat fields should be omitted.",
      },
    },
    required: ["steps", "return"],
  },
  curl_session: {
    type: "object",
    properties: {
      integrations: {
        type: "array",
        items: { type: "string" },
        description: "Integration names to include in the session (e.g. [\"github\"])",
      },
    },
    required: ["integrations"],
  },
};
