import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { effectOf } from "@a-workbench/shared";
import { noteRequestAuth, currentAuditContext, runWithAuditContext } from "../audit/context";
import { auditLogger } from "../audit/logger";
import { verifySession } from "../auth/session";
import { getUserById } from "../auth/users";
import { getToken } from "../auth/tokens";
import { hasValidCookies } from "../auth/cookie";
import { registry } from "../plugins/registry";
import {
  approvalEditable,
  approvalFor,
  autoSet,
  checkConsent,
  delegatedFor,
  defaultMode,
  getApprovalRows,
  isInternalTool,
  policyRows,
  recordApprovalChange,
  recordSpaceDelete,
  shownConsentHash,
  writeApprovals,
  type ApprovalMode,
  type ApprovalRows,
} from "./approvals";
import { executeDelegated, executeSingle } from "../mcp/meta-tools";
import { can } from "../permissions/store";
import { canView, type Viewer } from "./access";
import { delegationFor, mayEnableDelegation, recordDelegationChange, recordModeReset, type DelegationState } from "./delegation";
import {
  changeShares,
  delegationSuspended,
  getShares,
  getSpace,
  distinctOpeners,
  favoriteCounts,
  grantConsent,
  hasFiles,
  refreshConsentVersion,
  isValidKvKey,
  kvDelete,
  kvGet,
  kvKeys,
  kvPut,
  listAllSpaces,
  ownerEmailOf,
  OPENERS_FLOOR,
  parseEmails,
  recordOpen,
  revokeConsent,
  deleteSpace,
  setFavorite,
  toolsHash,
  userSpaceStates,
  updateSpaceMeta,
  type Space,
  type Visibility,
} from "./store";
import { pendingRequestCounts } from "../approvals/kinds";
import { mintSig } from "./sig";
import { takeOwnerToken, takeToken } from "./rate-limit";

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

const OPENED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
function openersShown(visibility: Visibility, n: number | undefined): boolean {
  return n !== undefined && (visibility === "org" || n >= OPENERS_FLOOR);
}

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 1000;

interface ErrorBody {
  code: string;
  message: string;
  integration?: string;
  tool?: string;
  retryAfterMs?: number;
  // DELEGATION_OFF: why ("turned_off" | "tools_changed"); OWNER_NOT_CONNECTED
  // on a call: "owner_not_connected", the same reason the detail shows.
  reason?: string;
  // NOT_CONNECTED on a delegated call: the owner must reconnect, not the viewer.
  delegated?: boolean;
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

const isInternal = isInternalTool;

/**
 * The tool list the portal shows for a Space: effect, connection state, and for
 * each usable non-read tool its approval mode (from `rows`, the one policy read
 * of the request) and whether the viewer may change it.
 */
async function buildToolList(space: Space, viewerId: string, connectedAs: string, rows: ApprovalRows) {
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
        delegable: false,
        approval: "ask" as const,
        approvalEditable: false,
      });
      continue;
    }
    // A tool that is not delegable never runs for a delegated viewer, so a mode would only mislead.
    const neverRuns = delegatedFor(space, viewerId) && tool.delegable === false;
    const approval = neverRuns ? null : approvalFor(space, viewerId, name, rows);
    tools.push({
      name,
      integration: tool.integration,
      integrationName: integ.displayName ?? tool.integration,
      effect: effectOf(tool),
      connected: await isConnected(tool.integration, connectedAs),
      description: tool.description ?? "",
      delegable: tool.delegable !== false,
      ...(approval ? { approval, approvalEditable: approvalEditable(space, viewerId, name) } : {}),
    });
  }
  return tools;
}

/**
 * Display names of the integrations the Space's tools need that the viewer has
 * not connected. Tools that no longer exist are ignored: they cannot run, so
 * there is nothing to connect for them.
 */
async function unconnectedIntegrations(space: Space, userId: string): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const name of space.tools) {
    const tool = registry.getTool(name);
    const integ = tool ? registry.getIntegration(tool.integration) : undefined;
    if (!tool || !integ || isInternal(tool) || seen.has(tool.integration)) continue;
    if (!(await isConnected(tool.integration, userId))) seen.set(tool.integration, integ.displayName ?? tool.integration);
  }
  return [...seen.values()];
}

