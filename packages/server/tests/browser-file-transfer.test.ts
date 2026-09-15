import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

vi.mock("../src/workspace/dir", () => ({ workspaceRoot: () => tmp }));
vi.mock("../src/config", () => ({
  config: {
    NODE_ENV: "test",
    ENCRYPTION_KEY: "0".repeat(64),
    DATABASE_URL: "./data/tokens.db",
    BROWSER_SESSION_TTL_SECONDS: 300,
    WORKSPACE_TTL_HOURS: 24,
    WORKSPACE_MAX_FILE_BYTES: 1000,
    WORKSPACE_MAX_BYTES_PER_USER: 5000,
  },
}));

import {
  configureDownloads,
  expectDownload,
  awaitDownload,
  cancelDownloads,
  _test,
} from "../src/auth/browser-downloads";
import { uploadWorkspaceFile, BrowserUploadError } from "../src/auth/browser-upload";
import { userWorkspaceDir } from "../src/workspace/paths";
import { writeFileBytes } from "../src/workspace/store";

/** Stand-in for CdpClient: records sends and lets a test push events down. */
function fakeClient() {
  const listeners = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const replies = new Map<string, Record<string, unknown>>();
  return {
    sent,
    replies,
    on(method: string, fn: (p: Record<string, unknown>) => void) {
      let set = listeners.get(method);
      if (!set) { set = new Set(); listeners.set(method, set); }
      set.add(fn);
      return () => { set!.delete(fn); };
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      sent.push({ method, params });
      return replies.get(method) ?? {};
    },
    emit(method: string, params: Record<string, unknown>) {
      for (const fn of [...(listeners.get(method) ?? [])]) fn(params);
    },
    listenerCount(method: string) {
      return listeners.get(method)?.size ?? 0;
    },
  };
}

type Fake = ReturnType<typeof fakeClient>;

/** Write the file chromium would have written under `allowAndName`. */
function chromiumWrites(userId: string, guid: string, bytes: number): void {
  const dir = userWorkspaceDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, guid), "x".repeat(bytes));
}

