import { describe, it, expect, vi, afterEach } from "vitest";
import { searchDocuments } from "../../plugins/google-docs/tools/docs";
import {
  searchFiles,
  uploadFromUrl,
  listFiles,
  createFolder,
  uploadFile,
  downloadFile,
  trashFile,
  updatePermissions,
} from "../../plugins/google-drive/tools/drive";
import { searchSlides, createFromMarkdown } from "../../plugins/google-slides/tools/slides";

// Mock ctx.http that records the URL it was called with.
function recordingCtx(jsonReply: unknown = { files: [] }) {
  const urls: string[] = [];
  const bodies: string[] = [];
  const http = vi.fn(async (url: string, init?: any) => {
    urls.push(url);
    if (init?.body) bodies.push(init.body);
    return { json: async () => jsonReply };
  });
  return { ctx: { http } as any, urls, bodies };
}

function qParam(url: string): string {
  const u = new URL(url);
  return u.searchParams.get("q") ?? "";
}

describe("Drive query safety (#8) + orderBy encoding (#7)", () => {
  it("escapes single quotes in the user query (no injection)", async () => {
    const { ctx, urls } = recordingCtx();
    await searchDocuments.handler(ctx, {
      query: "test' or trashed=true or name contains '",
      pageSize: 10,
      orderBy: "modifiedTime desc",
    });
    const q = qParam(urls[0]);
    // The user's quotes must be backslash-escaped so they can't break out of
    // the literal — i.e. no bare `'` from user input lands unescaped.
    expect(q).toContain("name contains 'test\\' or trashed=true or name contains \\''");
    expect(q).not.toContain("name contains 'test' or trashed=true");
  });

  it("escapes quotes in google-drive searchFiles", async () => {
    const { ctx, urls } = recordingCtx();
    await searchFiles.handler(ctx, { query: "a' or b='", pageSize: 10 });
    const q = qParam(urls[0]);
    expect(q).toContain("a\\' or b=\\'");
  });

  it("escapes quotes in google-slides searchSlides", async () => {
    const { ctx, urls } = recordingCtx();
    await searchSlides.handler(ctx, { query: "x'y", pageSize: 10, orderBy: "modifiedTime desc" });
    expect(qParam(urls[0])).toContain("x\\'y");
  });

  it("encodes orderBy space as %20, not + (Drive rejects +)", async () => {
    const { ctx, urls } = recordingCtx();
    await searchDocuments.handler(ctx, { query: undefined, pageSize: 10, orderBy: "modifiedTime desc" });
    expect(urls[0]).toContain("orderBy=modifiedTime%20desc");
    expect(urls[0]).not.toContain("orderBy=modifiedTime+desc");
  });
});

describe("google_drive_upload_from_url", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches signed URL and uploads via multipart to Drive", async () => {
    const fileContent = "col1,col2\nval1,val2\n";
    const fileBytes = new TextEncoder().encode(fileContent);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/csv" }),
        arrayBuffer: async () => fileBytes.buffer,
      }))
    );

    const { ctx } = recordingCtx({ id: "file123", name: "report.csv", mimeType: "text/csv" });
    const result = await uploadFromUrl.handler(ctx, {
      url: "https://storage.example.com/signed/report.csv",
      name: "report.csv",
      parentId: "folder123",
    });

    expect(result.id).toBe("file123");
    expect(ctx.http).toHaveBeenCalledWith(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": expect.stringContaining("multipart/related"),
        }),
        body: expect.any(Uint8Array),
      })
    );
  });

  it("throws when the signed URL returns a non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, statusText: "Forbidden" }))
    );

    const { ctx } = recordingCtx();
    await expect(
      uploadFromUrl.handler(ctx, { url: "https://example.com/expired", name: "file.txt" })
    ).rejects.toThrow("Signed URL fetch failed: 403");
  });

  it.each([
    ["http:// URL", "http://storage.example.com/file.csv"],
    ["localhost", "https://localhost/secret"],
    ["RFC-1918 10.x", "https://10.0.0.1/metadata"],
    ["RFC-1918 172.16.x", "https://172.16.0.1/internal"],
    ["RFC-1918 192.168.x", "https://192.168.1.1/admin"],
    ["link-local 169.254.x (IMDS)", "https://169.254.169.254/latest/meta-data/"],
    ["loopback 127.0.0.1", "https://127.0.0.1/secret"],
    ["IPv6 loopback ::1", "https://[::1]/secret"],
    ["IPv6 ULA fc00::", "https://[fc00::1]/secret"],
    ["IPv6 link-local fe80::", "https://[fe80::1]/secret"],
  ])("blocks %s", async (_label, url) => {
    const { ctx } = recordingCtx();
    await expect(uploadFromUrl.handler(ctx, { url, name: "file.txt" })).rejects.toThrow();
  });
});

