import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registry } from "../plugins/registry";
import { createContext } from "../plugins/context";
import { auditLogger } from "../audit/logger";
import { getToken } from "../auth/tokens";
import { ensureIndex, getToolForUser, type IndexedTool } from "../custom-apps/index";
import { rankTools } from "../plugins/search";
import { getCustomApp, listCustomApps, integrationKey, isCustomAppConnected } from "../custom-apps/store";
import { resolveAuthHeaders, upstreamAuthHint, redactHeaderValues } from "../custom-apps/auth";
import { callRemoteTool } from "../custom-apps/client";
import { getUserById } from "../auth/users";
import { hasValidCookies } from "../auth/cookie";
import { ensureCookieSession } from "../auth/reconnect/runner";
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
export type ExecResult =
  | { result: unknown }
  | { error: string; integration?: string; message?: string; ref_id?: string };

// `ref_id` names an execution so `{{step:<ref_id>.path}}` (and `return`) can
// read its result. Same grammar as the id segment of the ref itself.
const REF_ID_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const REF_ID_RE = new RegExp(REF_ID_PATTERN);
const REF_ID_MAX = 64;
const COMPOSE_MAX_EXECUTIONS = 8;
// Compose templates: `{{step:id.path}}` reads an earlier step's result,
// `{{vault:NAME}}` a secret (same name grammar as vault/interpolate.ts). Both
// are matched in ONE pass over the agent-written string, so a value inserted
// for one ref is never re-scanned for another. That is the point: a tool
// output carrying the text `{{vault:x}}` (a PR title, a CSV cell) must reach
// the next tool as that literal text, never as the secret.
const TEMPLATE_REF_RE =
  /\{\{vault:([a-z0-9][a-z0-9_.-]{0,63})\}\}|\{\{step:([A-Za-z_][A-Za-z0-9_]*)((?:\.[^.{}\s]+)*)\}\}/g;
const WHOLE_STEP_REF_RE = /^\{\{step:([A-Za-z_][A-Za-z0-9_]*)((?:\.[^.{}\s]+)*)\}\}$/;
const STEP_REF_OPEN = "{{step:";

class ComposeRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeRefError";
  }
}

// Own properties only: `{{step:a.constructor}}` or `{{step:a.__proto__}}`
// would otherwise resolve to something that was never in the step result.
function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object" || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function lookupStep(id: string, rawPath: string, results: Map<string, unknown>): unknown {
  if (!results.has(id)) throw new ComposeRefError(`unknown step '${id}'`);
  const path = rawPath ? rawPath.slice(1).split(".") : [];
  const got = getPath(results.get(id), path);
  if (got === undefined) throw new ComposeRefError(`missing '${[id, ...path].join(".")}'`);
  return got;
}

// `vault` null leaves `{{vault:...}}` as literal text (vault_* tools, custom
// apps, the return template).
function resolveTemplate(
  value: unknown,
  results: Map<string, unknown>,
  vault: Map<string, string> | null
): unknown {
  if (typeof value === "string") {
    if (value.replace(TEMPLATE_REF_RE, "").includes(STEP_REF_OPEN)) {
      throw new ComposeRefError(`malformed ref in '${value}'`);
    }
    // A whole-value step ref keeps the result's own type (number, object, ...).
    const whole = WHOLE_STEP_REF_RE.exec(value);
    if (whole) return lookupStep(whole[1], whole[2], results);
    return value.replace(TEMPLATE_REF_RE, (m, vaultName?: string, id?: string, path?: string) => {
      if (vaultName !== undefined) return vault?.get(vaultName) ?? m;
      const got = lookupStep(id!, path ?? "", results);
      return typeof got === "string" ? got : JSON.stringify(got);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, results, vault));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTemplate(v, results, vault);
    }
    return out;
  }
  return value;
}

export type Execution = { ref_id?: string; tool: string; args?: Record<string, unknown> };

function badRef(e: unknown): string {
  if (e instanceof ComposeRefError) return `BAD_REF: ${e.message}`;
  throw e;
}

