// The agent file workspace as an internal registry plugin. Lives in server
// source — NOT under PLUGINS_DIR — because the handlers reach straight into the
// workspace store and the path resolver.
//
// Note what that boundary is and is not. Plugins are dynamically imported into
// this same process with no sandbox, so a determined plugin could import fs and
// read whatever the server user can; keeping this internal stops a capability
// being *offered*, not taken. The resolver earns its keep for a different
// reason: the hash-keying and traversal check exist in exactly one place.
import { z } from "zod";
import { Plugin, PluginTool } from "../registry";
import {
  deleteFile,
  listFiles,
  readFileBytes,
  statFile,
  usedBytes,
  writeFileBytes,
  WorkspaceError,
} from "../../workspace/store";
import { userFilePath } from "../../workspace/paths";
import { mintPresign, revokeFor } from "../../workspace/presign";
import { config } from "../../config";

export const FILES_INTEGRATION_NAME = "files";

// Every description carries this. The model reads tool descriptions at call
// time; it does not read the spec. A file that vanishes in 24 hours with no
// warning in the description is a bug in the description.
const RETENTION =
  "Workspace files are deleted 24 hours after they are written, whether or not anything is using them, and reading a file does NOT extend its life. Anything that must survive has to be moved to a durable destination (a Drive upload, a Slack upload) in the same run.";

function fail(e: unknown): { error: string; detail?: string } {
  if (e instanceof WorkspaceError) {
    return e.message !== e.code ? { error: e.code, detail: e.message } : { error: e.code };
  }
  throw e;
}

const tools: PluginTool[] = [
  {
    name: "files_list",
    description: `List the files in your workspace — the per-user scratch area that browser downloads land in and that uploads are read from. Returns name, bytes, mtime and expiresAt for each. ${RETENTION}`,
    integration: FILES_INTEGRATION_NAME,
    inputSchema: z.object({}),
    handler: async (ctx: any) => {
      const files = await listFiles(ctx.userId);
      return {
        files,
        usedBytes: files.reduce((n, f) => n + f.bytes, 0),
        quotaBytes: config.WORKSPACE_MAX_BYTES_PER_USER,
      };
    },
  },
  {
    name: "files_stat",
    description: `Get one workspace file's size, mtime and expiry without reading its contents. Returns null when the name is not in your workspace. ${RETENTION}`,
    integration: FILES_INTEGRATION_NAME,
    inputSchema: z.object({ name: z.string() }),
    handler: async (ctx: any, args: any) => {
      const entry = await statFile(ctx.userId, args.name);
      return entry ?? { error: "NOT_FOUND" };
    },
  },
  {
    name: "files_read",
    description: `Read a workspace file. Use encoding 'utf8' for text and 'base64' for anything binary — a binary file read as utf8 comes back corrupted. Bytes pass through your context, so this is for files small enough to be worth that — a few KB of text, a config, a short CSV. For anything large, or anything you only need to grep or hand to another service, do NOT read it here: call files_presign({ name, op: 'download' }) and fetch the URL from wherever the bytes are actually needed. Oversize reads return TOO_LARGE rather than truncating, because a CSV cut off mid-row still parses. ${RETENTION}`,
    integration: FILES_INTEGRATION_NAME,
    inputSchema: z.object({
      name: z.string(),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
      maxBytes: z.number().int().positive().optional(),
    }),
    handler: async (ctx: any, args: any) => {
      try {
        const buf = await readFileBytes(ctx.userId, args.name, args.maxBytes);
        return {
          name: args.name,
          bytes: buf.byteLength,
          encoding: args.encoding,
          content: buf.toString(args.encoding === "base64" ? "base64" : "utf8"),
        };
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "files_write",
    description: `Write a file into your workspace, so it can be uploaded into a page with browser_upload_file or handed to another integration. Use encoding 'base64' for binary content. The content passes through your context, so this is for small files you are composing yourself. For large content, or bytes that already exist somewhere else, do NOT paste them here: call files_presign({ name, op: 'upload' }) and PUT the raw body to the URL from where the bytes are. ${RETENTION}`,
    integration: FILES_INTEGRATION_NAME,
    inputSchema: z.object({
      name: z.string(),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    }),
    handler: async (ctx: any, args: any) => {
      try {
        const buf = Buffer.from(args.content, args.encoding === "base64" ? "base64" : "utf8");
        return await writeFileBytes(ctx.userId, args.name, buf);
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "files_presign",
    description: `Mint a short-lived URL for one workspace file, so something that cannot hold a workbench credential can fetch or write it — a service that ingests by URL, an upload target, or a transfer that should not pass through your context. op 'download' returns a URL that can be fetched repeatedly until it expires; op 'upload' returns a URL that accepts exactly one PUT of a raw body, writing to the name you named here (a name sent with the PUT is ignored). Default lifetime is 5 minutes and the token appears in the URL, so treat it as a secret and do not log it. ${RETENTION}`,
    integration: FILES_INTEGRATION_NAME,
    inputSchema: z.object({
      name: z.string(),
      op: z.enum(["download", "upload"]),
      ttlSeconds: z.number().int().positive().max(3600).optional(),
    }),
    handler: async (ctx: any, args: any) => {
      if (!userFilePath(ctx.userId, args.name)) return { error: "INVALID_NAME" };
      // A download grant for a file that is not there would 404 at redeem with
      // no explanation; fail now, where the caller can act on it.
      if (args.op === "download" && !(await statFile(ctx.userId, args.name))) {
        return { error: "NOT_FOUND" };
      }
      const minted = await mintPresign(ctx.userId, args.name, args.op, args.ttlSeconds);
      return {
        url: minted.url,
        op: minted.op,
        name: minted.name,
        expiresAt: new Date(minted.expiresAt).toISOString(),
        method: args.op === "download" ? "GET" : "PUT",
        singleUse: args.op === "upload",
      };
    },
  },
  {
    name: "files_delete",
    description:
      "Delete a file from your workspace. Files expire on their own after 24 hours; this is for reclaiming quota early.",
    integration: FILES_INTEGRATION_NAME,
    inputSchema: z.object({ name: z.string() }),
    handler: async (ctx: any, args: any) => {
      const deleted = await deleteFile(ctx.userId, args.name);
      if (!deleted) return { error: "NOT_FOUND" };
      await revokeFor(ctx.userId, args.name);
      return { ok: true, usedBytes: await usedBytes(ctx.userId) };
    },
  },
];

export const filesPlugin: Plugin = {
  integration: {
    name: FILES_INTEGRATION_NAME,
    version: "1.0.0",
    auth: { type: "none" },
    displayName: "Files",
    description:
      "Per-user file workspace. Browser downloads land here, uploads are read from here, and files can be passed between integrations without going through the model. Files are deleted 24 hours after they are written.",
    categories: ["files"],
  },
  tools,
};
