// Spaces (live apps over the viewer's own integrations) as an internal
// registry plugin. Lives in server source for the same reason as jots: the
// handlers reach into the spaces store and filesystem, which must stay out of
// the plugin ToolContext.
import { z } from "zod";
import { Plugin, PluginTool } from "../registry";
import { registry } from "../registry";
import { isInternalIntegration } from "../internal-names";
import { config } from "../../config";
import { safeRelPath } from "../../jots/paths";
import { isAdminEmail } from "../../auth/admin";
import { getUserById } from "../../auth/users";
import { mint } from "../../spaces/pending";
import { delegationFor, recordModeReset } from "../../spaces/delegation";
import {
  changeShares,
  delegationSuspended,
  deleteSpace,
  getShares,
  getSpace,
  hasFiles,
  isValidSpaceName,
  listAllSpaces,
  listOwnedSpaces,
  listSpaceFiles,
  parseEmails,
  normalizeTools,
  setShares,
  toolsHash,
  type Space,
  updateSpaceMeta,
  upsertSpace,
  type Visibility,
} from "../../spaces/store";

export const SPACES_INTEGRATION_NAME = "spaces";

function spaceUrl(name: string): string {
  return `${config.PORTAL_URL}/s/${name}`;
}

function uploadUrl(token: string): string {
  return `${config.SERVER_PUBLIC_URL}/s/upload/${token}`;
}

async function isAdmin(userId: string): Promise<boolean> {
  const user = await getUserById(userId);
  return isAdminEmail(user?.email);
}

type ToolCheck = { ok: true; tools: string[] } | { ok: false; error: string; tool?: string; message: string };

// Each declared tool must be a registry tool of an external plugin: never an
// internal one (decided by the tool's integration, not its name) and never a
// custom app (custom-app tools are not in the registry at all).
function checkTools(tools: unknown): ToolCheck {
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || t === "")) {
    return { ok: false, error: "INVALID_TOOLS", message: "tools must be an array of tool names" };
  }
  for (const name of tools as string[]) {
    const tool = registry.getTool(name);
    if (!tool) {
      return {
        ok: false,
        error: "TOOL_NOT_ALLOWED",
        tool: name,
        message: `${name} is not a tool in the registry. Use the fully-qualified name from search_tools (custom-app tools are not supported).`,
      };
    }
    if (isInternalIntegration(tool.integration)) {
      return {
        ok: false,
        error: "TOOL_NOT_ALLOWED",
        tool: name,
        message: `${name} belongs to the internal ${tool.integration} plugin, which a Space cannot use.`,
      };
    }
  }
  return { ok: true, tools: normalizeTools(tools as string[]) };
}

// Same validation the portal sharing endpoint uses.
const checkEmails = parseEmails;

// delegate_access is the stored setting; delegation_active is whether calls
// run with the owner's access right now (off when paused, revoked, ...).
async function delegationFields(s: Space): Promise<{ delegate_access: boolean; delegation_active: boolean }> {
  return { delegate_access: s.accessMode === "owner", delegation_active: (await delegationFor(s)).mode === "owner" };
}

// An agent can read and turn off delegated access, never turn it on: that is
// the owner's choice in the portal, where the full tool list is shown.
const PORTAL_ONLY = {
  error: "DELEGATION_PORTAL_ONLY",
  message: "Delegated access can only be turned on by you in the portal (Space > Sharing).",
};
// Widening who can open a delegated Space lends the owner's access to more
// people, so like turning it on it needs the owner in the portal. Narrowing,
// private, or turning it off in the same call stay open to an agent.
const WIDEN_PORTAL_ONLY = {
  error: "DELEGATION_PORTAL_ONLY",
  message:
    "This Space runs with your delegated access. Widen who can open it in the portal (Space > Sharing), or turn delegated access off first.",
};

/**
 * Would this change widen the audience of a Space that runs with the owner's
 * access? To everyone signed in from a narrower audience, or, on a Space
 * shared with specific people, any email added to the list (including a
 * replace that brings in someone new).
 */
async function widensDelegated(
  existing: Space | null,
  next: { visibility: Visibility; added: string[]; turningOff: boolean }
): Promise<boolean> {
  if (!existing || existing.accessMode !== "owner" || next.turningOff || next.visibility === "private") return false;
  if (next.visibility === "org" && existing.visibility !== "org") return true;
  // Everyone signed in can already open an org Space, so a list given with
  // it (or with org -> users) reaches nobody new.
  if (existing.visibility === "org" || next.added.length === 0) return false;
  const current = new Set(await getShares(existing.name));
  return next.added.some((e) => !current.has(e));
}