// `execute_tools` with `compose: true`: run executions in order, each reading
// earlier results via `{{step:<ref_id>.path}}`. Intermediate payloads stay
// in-process; only the resolved `return` template (or, without one, the last
// result) goes back to the agent, so a CSV/file body never has to enter the
// chat. Stops at the first failing step. The schema has already enforced a
// valid, unique `ref_id` on every execution.
export async function composeTools(
  userId: string,
  steps: Execution[],
  ret: unknown
): Promise<ExecResult> {
  const results = new Map<string, unknown>();
  let last: unknown;
  for (const step of steps) {
    const refId = step.ref_id!;
    const template = step.args ?? {};
    // Vault refs resolve here, against the agent's template only, and the
    // map is handed down so neither plugin nor custom-app execution scans the
    // step-resolved args again. vault_* tools take names literally.
    let vault: Map<string, string> | null = null;
    if (!step.tool.startsWith("vault_")) {
      try {
        vault = (await resolveVaultRefs(userId, template)).substituted;
      } catch (e) {
        if (e instanceof VaultRefError) return { error: e.code, message: e.message, ref_id: refId };
        throw e;
      }
    }
    let args: Record<string, unknown>;
    try {
      args = resolveTemplate(template, results, vault) as Record<string, unknown>;
    } catch (e) {
      return { error: badRef(e), ref_id: refId };
    }
    const out = await executeSingle(userId, step.tool, args, vault ?? undefined);
    if ("error" in out) return { ...out, ref_id: refId };
    results.set(refId, out.result);
    last = out.result;
  }
  if (ret === undefined) return { result: last };
  try {
    return { result: resolveTemplate(ret, results, null) };
  } catch (e) {
    return { error: badRef(e) };
  }
}

type ExecutionFailure = { index: number; ref_id?: string } & Extract<ExecResult, { error: string }>;
export type ProjectedResult =
  | { result: unknown; errors?: ExecutionFailure[] }
  | { error: string; errors?: ExecutionFailure[] };

// `return` without `compose`: a normal concurrent batch, then the template is
// resolved over the finished results keyed by `ref_id`. Args are not
// interpolated (that is compose's job). Failed executions are listed under
// `errors` — a projection that only names the successful ones would
// otherwise hide a failed write.
export async function projectBatch(
  userId: string,
  executions: Execution[],
  ret: unknown
): Promise<ProjectedResult> {
  const { results } = await executeMany(userId, executions);
  const byRef = new Map<string, unknown>();
  const errors: ExecutionFailure[] = [];
  results.forEach((r, index) => {
    const refId = executions[index].ref_id;
    if ("error" in r) errors.push({ index, ...(refId ? { ref_id: refId } : {}), ...r });
    else if (refId) byRef.set(refId, r.result);
  });
  const withErrors = errors.length > 0 ? { errors } : {};
  try {
    return { result: resolveTemplate(ret, byRef, null), ...withErrors };
  } catch (e) {
    return { error: badRef(e), ...withErrors };
  }
}

