import { z } from "zod";

// SSRF guard for google_drive_upload_from_url: the caller gives us an
// arbitrary URL and the server fetches it. A check on only the URL the
// model supplied is not enough — a public HTTPS endpoint can answer 302 to
// an internal address, and Node's default fetch follows that silently,
// handing the internal response straight into the caller's Drive. Every
// hop (the original URL and every redirect Location) gets the same literal
// private/loopback-range check, https is required on every hop, and the
// number of hops is capped.
const PRIVATE_IPV4 = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/;
const PRIVATE_IPV6 = /^(::1$|fc|fd|fe80)/i;

function assertSafeFetchTarget(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error("Only https:// URLs are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost" || host.endsWith(".localhost") || PRIVATE_IPV4.test(host) || PRIVATE_IPV6.test(host)) {
    throw new Error("Requests to private or internal addresses are not allowed");
  }
}

const MAX_REDIRECT_HOPS = 5;

/** fetch() that re-validates every redirect hop instead of following blindly. */
async function fetchFollowingSafeRedirects(startUrl: URL): Promise<Response> {
  let url = startUrl;
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    assertSafeFetchTarget(url);
    res = await fetch(url, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      url = new URL(loc, url);
      continue;
    }
    break;
  }
  if (!res) throw new Error("Signed URL fetch failed: no response");
  return res;
}

// Slim file row shared by list/search — drops etags, links, owner blobs etc.
// (raw Drive file resources are ~20x this size). size is omitted for Google
// Docs-native files, which have none.
function slimFileRow(f: any) {
  const row: any = {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
  };
  if (f.size !== undefined) row.size = f.size;
  return row;
}

// Drive ignores Shared Drive items unless every call opts in: without
// supportsAllDrives a Shared Drive file/folder id 404s ("File not found"), and
// files.list without includeItemsFromAllDrives silently drops Shared Drive rows.
// No extra OAuth scope is needed.
const ALL_DRIVES = "supportsAllDrives=true";

export const listFiles = {
  name: "google_drive_list",
  description:
    "List files in Google Drive, optionally filtered by a raw Drive query string (`query`, Drive q syntax, e.g. \"mimeType='application/pdf'\"). Returns up to pageSize (default 10) slim rows { id, name, mimeType, modifiedTime, size? } plus nextPageToken for paging. For keyword/full-text lookups prefer google_drive_search (it escapes the query for you).",
  integration: "google-drive",
  inputSchema: z.object({
    pageSize: z.number().default(10),
    query: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("pageSize", String(args.pageSize));
    if (args.query) params.set("q", args.query);
    params.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size)");
    params.set("supportsAllDrives", "true");
    params.set("includeItemsFromAllDrives", "true");

    const res = await ctx.http(`https://www.googleapis.com/drive/v3/files?${params}`);
    const data = await res.json();
    const out: any = { files: (data.files ?? []).map(slimFileRow) };
    if (data.nextPageToken) out.nextPageToken = data.nextPageToken;
    return out;
  },
};