const SUSPENDED_NOTE = "Delegated access is paused until you confirm the new tool list in the portal.";

const HOW_TO_BUILD =
  "HOW TO BUILD A SPACE: a Space is a static site (root index.html) that runs in a sandboxed iframe inside the workbench portal, for whoever opens it. Its tool calls use the viewer's connections, or the owner's when the owner turned on delegated access in the portal. " +
  "Load the SDK with <script src=\"/s/_sdk/workbench.js\"></script> (absolute path, exactly this), then call tools with `await workbench.call(integration, tool, args)`, e.g. `await workbench.call(\"github\", \"github_list_prs\", { owner: \"acme\", repo: \"demo-repo\" })` (the bare suffix `list_prs` also works). " +
  "Also available: `workbench.me()` -> { email }, and a small per-viewer store: `workbench.store.get(key)`, `.set(key, value)`, `.delete(key)`, `.keys()` (values are JSON, 64 KiB each, 256 KiB per viewer). " +
  "Failures reject with a WorkbenchError carrying `code` (NOT_CONNECTED, DENIED, TOOL_NOT_DECLARED, TOOL_UNAVAILABLE, INVALID_ARGS, UPSTREAM_ERROR, RATE_LIMITED, CONSENT_REQUIRED, TOO_LARGE, TIMEOUT, UNAUTHENTICATED, DELEGATION_OFF, TOOL_NOT_DELEGABLE), `message`, `integration`, `tool`; render them in the page instead of failing silently. " +
  "Only tools listed in `tools` can be called; viewers approve that list once, and every destructive call shows them a confirmation they can deny (DENIED). At most 60 calls per minute per viewer. " +
  "The page has NO network access: the CSP sets connect-src 'none' (no fetch/XHR/WebSocket), allows scripts, styles, images and fonts only from this server or inline (data:/blob: for images, fonts and media), and blocks forms, nested frames and remote hosts. So bundle or inline every asset (no CDNs, no Google Fonts), and get all data through workbench.call. " +
  "Relative URLs resolve inside the Space, so ./app.js and ./style.css work. Vault references ({{vault:...}}) are refused in arguments.";