const executeToolsInput = z
  .object({
    executions: z
      .array(
        z.object({
          ref_id: z
            .string()
            .max(REF_ID_MAX, `ref_id must be at most ${REF_ID_MAX} characters`)
            .regex(REF_ID_RE, "ref_id must match " + REF_ID_PATTERN)
            .optional(),
          tool: z.string(),
          args: z.record(z.unknown()).default({}),
        })
      )
      .min(1),
    compose: z.boolean().default(false),
    return: z.unknown().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.compose && v.executions.length > COMPOSE_MAX_EXECUTIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executions"],
        message: `compose: true runs at most ${COMPOSE_MAX_EXECUTIONS} executions`,
      });
    }
    const usesRefs = v.compose || v.return !== undefined;
    const seen = new Set<string>();
    v.executions.forEach((e, i) => {
      const path = ["executions", i, "ref_id"];
      if (e.ref_id === undefined) {
        if (v.compose) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "ref_id is required on every execution with compose: true" });
        }
        return;
      }
      if (!usesRefs) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "ref_id is only used with compose or return" });
      }
      if (seen.has(e.ref_id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Duplicate ref_id '${e.ref_id}'` });
      }
      seen.add(e.ref_id);
    });
  });

export async function executeSingle(
  userId: string,
  toolName: string,
  rawArgs: Record<string, unknown>,
  preSubstituted?: Map<string, string>
): Promise<ExecResult> {
  const targetTool = registry.getTool(toolName);
  if (!targetTool) {
    const appTool = await getToolForUser(userId, toolName);
    if (appTool) return executeCustomAppSingle(userId, appTool, rawArgs, preSubstituted);
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
            ? await ensureCookieSession(userId, targetTool.integration)
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
      // `preSubstituted` means the caller (compose) already resolved them in
      // its own single pass; scanning again here would resolve refs that
      // arrived inside an earlier step's output.
      let effectiveArgs: Record<string, unknown> = rawArgs ?? {};
      let substituted = new Map<string, string>();
      if (preSubstituted) {
        substituted = preSubstituted;
        if (substituted.size > 0) {
          void touchUsed(userId, [...substituted.keys()]).catch(() => undefined);
        }
      } else if (!toolName.startsWith("vault_")) {
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
  rawArgs: Record<string, unknown>,
  preSubstituted?: Map<string, string>
): Promise<ExecResult> {
  return withSpan(
    "execute_custom_app",
    async () => {
      const start = Date.now();

      const app = await getCustomApp(userId, tool.appId);
      if (!app) {
        return { error: "CustomApp not found" };
      }

      let authHeaders: Record<string, string>;
      try {
        authHeaders = await resolveAuthHeaders(userId, app);
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

      // Same contract as executeSingle: `preSubstituted` means compose
      // already resolved the agent's template in one pass, and a second scan
      // here would resolve refs that arrived inside an earlier step's output.
      let effectiveArgs: Record<string, unknown> = rawArgs ?? {};
      let substituted = new Map<string, string>();
      if (preSubstituted) {
        substituted = preSubstituted;
      } else {
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
          await callRemoteTool(userId, app.baseUrl, authHeaders, tool.remoteName, effectiveArgs),
          scrubEntries,
          substringOk
        ) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
        const duration_ms = Date.now() - start;

        if (result.isError) {
          // The remote MCP server reported a failed tool call — audit, metrics
          // and REST status must reflect that, not a 200 "success".
          const errText = redactHeaderValues(app, (result.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
            .slice(0, 500)) || "Remote tool returned isError";
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
        const err = scrubString(
          redactHeaderValues(app, upstreamAuthHint(app, e) ?? (e instanceof Error ? e.message : String(e))),
          scrubEntries,
          substringOk
        );
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
// curl_session token lifetime. There is no revoke, so a leaked token is live
// until it expires — the cap bounds that window.
const CURL_TTL_MIN_SECONDS = 60;
const CURL_TTL_MAX_SECONDS = 3600;
const CURL_TTL_DEFAULT_SECONDS = 900;

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;
const SEARCH_DESCRIPTION =
  "Search available tools by what you want to do, e.g. \"create jira issue\" or \"send email\". Matches words in any order, tolerates typos and common synonyms, and returns the best matches first with a relevance score. Returns the top 10 by default; pass limit (max 50) for more.";

export const metaTools = [
  {
    name: "search_tools",
    description: SEARCH_DESCRIPTION,
    inputSchema: z.object({
      query: z.string(),
      // Coerced: a client that cached tools/list before `limit` existed has no
      // type for it and sends "50" as a string.
      limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).default(SEARCH_LIMIT_DEFAULT),
    }),
    handler: async (ctx: { userId: string }, args: { query: string; limit?: number }) => {
      // Built-in and custom-app tools are ranked as one corpus, so a word's
      // rarity (IDF) is measured across everything the agent can call.
      const all: Array<{ name: string; description: string; integration: string }> = [
        ...registry.listTools(),
        ...(await ensureIndex(ctx.userId)),
      ];
      const ranked = rankTools(all, args.query, args.limit ?? SEARCH_LIMIT_DEFAULT);
      return {
        tools: ranked.map(({ tool, score }) => ({
          name: tool.name,
          description: tool.description,
          integration: tool.integration,
          score,
        })),
      };
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
      "Execute one or more tools in a single call. Runs them concurrently (bounded) and returns a `results` array in the same order as `executions`. A single tool failing does not abort the others — its entry carries an `error` instead of a `result`. For a single tool, pass a one-element `executions` array.\n\n" +
      "`ref_id` names an execution so its result can be read as `{{step:<ref_id>.<path>}}` (path segments are keys or array indexes, e.g. `{{step:list.files.0.id}}`). It must match " + REF_ID_PATTERN + ", be at most " + REF_ID_MAX + " characters and be unique; it is only accepted together with `compose` or `return`.\n\n" +
      "`compose: true` runs the executions in order instead (at most " + COMPOSE_MAX_EXECUTIONS + ", each with a `ref_id`) and resolves `{{step:...}}` refs in a later execution's args from earlier results. A ref that is the whole value keeps its type; one embedded in text interpolates. Stops at the first failing execution; the error carries its `ref_id`. Answers `{ result }`: the resolved `return`, or without `return` the last execution's result.\n\n" +
      "`return` is a template (any JSON) resolved over the results by `ref_id` and is the only thing sent back, so leave fat fields (csv, content, bytes) out of it. Without `compose`, the batch runs concurrently as usual, args are not interpolated, and failed executions are listed under `errors`.\n\n" +
      "`{{vault:NAME}}` resolves only in args you write — never in `return`, and never in text that arrives inside a tool's output.",
    inputSchema: executeToolsInput,
    handler: async (
      ctx: { userId: string },
      args: z.infer<typeof executeToolsInput>
    ): Promise<{ results: ExecResult[] } | ExecResult | ProjectedResult> => {
      if (args.compose) return composeTools(ctx.userId, args.executions, args.return);
      if (args.return !== undefined) return projectBatch(ctx.userId, args.executions, args.return);
      return executeMany(ctx.userId, args.executions);
    },
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
          connected: await isCustomAppConnected(ctx.userId, c),
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
    name: "curl_session",
    description:
      "HIGH RISK — do not call without explicit user approval. Mints a short-lived proxy token (15 min by default; set expiresInSeconds for 60s–1h, and ask for no longer than the task needs) granting ARBITRARY API calls (GET/POST/PUT/PATCH/DELETE), including destructive writes, against the listed integration(s) — the proxy injects the user's real credential transparently at /c/<integration>/<path>, so anything reachable via that credential is reachable through this token. Before invoking, tell the user exactly which integration(s) and what action you intend to perform, and wait for their explicit go-ahead; do not mint speculatively or as a default first step. Only integrations that have curl proxy enabled are accepted.",
    inputSchema: z.object({
      integrations: z.array(z.string()).min(1),
      expiresInSeconds: z
        .number()
        .int()
        .min(CURL_TTL_MIN_SECONDS)
        .max(CURL_TTL_MAX_SECONDS)
        .default(CURL_TTL_DEFAULT_SECONDS),
    }),
    handler: async (ctx: { userId: string }, args: { integrations: string[]; expiresInSeconds: number }) => {
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
      const token = await signCurlToken(ctx.userId, args.integrations, args.expiresInSeconds);
      return {
        token,
        expiresIn: args.expiresInSeconds,
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
    properties: {
      query: { type: "string", description: "What you want to do, in words (e.g. \"list github pull requests\")" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SEARCH_LIMIT_MAX,
        default: SEARCH_LIMIT_DEFAULT,
        description: "Maximum number of tools to return",
      },
    },
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
            ref_id: {
              type: "string",
              pattern: REF_ID_PATTERN,
              maxLength: REF_ID_MAX,
              description: "Names this execution so {{step:<ref_id>.<path>}} can read its result. Unique; required on every execution with compose: true; only accepted with compose or return",
            },
            tool: { type: "string", description: "Tool name returned by search_tools" },
            args: { type: "object", description: "Arguments for the tool. With compose: true, {{step:<ref_id>.<path>}} (array index allowed: {{step:list.files.0.id}}) is replaced by that earlier result", additionalProperties: true },
          },
          required: ["tool"],
        },
      },
      compose: {
        type: "boolean",
        default: false,
        description: `Run executions in order (at most ${COMPOSE_MAX_EXECUTIONS}), passing results between them via {{step:<ref_id>.<path>}}. Answers { result }: the resolved return, or the last execution's result.`,
      },
      return: {
        description: "What to send back: any JSON value whose strings may hold {{step:<ref_id>.<path>}} refs, e.g. { \"file_id\": \"{{step:upload.id}}\", \"rows\": \"{{step:export.row_count}}\" }. Works with or without compose. Never resolves {{vault:...}}. Leave fat fields out.",
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
  curl_session: {
    type: "object",
    properties: {
      integrations: {
        type: "array",
        items: { type: "string" },
        description: "Integration names to include in the session (e.g. [\"github\"])",
      },
      expiresInSeconds: {
        type: "integer",
        minimum: CURL_TTL_MIN_SECONDS,
        maximum: CURL_TTL_MAX_SECONDS,
        default: CURL_TTL_DEFAULT_SECONDS,
        description: "Token lifetime in seconds (default 900 = 15 min, max 3600 = 1 h). Ask for no longer than the task needs — the token cannot be revoked.",
      },
    },
    required: ["integrations"],
  },
};