/**
 * For a viewer of a delegated Space (delegation in effect, viewer not the
 * owner): why they cannot enter it yet, when the owner is missing a connection
 * for any integration the Space uses (same rule as unconnectedIntegrations).
 * It names the missing integrations, which a viewer needs to understand why
 * they are held; it says nothing of the owner's permission or account.
 */
async function ownerNotConnectedMessage(space: Space, ownerId: string): Promise<string | null> {
  const missing = await unconnectedIntegrations(space, ownerId);
  if (missing.length === 0) return null;
  const ownerEmail = (await ownerEmailOf(space.ownerId)) ?? "The owner";
  return `${ownerEmail} needs to reconnect ${missing.join(", ")} before this Space can be used.`;
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
        // One permission read per request, only when the viewer owns a delegated Space.
        let ownerCan: boolean | undefined;
        const [states, favoriteTotals, openers, requestCounts] = await Promise.all([
          userSpaceStates(viewer.userId),
          favoriteCounts(),
          distinctOpeners(viewer.userId, Date.now() - OPENED_WINDOW_MS),
          pendingRequestCounts(viewer.userId),
        ]);
        for (const s of await listAllSpaces()) {
          if (!hasFiles(s.name)) continue;
          if (!(await canView(s, viewer))) continue;
          const mine = s.ownerId === viewer.userId;
          // Same rule as the detail: the owner sees the stored mode, anyone
          // else only whether it is in effect. Viewer-mode Spaces skip the
          // permission read.
          const delegation = mine || s.accessMode !== "owner" ? null : await delegationFor(s);
          if (mine && s.accessMode === "owner" && ownerCan === undefined) {
            ownerCan = await can(viewer.userId, "spaces.delegate_access");
          }
          out.push({
            name: s.name,
            title: s.title,
            description: s.description,
            ownerEmail: s.ownerEmail,
            visibility: s.visibility,
            updatedAt: s.updatedAt,
            mine,
            favorited: states.get(s.name)?.favorited ?? false,
            favorite_count: favoriteTotals.get(s.name) ?? 0,
            last_opened_at: states.get(s.name)?.lastOpenedAt ?? null,
            // Owner only, and only when it cannot point at individuals.
            ...(mine && openersShown(s.visibility, openers.get(s.name))
              ? { viewers_30d: openers.get(s.name) as number }
              : {}),
            // Owner only: open access requests for this Space (people asking to be added).
            ...(mine ? { pending_requests: requestCounts.get(s.name) ?? 0 } : {}),
            delegate_access: mine ? s.accessMode === "owner" : delegation?.mode === "owner",
            delegation_suspended: mine
              ? delegationSuspended(s)
              : delegation?.mode === "off" && delegation.reason === "tools_changed",
            ...(mine && s.accessMode === "owner" && ownerCan === false ? { delegation_blocked: "no_permission" as const } : {}),
          });
        }
        return { spaces: out };
      });

      scope.get<{ Params: { name: string } }>("/:name", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        const mine = space.ownerId === viewer.userId;
        // Read the owner's permission once: for can_delegate and for the mode.
        const ownerCanDelegate = mine ? await can(viewer.userId, "spaces.delegate_access") : undefined;
        const delegation = await delegationFor(space, { ownerCanDelegate });
        // Delegated: the tools run with the owner's connections, so that is
        // what "connected" reports.
        const connectedAs = delegation.mode === "owner" ? delegation.runAs : viewer.userId;
        // A viewer of a delegated Space is held at a gate (not the consent
        // screen) until the owner has connected everything the Space uses.
        // The owner opening their own Space gets the ordinary connect gate.
        const ownerGate =
          !mine && delegation.mode === "owner" ? await ownerNotConnectedMessage(space, delegation.runAs) : null;

        // One policy read for the whole request: the tool list, the shown
        // hash and the consent state all come from the same rows.
        const rows = await policyRows(space, viewer.userId);
        const tools = await buildToolList(space, viewer.userId, connectedAs, rows);
        const consent = await checkConsent(space, viewer.userId, rows);

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
          consented: consent.consented,
          ...(consent.reason ? { reconsent_reason: consent.reason } : {}),
          // What the viewer approves when they approve this screen; sent back
          // with the approval.
          consent_hash: shownConsentHash(space, viewer.userId, autoSet(space, viewer.userId, rows)),
          appUrl: `/s/${space.name}/app/${mintSig(space.name, viewer.userId)}/`,
          // The owner sees the stored mode; anyone else only whether it is in
          // effect. A viewer sees whether it is paused (tools changed) or off,
          // never the owner's permission or account state.
          delegate_access: mine ? space.accessMode === "owner" : delegation.mode === "owner",
          delegation_suspended: mine
            ? delegationSuspended(space)
            : delegation.mode === "off" && delegation.reason === "tools_changed",
          // Owner only: the stored mode is on but the owner lacks the permission.
          ...(mine && space.accessMode === "owner" && ownerCanDelegate === false
            ? { delegation_blocked: "no_permission" as const }
            : {}),
          // Set when a viewer cannot use the Space: delegation off or paused,
          // or (viewers only) "owner_not_connected" while delegation is in effect.
          delegation_off:
            delegation.mode === "off"
              ? { reason: delegation.reason, message: delegation.message }
              : ownerGate
                ? { reason: "owner_not_connected" as const, message: ownerGate }
                : null,
          // Owner only: the hash of the list shown, sent back to confirm it.
          ...(mine ? { tools_hash: toolsHash(space.tools), can_delegate: ownerCanDelegate === true } : {}),
        };
      });

      // Owner-only sharing settings, so the portal can change who can open a
      // Space without going through an agent. Same rules as update_space:
      // add_users / remove_users never touch anyone else on the list, and a
      // 'users' Space cannot be left with nobody on it. A viewer who is not the
      // owner gets the same 404 as for a Space they cannot see, or 403 when they
      // can open it but do not own it.
      // Favorites: one person's mark, used to order their own gallery. Anyone who
      // can open the Space may mark it; the count is how many people have.
      for (const on of [true, false]) {
        scope.route<{ Params: { name: string } }>({
          method: on ? "PUT" : "DELETE",
          url: "/:name/favorite",
          handler: async (request, reply) => {
            const viewer = viewerOf(request);
            const space = await openable(request.params.name, viewer);
            if (!space) return notFound(reply);
            await setFavorite(space.name, viewer.userId, on);
            return { favorited: on, favorite_count: (await favoriteCounts(space.name)).get(space.name) ?? 0 };
          },
        });
      }

      // The shell reports that it mounted the Space. This, not a request for the
      // Space's files, is what counts as an open: the files route only checks a
      // signature, cannot tell an open from a reload, and does not look at access
      // or consent. Only a person who has approved the tool list is recorded.
      scope.post<{ Params: { name: string } }>("/:name/open", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        if (!(await checkConsent(space, viewer.userId, await policyRows(space, viewer.userId))).consented) return { recorded: false };
        await recordOpen(space.name, viewer.userId);
        return { recorded: true };
      });

      // Owner-only delete. Same 404/403 shape as the other owner routes. The
      // audit row is written after the delete and never undoes it.
      scope.delete<{ Params: { name: string } }>("/:name", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        if (space.ownerId !== viewer.userId) {
          return fail(reply, 403, { code: "FORBIDDEN", message: "Only the owner can delete this Space." });
        }
        await deleteSpace(space.name);
        await recordSpaceDelete(space, viewer.userId);
        return { deleted: true };
      });

      // Owner-only title and description, so the portal can edit them without
      // opening the Space. The tool list stays with the agent: changing it asks
      // every viewer to approve again, which this route must not do silently.
      scope.patch<{ Params: { name: string }; Body: { title?: unknown; description?: unknown } }>("/:name", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        if (space.ownerId !== viewer.userId) {
          return fail(reply, 403, { code: "FORBIDDEN", message: "Only the owner can edit this Space." });
        }
        const body = (request.body ?? {}) as { title?: unknown; description?: unknown };
        let title: string | undefined;
        if (body.title !== undefined) {
          if (typeof body.title !== "string" || body.title.trim() === "") {
            return fail(reply, 400, { code: "INVALID_TITLE", message: "A Space needs a title." });
          }
          if (body.title.trim().length > MAX_TITLE) {
            return fail(reply, 400, { code: "INVALID_TITLE", message: `Keep the title to ${MAX_TITLE} characters or fewer.` });
          }
          title = body.title.trim();
        }
        let description: string | null | undefined;
        if (body.description !== undefined) {
          if (body.description !== null && typeof body.description !== "string") {
            return fail(reply, 400, { code: "INVALID_DESCRIPTION", message: "description must be text." });
          }
          const text = typeof body.description === "string" ? body.description.trim() : "";
          if (text.length > MAX_DESCRIPTION) {
            return fail(reply, 400, { code: "INVALID_DESCRIPTION", message: `Keep the description to ${MAX_DESCRIPTION} characters or fewer.` });
          }
          description = text === "" ? null : text;
        }
        if (title === undefined && description === undefined) {
          return fail(reply, 400, { code: "INVALID_ARGS", message: "Send a title or a description." });
        }
        const updated = await updateSpaceMeta(space.name, viewer.userId, { title, description });
        if (updated === "conflict") {
          return fail(reply, 409, { code: "CONFLICT", message: "This Space changed meanwhile. Try again." });
        }
        if (!updated || updated === "tools_changed") {
          return fail(reply, 403, { code: "FORBIDDEN", message: "Only the owner can edit this Space." });
        }
        return { title: updated.space.title, description: updated.space.description, updatedAt: updated.space.updatedAt };
      });

      scope.patch<{
        Params: { name: string };
        Body: { visibility?: unknown; add_users?: unknown; remove_users?: unknown; delegate_access?: unknown; tools_hash?: unknown };
      }>("/:name/sharing", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        if (space.ownerId !== viewer.userId) {
          return fail(reply, 403, { code: "FORBIDDEN", message: "Only the owner can change who can open this Space." });
        }
        const body = (request.body ?? {}) as {
          visibility?: unknown;
          add_users?: unknown;
          remove_users?: unknown;
          delegate_access?: unknown;
          tools_hash?: unknown;
        };

        let visibility: Visibility = space.visibility;
        if (body.visibility !== undefined) {
          if (body.visibility !== "private" && body.visibility !== "org" && body.visibility !== "users") {
            return fail(reply, 400, { code: "INVALID_VISIBILITY", message: "visibility is private, org or users" });
          }
          visibility = body.visibility;
        }
        let add: string[] = [];
        let remove: string[] = [];
        if (body.add_users !== undefined) {
          const e = parseEmails(body.add_users);
          if (!e.ok) return fail(reply, 400, { code: e.error, message: e.message });
          add = e.emails;
        }
        if (body.remove_users !== undefined) {
          const e = parseEmails(body.remove_users);
          if (!e.ok) return fail(reply, 400, { code: e.error, message: e.message });
          remove = e.emails;
        }

        if (body.delegate_access !== undefined && typeof body.delegate_access !== "boolean") {
          return fail(reply, 400, { code: "INVALID_ARGS", message: "delegate_access must be true or false" });
        }
        if (body.tools_hash !== undefined && typeof body.tools_hash !== "string") {
          return fail(reply, 400, { code: "INVALID_ARGS", message: "tools_hash must be a string" });
        }
        const delegate = body.delegate_access as boolean | undefined;
        const reviewedHash = body.tools_hash as string | undefined;
        if (delegate === true && reviewedHash === undefined) {
          return fail(reply, 400, { code: "INVALID_ARGS", message: "tools_hash is required to turn on delegated access." });
        }

        // Validate the outcome before writing anything.
        if (delegate === true) {
          const check = await mayEnableDelegation(viewer.userId, visibility);
          if (!check.ok) return fail(reply, 403, { code: check.code, message: check.message });
        }
        if (visibility === "users") {
          const removed = new Set(remove);
          const projected = new Set([...(await getShares(space.name)), ...add].filter((x) => !removed.has(x)));
          if (projected.size === 0) {
            return fail(reply, 400, { code: "USERS_REQUIRED", message: "Add at least one person to share with specific people." });
          }
        }

        // Write when the audience or the mode changes, or on a confirm (true
        // while already on is the re-confirm after a tool change).
        let current: Space = space;
        const modeOff = delegate === false && space.accessMode === "owner";
        // Widening the audience while the stored mode is on but the owner lost
        // the permission: the mode would start running for more people, so
        // turn it off instead (the owner cannot confirm it again).
        const audienceRank = { private: 0, users: 1, org: 2 } as const;
        const widened = audienceRank[visibility] > audienceRank[space.visibility];
        const forcedOff =
          widened &&
          delegate === undefined &&
          space.accessMode === "owner" &&
          !(await can(viewer.userId, "spaces.delegate_access"));
        // true on a Space already on, unpaused, for the same list: nothing to
        // confirm (a double submit), so no confirm and no second ON row.
        const reconfirm =
          delegate === true &&
          !(space.accessMode === "owner" && !delegationSuspended(space) && reviewedHash === toolsHash(space.tools));
        if (visibility !== space.visibility || reconfirm || modeOff || forcedOff) {
          const updated = await updateSpaceMeta(space.name, viewer.userId, {
            visibility,
            ...(reconfirm
              ? { accessMode: "owner" as const, confirmDelegation: true, expectedToolsHash: reviewedHash }
              : delegate === false || forcedOff
                ? { accessMode: "viewer" as const }
                : {}),
          });
          if (updated === "conflict") {
            return fail(reply, 409, { code: "CONFLICT", message: "This Space changed meanwhile. Try again." });
          }
          if (updated === "tools_changed") {
            return fail(reply, 409, { code: "TOOLS_CHANGED", message: "The tool list changed. Review it again." });
          }
          if (!updated) return fail(reply, 403, { code: "FORBIDDEN", message: "Only the owner can change who can open this Space." });
          current = updated.space;
          if (reconfirm) {
            await recordDelegationChange(current, viewer.userId, "on");
          } else if (updated.modeReset) {
            if (forcedOff) {
              await recordDelegationChange(current, viewer.userId, "off", "audience widened without permission");
            } else {
              await recordModeReset(current, viewer.userId, delegate === false);
            }
          }
        }
        let users = await getShares(space.name);
        if (add.length > 0 || remove.length > 0) {
          const changed = await changeShares(space.name, viewer.userId, { add, remove }, visibility === "users");
          if (changed === "forbidden") {
            return fail(reply, 403, { code: "FORBIDDEN", message: "Only the owner can change who can open this Space." });
          }
          if (changed === "empty") {
            return fail(reply, 409, { code: "USERS_REQUIRED", message: "The share list changed meanwhile and would be left empty." });
          }
          users = changed;
        }
        return {
          visibility,
          users,
          delegate_access: current.accessMode === "owner",
          delegation_suspended: delegationSuspended(current),
          ...(current.accessMode === "owner" && !(await can(viewer.userId, "spaces.delegate_access"))
            ? { delegation_blocked: "no_permission" as const }
            : {}),
        };
      });

      // The approval names what the viewer was shown (`consent_hash` from the
      // detail). If the Space changed since (tools, mode, owner), the screen
      // they approved is not this Space any more: refuse, and the portal
      // shows the new one.
      // Per-tool approval modes, set in the portal only (the scope accepts only
      // a portal session). Validated whole before anything is written. A
      // delegated viewer follows the owner's policy and cannot set their own:
      // that is decided by the stored mode, so it holds while delegation is paused.
      scope.put<{ Params: { name: string }; Body: { tools?: unknown } }>("/:name/tool-approvals", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        const invalid = (message: string) => fail(reply, 400, { code: "INVALID_APPROVAL", message });
        const body = request.body as { tools?: unknown } | null | undefined;
        const input = body && typeof body === "object" && !Array.isArray(body) ? body.tools : undefined;
        if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("tools must be an object of tool to auto or ask.");
        const next: Record<string, ApprovalMode> = {};
        const defaults: Record<string, ApprovalMode> = {};
        for (const [name, mode] of Object.entries(input as Record<string, unknown>)) {
          if (mode !== "auto" && mode !== "ask") return invalid(`${name}: mode must be "auto" or "ask".`);
          if (!space.tools.includes(name)) return invalid(`This Space did not declare ${name}.`);
          const tool = registry.getTool(name);
          if (!tool || !registry.getIntegration(tool.integration) || isInternal(tool)) return invalid(`${name} is not available.`);
          const def = defaultMode(tool);
          if (def === null) return invalid(`${name} is a read tool and never asks.`);
          next[name] = mode;
          defaults[name] = def;
        }
        if (delegatedFor(space, viewer.userId)) {
          return fail(reply, 403, {
            code: "APPROVAL_SET_BY_OWNER",
            message: "The owner of this Space decides which tools ask first.",
          });
        }
        // A person who is consented now must not be asked again for their own
        // change: judge that on the rows before the write, and after it record
        // the Space version they read as the one they approved. A page upload
        // landing in between still differs and asks.
        const wasConsented = (await checkConsent(space, viewer.userId, await getApprovalRows(space.name, viewer.userId))).consented;
        const changes = await writeApprovals(space.name, viewer.userId, next, defaults);
        if (wasConsented) await refreshConsentVersion(space.name, viewer.userId, space.updatedAt);
        // The mode can change while the write runs (the owner turns sharing on
        // or off), so audit when either the read before or the read after says
        // owner: a change that landed under the owner policy is never skipped.
        if (space.ownerId === viewer.userId && changes.length > 0) {
          const after = space.accessMode === "owner" ? space : await getSpace(space.name);
          if (space.accessMode === "owner" || after?.accessMode === "owner") {
            await recordApprovalChange(space, viewer.userId, changes);
          }
        }
        const rows = await policyRows(space, viewer.userId);
        return { tools: await buildToolList(space, viewer.userId, viewer.userId, rows) };
      });

      scope.post<{ Params: { name: string }; Body: { consent_hash?: unknown } }>("/:name/consent", async (request, reply) => {
        const viewer = viewerOf(request);
        const space = await openable(request.params.name, viewer);
        if (!space) return notFound(reply);
        const shown = (request.body as { consent_hash?: unknown } | undefined)?.consent_hash;
        // One policy read: the set the shown hash is checked against is the
        // set that is granted, so a change after this read is never recorded
        // as approved.
        const rows = await policyRows(space, viewer.userId);
        const auto = autoSet(space, viewer.userId, rows);
        if (typeof shown !== "string" || shown !== shownConsentHash(space, viewer.userId, auto)) {
          return fail(reply, 409, { code: "CONSENT_CHANGED", message: "This Space changed. Review it again." });
        }
        // A delegated Space runs with the owner's connections, so the viewer has
        // nothing to connect; the consent they give is for that mode (the hash
        // covers it). While delegation is in effect the owner must have
        // connected everything the Space uses, or nobody else may approve it.
        // Ordinary Spaces (and the owner's own view) need the viewer's
        // connections instead.
        const delegatedForViewer = delegatedFor(space, viewer.userId);
        if (delegatedForViewer) {
          const delegation = await delegationFor(space);
          const held = delegation.mode === "owner" ? await ownerNotConnectedMessage(space, delegation.runAs) : null;
          if (held) return fail(reply, 409, { code: "OWNER_NOT_CONNECTED", message: held });
        }
        const unconnected = delegatedForViewer ? [] : await unconnectedIntegrations(space, viewer.userId);
        if (unconnected.length > 0) {
          return fail(reply, 409, {
            code: "INTEGRATION_NOT_CONNECTED",
            message: `Connect ${unconnected.join(", ")} before approving this Space.`,
          });
        }
        await grantConsent(space, viewer.userId, delegatedForViewer ? auto : null);
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

        // 2. Consent to the current tool list (and, when delegated, the
        // owner's auto set). The policy is read once; step 7 reuses it.
        const rows = await policyRows(space, viewer.userId);
        if (!(await checkConsent(space, viewer.userId, rows)).consented) {
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

        // 5. The viewer's rate limit, before anything that can be refused and
        // audited: a page looping on a refusal (a paused delegated Space)
        // is held to the same 60 a minute, so it cannot flood the owner's
        // audit log. Rate limiting itself is never audited; it is what bounds
        // the log.
        const viewerRate = takeToken(viewer.userId, space.name);
        if (!viewerRate.ok) {
          return fail(reply, 429, {
            code: "RATE_LIMITED",
            message: "Too many calls. Try again shortly.",
            retryAfterMs: viewerRate.retryAfterMs,
            integration: tool.integration,
            tool: toolName,
          });
        }

        // 6. Delegation. Decided per call; an owner mode that is no longer valid
        // is refused, never run with the viewer's own access instead. The
        // owner opening their own Space is never delegation: it is their own
        // access, so it costs no lookup.
        const delegation: DelegationState =
          space.ownerId === viewer.userId ? { mode: "viewer" } : await delegationFor(space);
        const actor = delegation.mode === "viewer" ? undefined : viewer.userId;
        // Every delegated refusal from here on (rate limiting aside) is audited, as the owner's row
        // with the viewer as actor, so "every call is audited" holds for
        // refusals too. The actor goes in a copy of the request's audit
        // context, scoped to this write (the AsyncLocalStorage scope ends when
        // it returns). A failed write is logged and the refusal still answers,
        // as with recordDelegationChange.
        const refuse = async (status: number, err: ErrorBody) => {
          if (actor) {
            try {
              await runWithAuditContext(
                { ...(currentAuditContext() ?? {}), client_name: `space:${space.name}`, actor_user_id: actor },
                () =>
                  auditLogger.log({
                    user_id: space.ownerId,
                    integration: tool.integration,
                    tool: toolName,
                    action: "EXECUTE",
                    success: false,
                    error: err.code,
                  })
              );
            } catch (e) {
              console.error(
                `[spaces] audit of refused delegated call failed: space=${space.name} tool=${toolName} code=${err.code}: ` +
                  (e instanceof Error ? e.message : String(e))
              );
            }
          }
          return fail(reply, status, err);
        };
        if (delegation.mode === "off") {
          return refuse(403, {
            code: "DELEGATION_OFF",
            reason: delegation.reason,
            message: delegation.message,
            integration: tool.integration,
            tool: toolName,
          });
        }
        // The owner is missing a connection the Space uses: the Space is closed
        // to viewers, whichever tool was asked for, before anything runs.
        if (delegation.mode === "owner" && actor) {
          const held = await ownerNotConnectedMessage(space, delegation.runAs);
          if (held) {
            return refuse(409, {
              code: "OWNER_NOT_CONNECTED",
              reason: "owner_not_connected",
              message: held,
              integration: tool.integration,
              tool: toolName,
            });
          }
        }
        if (actor && tool.delegable === false) {
          return refuse(403, {
            code: "TOOL_NOT_DELEGABLE",
            message: `${toolName} cannot run with someone else's access.`,
            integration: tool.integration,
            tool: toolName,
          });
        }

        // 7. A tool whose mode is "ask" needs the shell's own confirmation.
        if (approvalFor(space, viewer.userId, toolName, rows) === "ask" && body.confirmed !== true) {
          return refuse(428, {
            code: "CONFIRMATION_REQUIRED",
            message: `${toolName} needs your confirmation.`,
            integration: tool.integration,
            tool: toolName,
          });
        }

        // 8. Arguments: an object, with no vault reference anywhere. Vault
        // references are never resolved for a Space (step 10 passes an empty
        // pre-substituted map, and a delegated call never reads a vault);
        // refusing them outright makes that loud.
        const args = body.args === undefined ? {} : body.args;
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          return refuse(400, { code: "INVALID_ARGS", message: "args must be an object.", integration: tool.integration, tool: toolName });
        }
        if (containsVaultRef(args)) {
          return refuse(400, {
            code: "INVALID_ARGS",
            message: "Vault references are not allowed in a Space.",
            integration: tool.integration,
            tool: toolName,
          });
        }

        // 9. When delegated, the owner's bucket per Space too, so many viewers
        // cannot exhaust the owner's upstream quota. Taken last, only for a
        // call about to run; like the viewer's, not audited.
        if (actor) {
          const ownerRate = takeOwnerToken(space.ownerId, space.name);
          if (!ownerRate.ok) {
            return fail(reply, 429, {
              code: "RATE_LIMITED",
              message: "Too many calls. Try again shortly.",
              retryAfterMs: ownerRate.retryAfterMs,
              integration: tool.integration,
              tool: toolName,
            });
          }
        }

        // 10. Run as the viewer, or as the owner with the viewer as actor,
        // attributed to the Space in the audit log.
        const audit = currentAuditContext();
        if (audit) audit.client_name = `space:${space.name}`;
        const outcome = actor
          ? await executeDelegated(space.ownerId, actor, toolName, args as Record<string, unknown>)
          : await executeSingle(viewer.userId, toolName, args as Record<string, unknown>, new Map());
        if ("result" in outcome) return { result: outcome.result };
        if (outcome.error === "NOT_CONNECTED") {
          if (actor) {
            // The owner's connection, not the viewer's: no connect action for
            // the viewer, and no fallback to their own.
            const ownerEmail = (await ownerEmailOf(space.ownerId)) ?? "The owner";
            const integrationName = registry.getIntegration(tool.integration)?.displayName ?? tool.integration;
            return fail(reply, 409, {
              code: "NOT_CONNECTED",
              delegated: true,
              message: `${ownerEmail} needs to reconnect ${integrationName}.`,
              integration: tool.integration,
              tool: toolName,
            });
          }
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
        if (!(await checkConsent(space, viewer.userId, await policyRows(space, viewer.userId))).consented) {
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