export const createFolder = {
  name: "google_drive_create_folder",
  description: "Create a folder in Google Drive",
  integration: "google-drive",
  inputSchema: z.object({
    name: z.string(),
    parentId: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`https://www.googleapis.com/drive/v3/files?${ALL_DRIVES}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: args.name,
        mimeType: "application/vnd.google-apps.folder",
        parents: args.parentId ? [args.parentId] : undefined,
      }),
    });
    return res.json();
  },
};

export const searchFiles = {
  name: "google_drive_search",
  description:
    "Search Google Drive by keyword — matches file names AND document contents (full text), with the query safely escaped. Returns up to pageSize (default 10) slim rows { id, name, mimeType, modifiedTime, size? } plus nextPageToken. Use google_drive_list with a raw Drive q expression for structured filters (mimeType, folder, date).",
  integration: "google-drive",
  inputSchema: z.object({
    query: z.string(),
    pageSize: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    // Escape backslash + single-quote so user input can't break out of the
    // Drive `q` string literal (query injection). Drive escapes with a backslash.
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const term = esc(args.query);
    params.set("q", `name contains '${term}' or fullText contains '${term}'`);
    params.set("pageSize", String(args.pageSize));
    params.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size)");
    params.set("supportsAllDrives", "true");
    params.set("includeItemsFromAllDrives", "true");
    const res = await ctx.http(`https://www.googleapis.com/drive/v3/files?${params.toString().replace(/\+/g, "%20")}`);
    const data = await res.json();
    const out: any = { files: (data.files ?? []).map(slimFileRow) };
    if (data.nextPageToken) out.nextPageToken = data.nextPageToken;
    return out;
  },
};

export const uploadFile = {
  name: "google_drive_upload",
  description: "Upload a file to Google Drive",
  integration: "google-drive",
  inputSchema: z.object({
    name: z.string(),
    content: z.string(),
    mimeType: z.string().default("text/plain"),
    parentId: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const metadata = {
      name: args.name,
      mimeType: args.mimeType,
      parents: args.parentId ? [args.parentId] : undefined,
    };
    const boundary = "-------314159265358979323846";
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${args.mimeType}`,
      "",
      args.content,
      `--${boundary}--`,
    ].join("\r\n");

    const res = await ctx.http(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${ALL_DRIVES}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  },
};

export const uploadFromUrl = {
  name: "google_drive_upload_from_url",
  description:
    "Fetch a file from a signed or pre-authenticated URL (e.g. S3, GCS, CDN) and upload it directly to Google Drive — no need to pass file content inline. MIME type is auto-detected from the response Content-Type header when not specified. Returns the created Drive file { id, name, mimeType }.",
  integration: "google-drive",
  inputSchema: z.object({
    url: z.string().url(),
    name: z.string(),
    mimeType: z.string().optional(),
    parentId: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const parsed = new URL(args.url);
    const download = await fetchFollowingSafeRedirects(parsed);
    if (!download.ok) {
      throw new Error(`Signed URL fetch failed: ${download.status} ${download.statusText}`);
    }

    const detectedType = download.headers.get("content-type")?.split(";")[0].trim();
    const mimeType = args.mimeType ?? detectedType ?? "application/octet-stream";

    const fileBytes = new Uint8Array(await download.arrayBuffer());

    const metadata: Record<string, unknown> = { name: args.name, mimeType };
    if (args.parentId) metadata.parents = [args.parentId];

    const boundary = "-------314159265358979323846";
    const enc = new TextEncoder();
    const header = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const footer = enc.encode(`\r\n--${boundary}--`);

    const body = new Uint8Array(header.byteLength + fileBytes.byteLength + footer.byteLength);
    body.set(header, 0);
    body.set(fileBytes, header.byteLength);
    body.set(footer, header.byteLength + fileBytes.byteLength);

    const res = await ctx.http(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${ALL_DRIVES}`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      }
    );
    return res.json();
  },
};

export const downloadFile = {
  name: "google_drive_download",
  description: "Download a file from Google Drive",
  integration: "google-drive",
  inputSchema: z.object({
    fileId: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`https://www.googleapis.com/drive/v3/files/${args.fileId}?alt=media&${ALL_DRIVES}`);
    return res.text();
  },
};

export const trashFile = {
  name: "google_drive_trash",
  description: "Move a file to trash in Google Drive",
  integration: "google-drive",
  inputSchema: z.object({
    fileId: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`https://www.googleapis.com/drive/v3/files/${args.fileId}?${ALL_DRIVES}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    return res.json();
  },
};

export const updatePermissions = {
  name: "google_drive_permissions",
  description: "Update permissions for a Google Drive file",
  integration: "google-drive",
  inputSchema: z.object({
    fileId: z.string(),
    email: z.string().email(),
    role: z.enum(["reader", "commenter", "writer", "owner"]).default("reader"),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`https://www.googleapis.com/drive/v3/files/${args.fileId}/permissions?${ALL_DRIVES}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: args.role,
        type: "user",
        emailAddress: args.email,
      }),
    });
    return res.json();
  },
};