async function capture(
  client: Fake,
  userId: string,
  guid: string,
  suggested: unknown,
  bytes = 10
) {
  const { handle } = expectDownload(userId, client as never);
  const done = awaitDownload(handle, 2000);
  client.emit("Browser.downloadWillBegin", { guid, suggestedFilename: suggested });
  chromiumWrites(userId, guid, bytes);
  client.emit("Browser.downloadProgress", { guid, state: "completed" });
  return done;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-xfer-"));
  _test.pending.clear();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("download routing", () => {
  it("points chromium at the user's workspace with allowAndName", async () => {
    const client = fakeClient();
    await configureDownloads("u1", client as never);

    expect(client.sent).toEqual([
      {
        method: "Browser.setDownloadBehavior",
        params: {
          behavior: "allowAndName",
          downloadPath: userWorkspaceDir("u1"),
          eventsEnabled: true,
        },
      },
    ]);
  });

  it("creates the workspace dir, since chromium will not", async () => {
    const client = fakeClient();
    await configureDownloads("u1", client as never);
    expect(fs.existsSync(userWorkspaceDir("u1"))).toBe(true);
  });

  it("routes two users to two different directories", async () => {
    const a = fakeClient();
    const b = fakeClient();
    await configureDownloads("u1", a as never);
    await configureDownloads("u2", b as never);
    expect(a.sent[0].params.downloadPath).not.toBe(b.sent[0].params.downloadPath);
  });
});

describe("download capture", () => {
  it("renames the GUID file to the sanitized suggested name", async () => {
    const client = fakeClient();
    const got = await capture(client, "u1", "guid-1", "statement.csv", 8);

    expect(got).toMatchObject({ name: "statement.csv", bytes: 8 });
    expect(fs.existsSync(path.join(userWorkspaceDir("u1"), "statement.csv"))).toBe(true);
    expect(fs.existsSync(path.join(userWorkspaceDir("u1"), "guid-1"))).toBe(false);
  });

  it("keeps a traversal suggestedFilename inside the workspace", async () => {
    // suggestedFilename comes from the remote server's Content-Disposition.
    const client = fakeClient();
    const got = await capture(client, "u1", "guid-2", "../../escape.csv");

    expect(got.name).toBe("escape.csv");
    expect(fs.existsSync(path.join(tmp, "escape.csv"))).toBe(false);
    expect(fs.existsSync(path.join(userWorkspaceDir("u1"), "escape.csv"))).toBe(true);
  });

  it.each([["", "empty"], ["..", "dots"], ["/", "separator"]])(
    "falls back to a generated name for a %s suggestion (%s)",
    async (suggested) => {
      const client = fakeClient();
      const got = await capture(client, "u1", `guid-${suggested.length}-x`, suggested);
      expect(got.name).toMatch(/^download-/);
    }
  );

  it("does not clobber when two downloads suggest the same name", async () => {
    const client = fakeClient();
    const first = await capture(client, "u1", "guid-a", "report.csv");
    const second = await capture(client, "u1", "guid-b", "report.csv");

    expect(first.name).toBe("report.csv");
    expect(second.name).toBe("report (2).csv");
  });

  it("rejects a canceled download", async () => {
    const client = fakeClient();
    const { handle } = expectDownload("u1", client as never);
    const done = awaitDownload(handle, 2000);
    client.emit("Browser.downloadWillBegin", { guid: "g", suggestedFilename: "x.csv" });
    client.emit("Browser.downloadProgress", { guid: "g", state: "canceled" });

    await expect(done).rejects.toThrow("DOWNLOAD_CANCELED");
  });

  it("rejects a download over the per-file cap and leaves nothing", async () => {
    const client = fakeClient();
    const done = capture(client, "u1", "guid-big", "big.bin", 1200);
    await expect(done).rejects.toThrow("TOO_LARGE");
    expect(fs.readdirSync(userWorkspaceDir("u1"))).toEqual([]);
  });

  it("keeps the session alive while bytes are moving", async () => {
    const client = fakeClient();
    const onProgress = vi.fn();
    const { handle } = expectDownload("u1", client as never, onProgress);
    client.emit("Browser.downloadWillBegin", { guid: "g", suggestedFilename: "x.csv" });
    client.emit("Browser.downloadProgress", { guid: "g", state: "inProgress", receivedBytes: 1 });
    client.emit("Browser.downloadProgress", { guid: "g", state: "inProgress", receivedBytes: 2 });

    expect(onProgress).toHaveBeenCalledTimes(2);
    cancelDownloads("u1");
    await expect(awaitDownload(handle).catch((e) => e)).resolves.toBeInstanceOf(Error);
  });

  it("unsubscribes once a download settles", async () => {
    const client = fakeClient();
    await capture(client, "u1", "guid-c", "a.csv");
    expect(client.listenerCount("Browser.downloadProgress")).toBe(0);
    expect(client.listenerCount("Browser.downloadWillBegin")).toBe(0);
  });

  it("times out rather than hanging forever", async () => {
    const client = fakeClient();
    const { handle } = expectDownload("u1", client as never);
    await expect(awaitDownload(handle, 20)).rejects.toThrow("DOWNLOAD_TIMEOUT");
  });

  it("rejects an unknown handle", async () => {
    await expect(awaitDownload("nope")).rejects.toThrow("UNKNOWN_HANDLE");
  });

  it("drops armed waits when the session closes", async () => {
    const client = fakeClient();
    const { handle } = expectDownload("u1", client as never);
    const done = awaitDownload(handle, 5000);
    cancelDownloads("u1");
    await expect(done).rejects.toThrow("SESSION_CLOSED");
  });
});

describe("browser_upload_file", () => {
  function pageWith(tag: string) {
    const client = fakeClient();
    client.replies.set("Runtime.evaluate", { result: { objectId: "obj-1" } });
    client.replies.set("Runtime.callFunctionOn", { result: { value: tag } });
    return client;
  }

  it("refuses a traversal name before any CDP call is made", async () => {
    const client = pageWith("INPUT:file");
    await expect(
      uploadWorkspaceFile(client as never, "u1", "input[type=file]", "../../../data/tokens.db")
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
    // Nothing reached the browser: the guard is before the wire, not after.
    expect(client.sent).toEqual([]);
  });

  it("refuses an absolute path", async () => {
    const client = pageWith("INPUT:file");
    await expect(
      uploadWorkspaceFile(client as never, "u1", "input", "/etc/passwd")
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
    expect(client.sent).toEqual([]);
  });

  it("refuses a symlink that escapes the workspace", async () => {
    const dir = userWorkspaceDir("u1");
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(os.tmpdir(), `secret-${Date.now()}`);
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(dir, "link.csv"));

    const client = pageWith("INPUT:file");
    await expect(
      uploadWorkspaceFile(client as never, "u1", "input", "link.csv")
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
    expect(client.sent).toEqual([]);

    fs.rmSync(outside, { force: true });
  });

  it("refuses a name that is not in the workspace", async () => {
    const client = pageWith("INPUT:file");
    await expect(
      uploadWorkspaceFile(client as never, "u1", "input", "missing.csv")
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
  });

  it("reports a selector that matches nothing", async () => {
    await writeFileBytes("u1", "a.csv", Buffer.from("x"));
    const client = fakeClient();
    client.replies.set("Runtime.evaluate", { result: {} });

    await expect(
      uploadWorkspaceFile(client as never, "u1", "#nope", "a.csv")
    ).rejects.toMatchObject({ code: "NO_SUCH_ELEMENT" });
  });

  it("reports a node that is not a file input, and says what it found", async () => {
    await writeFileBytes("u1", "a.csv", Buffer.from("x"));
    const client = pageWith("TEXTAREA:");

    await expect(
      uploadWorkspaceFile(client as never, "u1", "textarea", "a.csv")
    ).rejects.toMatchObject({ code: "NOT_A_FILE_INPUT", message: "TEXTAREA:" });
  });

  it("sets the resolved absolute path on a real file input", async () => {
    await writeFileBytes("u1", "a.csv", Buffer.from("x,y"));
    const client = pageWith("INPUT:file");

    const done = await uploadWorkspaceFile(client as never, "u1", "input[type=file]", "a.csv");

    expect(done.name).toBe("a.csv");
    const call = client.sent.find((c) => c.method === "DOM.setFileInputFiles");
    expect(call).toBeDefined();
    expect(call!.params.files).toEqual([path.join(userWorkspaceDir("u1"), "a.csv")]);
    expect(call!.params.objectId).toBe("obj-1");
  });

  it("is a BrowserUploadError, so callers can branch on the code", async () => {
    const client = pageWith("INPUT:file");
    const err = await uploadWorkspaceFile(client as never, "u1", "input", "../x").catch((e) => e);
    expect(err).toBeInstanceOf(BrowserUploadError);
  });
});