describe("createFromMarkdown inserts content (#9)", () => {
  it("adds insertText requests carrying each slide's markdown text", async () => {
    const { ctx, bodies } = recordingCtx();
    // first call creates the presentation, second is the batchUpdate
    ctx.http.mockImplementation(async (url: string, init?: any) => {
      if (url.endsWith("/presentations")) return { json: async () => ({ presentationId: "p1", title: "T" }) };
      if (init?.body) bodies.push(init.body);
      return { json: async () => ({}) };
    });

    await createFromMarkdown.handler(ctx, { title: "T", markdownText: "Hello world\n---\nSecond slide" });

    const batch = JSON.parse(bodies[bodies.length - 1]);
    const inserts = batch.requests.filter((r: any) => r.insertText);
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    const allText = inserts.map((r: any) => r.insertText.text).join("\n");
    expect(allText).toContain("Hello world");
    expect(allText).toContain("Second slide");
  });
});

describe("Shared Drive support", () => {
  const file = { fileId: "f1" };
  const cases: [string, any, any][] = [
    ["google_drive_list", listFiles, { pageSize: 10, query: "'sd-folder' in parents" }],
    ["google_drive_search", searchFiles, { query: "x", pageSize: 10 }],
    ["google_drive_create_folder", createFolder, { name: "n", parentId: "sd-folder" }],
    ["google_drive_upload", uploadFile, { name: "a.txt", content: "hi", mimeType: "text/plain", parentId: "sd-folder" }],
    ["google_drive_download", downloadFile, file],
    ["google_drive_trash", trashFile, file],
    ["google_drive_permissions", updatePermissions, { ...file, email: "dev@example.com", role: "reader" }],
  ];

  it.each(cases)("%s sends supportsAllDrives=true", async (_name, tool, args) => {
    const { ctx, urls } = recordingCtx();
    ctx.http.mockImplementation(async (url: string) => {
      urls.push(url);
      return { json: async () => ({ files: [] }), text: async () => "" };
    });
    await tool.handler(ctx, args);
    expect(new URL(urls[0]).searchParams.get("supportsAllDrives")).toBe("true");
  });

  it.each([
    ["google_drive_list", listFiles, { pageSize: 10 }],
    ["google_drive_search", searchFiles, { query: "x", pageSize: 10 }],
  ] as [string, any, any][])("%s includes items from all drives", async (_name, tool, args) => {
    const { ctx, urls } = recordingCtx();
    await tool.handler(ctx, args);
    expect(new URL(urls[0]).searchParams.get("includeItemsFromAllDrives")).toBe("true");
  });

  it("google_drive_upload_from_url sends supportsAllDrives=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "content-type": "text/plain" }),
        arrayBuffer: async () => new Uint8Array([104, 105]).buffer,
      }))
    );
    const { ctx, urls } = recordingCtx({ id: "f" });
    await uploadFromUrl.handler(ctx, { url: "https://storage.example.com/a.txt", name: "a.txt", parentId: "sd-folder" });
    expect(new URL(urls[0]).searchParams.get("supportsAllDrives")).toBe("true");
    vi.unstubAllGlobals();
  });
});
