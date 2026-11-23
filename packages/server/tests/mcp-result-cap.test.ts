import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

vi.mock("../src/workspace/dir", () => ({ workspaceRoot: () => tmp }));

import {
  renderResultText,
  truncateResultText,
  MAX_RESULT_CHARS,
  OVERFLOW_PREVIEW_CHARS,
} from "../src/mcp/result-overflow";
import { registerWorkspaceRoutes } from "../src/workspace/routes";
import { _setNowForTest } from "../src/workspace/presign";
import { listFiles } from "../src/workspace/store";
import { config } from "../src/config";
import { db } from "../src/db";

let app: FastifyInstance;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-overflow-"));
  _setNowForTest(() => Date.now());
  await db.run("DELETE FROM pending_auth");
  app = Fastify();
  await registerWorkspaceRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  _setNowForTest(() => Date.now());
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The URL is absolute (SERVER_PUBLIC_URL); inject wants the path.
const pathOf = (url: string) => new URL(url).pathname;

describe("tool result size cap", () => {
  it("passes small results through untouched", async () => {
    const result = { ok: true };
    expect(await renderResultText("u1", result)).toBe(JSON.stringify(result));
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("passes a result exactly at the cap through untouched", async () => {
    // JSON.stringify of a string adds two quote characters.
    const result = "x".repeat(MAX_RESULT_CHARS - 2);
    expect(await renderResultText("u1", result)).toBe(JSON.stringify(result));
  });

  it("offloads an oversized result to a presigned URL that serves the whole payload", async () => {
    const result = { rows: Array.from({ length: 5_000 }, (_, i) => ({ i, text: "lorem ipsum ".repeat(2) })) };
    const full = JSON.stringify(result);
    expect(full.length).toBeGreaterThan(MAX_RESULT_CHARS);

    const out = await renderResultText("u1", result);
    expect(out.length).toBeLessThan(MAX_RESULT_CHARS);
    const stub = JSON.parse(out);
    expect(stub._overflow).toBe(true);
    expect(stub.bytes).toBe(Buffer.byteLength(full));
    expect(stub.preview).toBe(full.slice(0, OVERFLOW_PREVIEW_CHARS));
    expect(stub.hint).toMatch(/curl/);
    expect(stub.url.startsWith(`${config.SERVER_PUBLIC_URL}/api/files/dl/`)).toBe(true);

    // Multi-use inside the TTL, no auth header, and the body parses back intact.
    for (let n = 0; n < 2; n++) {
      const res = await app.inject({ method: "GET", url: pathOf(stub.url) });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(result);
    }

    // The file also sits in the caller's workspace under the stub's name.
    expect((await listFiles("u1")).map((f) => f.name)).toContain(stub.file);
    // And never in another user's.
    expect(await listFiles("u2")).toEqual([]);
  });

  it("stops serving the URL once it expires", async () => {
    const stub = JSON.parse(await renderResultText("u1", "z".repeat(MAX_RESULT_CHARS + 10)));
    _setNowForTest(() => Date.now() + (config.WORKSPACE_PRESIGN_TTL_SECONDS + 5) * 1000);
    const res = await app.inject({ method: "GET", url: pathOf(stub.url) });
    expect(res.statusCode).toBe(404);
    expect(new Date(stub.url_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("offloads only the oversized items of an execute_tools batch, one URL each", async () => {
    const big = (tag: string) => ({ tag, body: "b".repeat(MAX_RESULT_CHARS) });
    const batch = {
      results: [
        { result: { small: 1 } },
        { result: big("first") },
        { error: "NOT_CONNECTED", integration: "jira" },
        { result: big("second") },
      ],
    };

    const out = JSON.parse(await renderResultText("u1", batch));
    expect(out._overflow).toBeUndefined();
    expect(out.results[0]).toEqual({ result: { small: 1 } });
    expect(out.results[2]).toEqual({ error: "NOT_CONNECTED", integration: "jira" });

    const stubs = [out.results[1].result, out.results[3].result];
    expect(stubs.every((s: { _overflow?: boolean }) => s._overflow)).toBe(true);
    expect(stubs[0].url).not.toBe(stubs[1].url);

    const first = await app.inject({ method: "GET", url: pathOf(stubs[0].url) });
    expect(JSON.parse(first.body)).toEqual(big("first"));
    const second = await app.inject({ method: "GET", url: pathOf(stubs[1].url) });
    expect(JSON.parse(second.body)).toEqual(big("second"));
  });

  it("leaves a batch inline once offloading the largest item is enough", async () => {
    const batch = {
      results: [
        { result: { body: "s".repeat(MAX_RESULT_CHARS / 2) } },
        { result: { body: "L".repeat(MAX_RESULT_CHARS) } },
      ],
    };
    const out = JSON.parse(await renderResultText("u1", batch));
    expect(out.results[0]).toEqual(batch.results[0]);
    expect(out.results[1].result._overflow).toBe(true);
  });

  it("falls back to truncation when the workspace refuses the write", async () => {
    const huge = "q".repeat(config.WORKSPACE_MAX_FILE_BYTES + 1);
    const out = await renderResultText("u1", huge);
    expect(out).toContain("[result truncated");
    expect(out.length).toBeLessThan(MAX_RESULT_CHARS + 500);
  });
});

describe("truncateResultText", () => {
  it("cuts and appends a notice", () => {
    const text = "y".repeat(MAX_RESULT_CHARS + 5_000);
    const capped = truncateResultText(text);
    expect(capped.startsWith("y".repeat(100))).toBe(true);
    expect(capped).toContain("[result truncated");
    expect(capped).toContain(String(text.length));
  });
});