const tools: PluginTool[] = [
  {
    name: "deploy_space",
    description:
      "Create or replace a Space: a live web app at /s/<name> in the workbench portal that calls integrations as the viewer (or with the owner's access, when the owner turned on delegated access). " +
      "`tools` lists the fully-qualified registry tool names the page may call (find them with search_tools; internal plugins and custom apps are refused with TOOL_NOT_ALLOWED). " +
      "`visibility`: 'private' (only you), 'org' (any signed-in user of this workbench) or 'users' (the emails in `users`, required then). Deploying over an existing Space replaces its share list with `users` (empty if omitted); to grant or revoke one person use update_space with add_users / remove_users. " +
      "Delegated access (calls run with your connections) is turned on only by you in the portal; `delegate_access: false` turns it off, `true` is refused (DELEGATION_PORTAL_ONLY). A redeploy keeps the current setting unless the Space becomes private, which turns it off. While it is on, widening who can open the Space (to org, or adding anyone to `users`) is refused (DELEGATION_PORTAL_ONLY). The result has `delegate_access` (stored) and `delegation_active` (in effect now). " +
      "Metadata is saved at once; the files come from an upload: package your site directory as a gzip tarball and POST it to the returned uploadUrl within ~5 min, e.g. `tar czf - -C <dir> . | curl --data-binary @- -H 'Content-Type: application/gzip' <uploadUrl>`. " +
      "The archive root must contain index.html (NO_INDEX otherwise). A new Space is not visible until its first upload lands. Names are global and creator-locked (SPACE_NAME_TAKEN); lowercase letters, digits and hyphens. Limits: <=5 MiB decompressed, <=1000 files. " +
      HOW_TO_BUILD,
    integration: SPACES_INTEGRATION_NAME,
    effect: "write",
    inputSchema: z.object({
      name: z.string(),
      title: z.string().min(1),
      description: z.string().optional(),
      tools: z.array(z.string()),
      visibility: z.enum(["private", "org", "users"]),
      users: z.array(z.string()).optional(),
      delegate_access: z.boolean().optional(),
    }),
    handler: async (ctx: any, args: any) => {
      if (args.delegate_access === true) return PORTAL_ONLY;
      if (!isValidSpaceName(args.name)) return { error: "INVALID_NAME", message: "Use lowercase letters, digits and hyphens (not _sdk or upload), at most 64 characters." };
      const existing = await getSpace(args.name);
      if (existing && existing.ownerId !== ctx.userId) return { error: "SPACE_NAME_TAKEN" };
      const checked = checkTools(args.tools);
      if (!checked.ok) return checked.tool ? { error: checked.error, tool: checked.tool, message: checked.message } : { error: checked.error, message: checked.message };
      let emails: string[] = [];
      if (args.visibility === "users") {
        if (!Array.isArray(args.users) || args.users.length === 0) {
          return { error: "USERS_REQUIRED", message: "visibility 'users' needs a non-empty `users` list" };
        }
      }
      if (args.users !== undefined) {
        const e = checkEmails(args.users);
        if (!e.ok) return { error: e.error, message: e.message };
        emails = e.emails;
      }
      if (
        await widensDelegated(existing, {
          visibility: args.visibility as Visibility,
          added: emails,
          turningOff: args.delegate_access === false,
        })
      ) {
        return WIDEN_PORTAL_ONLY;
      }
      const saved = await upsertSpace({
        name: args.name,
        ownerId: ctx.userId,
        title: args.title,
        description: args.description ?? null,
        tools: checked.tools,
        visibility: args.visibility as Visibility,
        ...(args.delegate_access === false ? { accessMode: "viewer" as const } : {}),
      });
      if (saved.result === "taken") return { error: "SPACE_NAME_TAKEN" };
      if (saved.modeReset) {
        await recordModeReset({ name: args.name }, ctx.userId, args.delegate_access === false);
      }
      if (!(await setShares(args.name, ctx.userId, emails))) return { error: "SPACE_NAME_TAKEN" };
      const { token, expiresAt } = await mint({ owner: ctx.userId, name: args.name, mode: "replace" });
      const out: Record<string, unknown> = {
        uploadUrl: uploadUrl(token),
        token,
        expiresAt,
        maxBytes: config.JOTS_MAX_BYTES,
        url: spaceUrl(args.name),
      };
      const after = await getSpace(args.name);
      if (after) Object.assign(out, await delegationFields(after));
      // Still delegated, and this redeploy changed the confirmed tool list.
      const stillOwner = existing?.accessMode === "owner" && !saved.modeReset;
      if (stillOwner && !delegationSuspended(existing) && toolsHash(checked.tools) !== existing.delegatedToolsHash) {
        Object.assign(out, { delegation_suspended: true, note: SUSPENDED_NOTE });
      }
      return out;
    },
  },
  {
    name: "update_space",
    description:
      "Change a Space you own. `title`, `description`, `tools`, `visibility` and the share list apply immediately, without an upload (changing `tools` asks every viewer to approve again; `tools` replaces the whole list). " +
      "Share list: `add_users` / `remove_users` add or remove emails and leave everyone else on the list; use them to grant or revoke one person. `users` REPLACES the entire list (anyone not in it loses access); it cannot be combined with `add_users` / `remove_users`. list_spaces shows the current list. " +
      "Pass `files: true` (or a `delete` list) to also get a patch upload: the archive you upload is overlaid onto the live files, `delete` paths are removed first, and files you do not mention stay. Upload the same way as deploy_space, e.g. `tar czf - -C <dir> index.html | curl --data-binary @- -H 'Content-Type: application/gzip' <uploadUrl>`. " +
      "Call list_space_files to see the current tree. The merged tree must fit <=5 MiB / <=1000 files and keep a root index.html. " +
      "`delegate_access: false` turns delegated access off; `true` is refused (DELEGATION_PORTAL_ONLY), only the owner turns it on in the portal. Changing `tools` on a delegated Space pauses delegated access until the owner confirms the new list in the portal (`delegation_suspended: true`). Setting visibility to private turns it off. While it is on, widening who can open the Space (to org, `add_users`, or a `users` list with anyone new) is refused (DELEGATION_PORTAL_ONLY); narrowing is allowed. `applied` has `delegate_access` (stored) and `delegation_active` (in effect now). " +
      "Same build rules as deploy_space: load /s/_sdk/workbench.js, call tools through workbench.call, bundle or inline every asset, no network access.",
    integration: SPACES_INTEGRATION_NAME,
    effect: "write",
    inputSchema: z.object({
      name: z.string(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      tools: z.array(z.string()).optional(),
      visibility: z.enum(["private", "org", "users"]).optional(),
      users: z.array(z.string()).optional(),
      add_users: z.array(z.string()).optional(),
      remove_users: z.array(z.string()).optional(),
      files: z.boolean().optional(),
      delete: z.array(z.string()).optional(),
      delegate_access: z.boolean().optional(),
    }),
    handler: async (ctx: any, args: any) => {
      if (args.delegate_access === true) return PORTAL_ONLY;
      if (!isValidSpaceName(args.name)) return { error: "INVALID_NAME" };
      const existing = await getSpace(args.name);
      if (!existing) return { error: "NOT_FOUND" };
      if (existing.ownerId !== ctx.userId) return { error: "FORBIDDEN" };

      // Validate everything before changing anything.
      let toolList: string[] | undefined;
      if (args.tools !== undefined) {
        const checked = checkTools(args.tools);
        if (!checked.ok) return checked.tool ? { error: checked.error, tool: checked.tool, message: checked.message } : { error: checked.error, message: checked.message };
        toolList = checked.tools;
      }
      const incremental = args.add_users !== undefined || args.remove_users !== undefined;
      if (incremental && args.users !== undefined) {
        return {
          error: "CONFLICTING_USERS",
          message: "`users` replaces the whole share list; pass it alone, or use add_users / remove_users without it.",
        };
      }
      let emails: string[] | undefined;
      if (args.users !== undefined) {
        const e = checkEmails(args.users);
        if (!e.ok) return { error: e.error, message: e.message };
        emails = e.emails;
      }
      let addEmails: string[] = [];
      let removeEmails: string[] = [];
      if (args.add_users !== undefined) {
        const e = checkEmails(args.add_users);
        if (!e.ok) return { error: e.error, message: e.message };
        addEmails = e.emails;
      }
      if (args.remove_users !== undefined) {
        const e = checkEmails(args.remove_users);
        if (!e.ok) return { error: e.error, message: e.message };
        removeEmails = e.emails;
      }
      const visibility: Visibility = args.visibility ?? existing.visibility;
      if (visibility === "users") {
        let shares = emails ?? (await getShares(args.name));
        if (incremental) {
          const removed = new Set(removeEmails);
          shares = Array.from(new Set([...shares, ...addEmails])).filter((x) => !removed.has(x));
        }
        if (shares.length === 0) return { error: "USERS_REQUIRED", message: "visibility 'users' needs a non-empty share list" };
      }
      if (
        await widensDelegated(existing, {
          visibility,
          added: emails ?? addEmails,
          turningOff: args.delegate_access === false,
        })
      ) {
        return WIDEN_PORTAL_ONLY;
      }
      const deletes: string[] = [];
      for (const d of args.delete ?? []) {
        const rel = safeRelPath(d);
        if (!rel) return { error: "INVALID_PATH", path: d };
        deletes.push(rel);
      }

      // Both writes carry the owner predicate: a Space deleted and re-created
      // by someone else since the check above is not touched.
      const meta = await updateSpaceMeta(args.name, ctx.userId, {
        title: args.title,
        description: args.description,
        tools: toolList,
        visibility,
        ...(args.delegate_access === false ? { accessMode: "viewer" as const } : {}),
      });
      if (meta === "conflict") return { error: "CONFLICT", message: "This Space changed meanwhile. Try again." };
      // "tools_changed" only answers a delegation confirm, which this tool never sends.
      if (!meta || meta === "tools_changed") return { error: "FORBIDDEN" };
      const updated = meta.space;
      if (meta.modeReset) {
        await recordModeReset(updated, ctx.userId, args.delegate_access === false);
      }
      if (emails && !(await setShares(args.name, ctx.userId, emails))) return { error: "FORBIDDEN" };
      if (incremental) {
        const changed = await changeShares(
          args.name,
          ctx.userId,
          { add: addEmails, remove: removeEmails },
          visibility === "users"
        );
        if (changed === "forbidden") return { error: "FORBIDDEN" };
        // Only reachable if a concurrent edit emptied the list after the check above.
        if (changed === "empty") return { error: "USERS_REQUIRED", message: "visibility 'users' needs a non-empty share list" };
      }

      const result: Record<string, unknown> = {
        name: updated.name,
        url: spaceUrl(updated.name),
        applied: {
          title: updated.title,
          description: updated.description,
          tools: updated.tools,
          visibility: updated.visibility,
          users: await getShares(updated.name),
          ...(await delegationFields(updated)),
        },
      };
      // Newly paused by this change (a tool list that differs from the one
      // the owner confirmed).
      if (delegationSuspended(updated) && !delegationSuspended(existing)) {
        Object.assign(result, { delegation_suspended: true, note: SUSPENDED_NOTE });
      }
      if (args.files === true || args.delete !== undefined) {
        const { token, expiresAt } = await mint({ owner: ctx.userId, name: args.name, mode: "patch", deletes });
        Object.assign(result, { uploadUrl: uploadUrl(token), token, expiresAt, maxBytes: config.JOTS_MAX_BYTES });
      }
      return result;
    },
  },
  {
    name: "list_spaces",
    description:
      "List the Spaces you own (name, title, visibility, tools, users (the share list), url, updatedAt; `live` is false until the first upload lands; `delegate_access` is the stored setting (you turned delegated access on in the portal), `delegation_active` whether calls run with your connections right now, `delegation_suspended` true when the tool list changed since you confirmed it). Admins may pass `all: true` to list every Space with its owner's email.",
    integration: SPACES_INTEGRATION_NAME,
    effect: "read",
    inputSchema: z.object({ all: z.boolean().optional() }),
    handler: async (ctx: any, args: any) => {
      if (args?.all === true) {
        if (!(await isAdmin(ctx.userId))) return { error: "FORBIDDEN", message: "Only admins can list every Space." };
        const all = await listAllSpaces();
        return {
          spaces: await Promise.all(all.map(async (s) => ({
            name: s.name,
            title: s.title,
            visibility: s.visibility,
            tools: s.tools,
            users: await getShares(s.name),
            url: spaceUrl(s.name),
            updatedAt: s.updatedAt,
            live: hasFiles(s.name),
            ...(await delegationFields(s)),
            delegation_suspended: delegationSuspended(s),
            ownerEmail: s.ownerEmail,
          }))),
        };
      }
      const own = await listOwnedSpaces(ctx.userId);
      return {
        spaces: await Promise.all(own.map(async (s) => ({
          name: s.name,
          title: s.title,
          visibility: s.visibility,
          tools: s.tools,
          users: await getShares(s.name),
          url: spaceUrl(s.name),
          updatedAt: s.updatedAt,
          live: hasFiles(s.name),
          ...(await delegationFields(s)),
          delegation_suspended: delegationSuspended(s),
        }))),
      };
    },
  },
  {
    name: "list_space_files",
    description:
      "List the files of a Space you own (path, bytes, updatedAt), to plan a partial update with update_space. FORBIDDEN for another owner's Space, NOT_FOUND if it does not exist.",
    integration: SPACES_INTEGRATION_NAME,
    effect: "read",
    inputSchema: z.object({ name: z.string() }),
    handler: async (ctx: any, args: any) => {
      if (!isValidSpaceName(args.name)) return { error: "INVALID_NAME" };
      const space = await getSpace(args.name);
      if (!space) return { error: "NOT_FOUND" };
      if (space.ownerId !== ctx.userId) return { error: "FORBIDDEN" };
      return { files: listSpaceFiles(args.name) };
    },
  },
  {
    name: "delete_space",
    description:
      "Delete a Space: its files, shares, viewer approvals and stored values. Only its owner or an admin may delete it. FORBIDDEN otherwise, NOT_FOUND if it does not exist.",
    integration: SPACES_INTEGRATION_NAME,
    effect: "destructive",
    inputSchema: z.object({ name: z.string() }),
    handler: async (ctx: any, args: any) => {
      if (!isValidSpaceName(args.name)) return { error: "INVALID_NAME" };
      const space = await getSpace(args.name);
      if (!space) return { error: "NOT_FOUND" };
      if (space.ownerId !== ctx.userId && !(await isAdmin(ctx.userId))) return { error: "FORBIDDEN" };
      await deleteSpace(args.name);
      return { ok: true, name: args.name };
    },
  },
];

export const spacesPlugin: Plugin = {
  integration: {
    name: SPACES_INTEGRATION_NAME,
    version: "1.0.0",
    auth: { type: "none" },
    displayName: "Spaces",
    description:
      "Built-in live apps: deploy a web page at /s/<name> that calls integrations as whoever opens it, shared privately, org-wide or with a list of people.",
    categories: ["hosting"],
  },
  tools,
};
