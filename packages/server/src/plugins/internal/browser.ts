// Built-in browser as an internal registry plugin. Lives in server source —
// NOT under PLUGINS_DIR — because the handlers reach straight into
// browser-session. Keeping it internal also keeps that capability out of the
// plugin ToolContext: a third-party plugin must never be able to drive the
// user's logged-in capture browser (cookie/session exfiltration).
import { z } from "zod";
import { Plugin, PluginTool } from "../registry";
import { config } from "../../config";
import { signConnectToken } from "../../auth/connect-token";
import { createPending } from "../../auth/connections";
import {
  ensureSession,
  touch,
  navigate as browserNavigate,
  screenshot as browserScreenshot,
  click as browserClick,
  typeText as browserType,
  pressKey as browserKey,
  scroll as browserScroll,
  readText as browserReadText,
  closeBrowserSession,
  browserClient,
  ensureDownloadRouting,
} from "../../auth/browser-session";
import { expectDownload, awaitDownload } from "../../auth/browser-downloads";
import { uploadWorkspaceFile, BrowserUploadError } from "../../auth/browser-upload";

export const BROWSER_INTEGRATION_NAME = "browser";

const tools: PluginTool[] = [
  {
    name: "browser_navigate",
    description: "Navigate the per-user browser session to a URL. Opens a warm session if none is active. Returns the final url and page title.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({
      url: z.string().url().refine(
        (u) => /^https?:\/\//i.test(u),
        { message: "Only http and https URLs are allowed" }
      ),
    }),
    handler: async (ctx: any, args: any) => {
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
      return browserNavigate(s, args.url);
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a screenshot of the current viewport so you can see the page. Costs vision tokens — call it only when the page likely changed and you need to look; after a click/type, act on what you already saw unless the result is uncertain. Downscaled JPEG by default (maxWidth 1000). If the pixels are identical to your last shot it returns { unchanged: true } instead of an image. For text-heavy pages prefer browser_read_text.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({
      format: z.enum(["jpeg", "png"]).optional(),
      quality: z.number().int().min(1).max(100).optional(),
      maxWidth: z.number().int().positive().optional(),
    }),
    handler: async (ctx: any, args: any) => {
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
      return browserScreenshot(s, args);
    },
  },
  {
    name: "browser_click",
    description: "Click at viewport coordinates (x, y) in the per-user browser session.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle"]).default("left"),
    }),
    handler: async (ctx: any, args: any) => {
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
      await browserClick(s, args.x, args.y, args.button);
      return { ok: true };
    },
  },
  {
    name: "browser_type",
    description: "Type text into the currently focused element. Click the field first.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({ text: z.string() }),
    handler: async (ctx: any, args: any) => {
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
      await browserType(s, args.text);
      return { ok: true };
    },
  },
  {
    name: "browser_key",
    description: "Press a key or chord, e.g. 'Enter', 'Tab', 'ctrl+a', 'ArrowDown'.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({ keys: z.string() }),
    handler: async (ctx: any, args: any) => {
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
      await browserKey(s, args.keys);
      return { ok: true };
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the viewport up/down/left/right by an optional pixel amount (default 600).",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().positive().default(600),
    }),
    handler: async (ctx: any, args: any) => {
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
      await browserScroll(s, args.direction, args.amount);
      return { ok: true };
    },
  },
  {
    name: "browser_read_text",
    description: "Read the visible text of the current page (document.innerText) as plain text — far cheaper than a screenshot for text-heavy pages, forms, and reading. Use this instead of browser_screenshot when you don't need to see layout/pixels.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({ maxChars: z.number().int().positive().optional() }),
    handler: async (ctx: any, args: any) => {
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
      return browserReadText(s, args.maxChars);
    },
  },
  {
    name: "browser_expect_download",
    description:
      "Arm a wait for a file download BEFORE the click that triggers it, then call browser_await_download after. A download is a side effect of a click, not something you can request by URL, so the order matters: arm, click, await. Returns a handle. Downloads always land in your files workspace whether or not you armed a wait, so if you forget, check files_list. Captured files are deleted 24 hours after they land — move anything you need to keep to a durable destination in the same run.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({}),
    handler: async (ctx: any) => {
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
      // Arming is the point at which routing has to be real, so wait for it
      // here rather than at session creation.
      await ensureDownloadRouting(s);
      const client = await browserClient(s);
      return expectDownload(ctx.userId, client, () => touch(ctx.userId));
    },
  },
  {
    name: "browser_await_download",
    description:
      "Wait for the download armed by browser_expect_download to finish, and return { name, bytes, expiresAt } for the file now in your workspace. Read it with files_read, hand it on with files_presign, or upload it into another page with browser_upload_file.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({
      handle: z.string(),
      timeoutMs: z.number().int().positive().max(600_000).default(120_000),
    }),
    handler: async (_ctx: any, args: any) => {
      try {
        return await awaitDownload(args.handle, args.timeoutMs);
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  },
  {
    name: "browser_upload_file",
    description:
      "Put a file from your workspace into a file input on the current page. `name` is a workspace-relative filename (see files_list) — not a path; absolute paths and anything outside your workspace are refused. `selector` is a CSS selector for the <input type=\"file\">. Write the file first with files_write, or capture it with browser_expect_download.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({ selector: z.string(), name: z.string() }),
    handler: async (ctx: any, args: any) => {
      const s = await ensureSession(ctx.userId);
      touch(ctx.userId);
      try {
        const done = await uploadWorkspaceFile(s.cdp, ctx.userId, args.selector, args.name);
        return { ok: true, name: done.name };
      } catch (e) {
        if (e instanceof BrowserUploadError) {
          return e.message !== e.code ? { error: e.code, detail: e.message } : { error: e.code };
        }
        throw e;
      }
    },
  },
  {
    name: "browser_close",
    description: "Close the per-user warm browser session (the persistent profile is kept). Frees the single-writer lock so a cookie capture can run.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({}),
    handler: async (ctx: any) => {
      await closeBrowserSession(ctx.userId);
      return { ok: true };
    },
  },
  {
    name: "browser_live_url",
    description: "Get a short-lived URL to watch and take over the per-user browser session in a web canvas. Open it to drive the same browser by hand, then return control to the model.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({}),
    handler: async (ctx: any) => {
      // No ensureSession here: the session is warmed at redeem time, after the
      // opener proves they own this account.
      const rec = createPending({
        userId: ctx.userId,
        integration: "__browser__",
        // "cookie" is a stand-in: ConnectionType has no browser member, and
        // type is never read back for a "__browser__" record.
        type: "cookie",
        ttlSeconds: config.CONNECT_TTL_SECONDS,
      });
      const jwt = await signConnectToken(
        { connectionId: rec.connectionId, userId: ctx.userId, integration: "__browser__", sessionId: ctx.userId },
        config.CONNECT_TTL_SECONDS
      );
      return { url: `${config.PORTAL_URL}/browser?t=${jwt}` };
    },
  },
];

export const browserPlugin: Plugin = {
  integration: {
    name: BROWSER_INTEGRATION_NAME,
    version: "1.0.0",
    auth: { type: "none" },
    displayName: "Browser",
    description:
      "Built-in headless browser the agent drives directly (navigate, click, type, screenshot). Open a live view to take over by hand.",
    categories: ["browser"],
  },
  tools,
};
