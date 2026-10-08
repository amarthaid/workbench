import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    SERVER_PUBLIC_URL: "https://wb.example.com",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
    ENCRYPTION_KEY: "0".repeat(64),
    PORT: "3000",
  },
}));

vi.mock("../src/custom-apps/client", async (orig) => ({
  ...(await orig<typeof import("../src/custom-apps/client")>()),
  evictSession: vi.fn(),
}));

import { evictSession } from "../src/custom-apps/client";
import { db } from "../src/db";
import { listCustomApps } from "../src/custom-apps/store";
import { createHeadersApp, updateHeadersApp, HeadersAppError, verifyFailureMessage, VERIFY_TIMEOUT_MS } from "../src/custom-apps/headers-app";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ok = vi.fn(async () => undefined);
beforeEach(async () => { await db.run("DELETE FROM custom_apps"); ok.mockClear(); vi.mocked(evictSession).mockClear(); });

afterEach(async () => { await db.run("DELETE FROM custom_apps"); });

const args = { userId: "u1", name: "keyed", baseUrl: "https://mcp.example.com/mcp/", headers: [{ name: "X-Api-Key", value: "tok-abc" }] };

describe("createHeadersApp", () => {
  it("verifies with the supplied headers, then persists as a headers app", async () => {
    const app = await createHeadersApp(args, ok);
    expect(ok).toHaveBeenCalledWith("u1", "https://mcp.example.com/mcp", { "X-Api-Key": "tok-abc" });
    expect(app.metadata.authType).toBe("headers");
    expect(app.baseUrl).toBe("https://mcp.example.com/mcp");
    expect(app.headers).toEqual([{ name: "X-Api-Key", value: "tok-abc" }]);
  });

  it("persists nothing and leaks no value when verification fails", async () => {
    const bad = vi.fn(async () => { throw new StreamableHTTPError(401, "denied tok-abc"); });
    const err = await createHeadersApp(args, bad).catch((e) => e);
    expect(err).toBeInstanceOf(HeadersAppError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("tok-abc");
    expect(await listCustomApps("u1")).toHaveLength(0);
  });

  it("rejects invalid headers before any network call", async () => {
    const err = await createHeadersApp({ ...args, headers: [{ name: "Host", value: "x" }] }, ok).catch((e) => e);
    expect(err.status).toBe(400);
    expect(ok).not.toHaveBeenCalled();
  });

  it("rejects blocked URLs, own /mcp, and duplicate names", async () => {
    expect((await createHeadersApp({ ...args, baseUrl: "http://10.0.0.5/mcp" }, ok).catch((e) => e)).status).toBe(400);
    expect((await createHeadersApp({ ...args, baseUrl: "https://wb.example.com/mcp" }, ok).catch((e) => e)).status).toBe(400);
    await createHeadersApp(args, ok);
    expect((await createHeadersApp(args, ok).catch((e) => e)).status).toBe(409);
  });
});

describe("updateHeadersApp", () => {
  it("keeps a blank value, re-verifies, and saves", async () => {
    const app = await createHeadersApp(args, ok);
    ok.mockClear();
    const updated = await updateHeadersApp({ userId: "u1", id: app.id, headers: [{ name: "x-api-key" }, { name: "X-Tenant", value: "acme" }] }, ok);
    expect(updated.headers).toEqual([{ name: "X-Api-Key", value: "tok-abc" }, { name: "X-Tenant", value: "acme" }]);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("does not save when re-verification fails", async () => {
    const app = await createHeadersApp(args, ok);
    const bad = vi.fn(async () => { throw new Error("nope"); });
    await expect(updateHeadersApp({ userId: "u1", id: app.id, headers: [{ name: "X-Api-Key", value: "tok-new" }] }, bad)).rejects.toBeInstanceOf(HeadersAppError);
    expect((await listCustomApps("u1"))[0].headers).toEqual([{ name: "X-Api-Key", value: "tok-abc" }]);
  });

  it("404s for another user's app and 400s for an OAuth app", async () => {
    const app = await createHeadersApp(args, ok);
    expect((await updateHeadersApp({ userId: "u2", id: app.id, headers: [{ name: "X-A", value: "v" }] }, ok).catch((e) => e)).status).toBe(404);
    const { createCustomApp } = await import("../src/custom-apps/store");
    const oauth = await createCustomApp({ userId: "u1", name: "oa", baseUrl: "https://o.example.com/mcp", metadata: {}, clientId: "c" });
    expect((await updateHeadersApp({ userId: "u1", id: oauth.id, headers: [{ name: "X-A", value: "v" }] }, ok).catch((e) => e)).status).toBe(400);
  });
});

describe("verifyFailureMessage", () => {
  it("is status-only for HTTP errors and generic otherwise", () => {
    expect(verifyFailureMessage(new StreamableHTTPError(403, "secret"))).toBe("Server rejected the headers (HTTP 403)");
    expect(verifyFailureMessage(new Error("secret tok-abc"))).toBe("Could not connect to the server with these headers");
  });
});

describe("fix round 1", () => {
  it("evicts the session when create verification fails", async () => {
    await createHeadersApp(args, async () => { throw new Error("x"); }).catch(() => {});
    expect(evictSession).toHaveBeenCalledWith("u1", "https://mcp.example.com/mcp");
  });

  it("update drops a name absent from the request", async () => {
    const app = await createHeadersApp({ ...args, headers: [{ name: "X-A", value: "a" }, { name: "X-B", value: "b" }] }, ok);
    const updated = await updateHeadersApp({ userId: "u1", id: app.id, headers: [{ name: "X-A" }] }, ok);
    expect(updated.headers).toEqual([{ name: "X-A", value: "a" }]);
  });

  it("update with a blank value for a new name is a 400 and saves nothing", async () => {
    const app = await createHeadersApp(args, ok);
    const err = await updateHeadersApp({ userId: "u1", id: app.id, headers: [{ name: "X-Api-Key" }, { name: "X-New" }] }, ok).catch((e) => e);
    expect(err).toBeInstanceOf(HeadersAppError);
    expect(err.status).toBe(400);
    expect((await listCustomApps("u1"))[0].headers).toEqual([{ name: "X-Api-Key", value: "tok-abc" }]);
  });

  it("concurrent same-name creates: one wins, the other gets 409", async () => {
    const slow = async () => { await new Promise((r) => setTimeout(r, 20)); };
    const res = await Promise.allSettled([createHeadersApp(args, slow), createHeadersApp(args, slow)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(HeadersAppError);
    expect(rej.reason.status).toBe(409);
  });

  it("update verify failure with an HTTP status reports it without values, and evicts", async () => {
    const app = await createHeadersApp(args, ok);
    const bad = async () => { throw new StreamableHTTPError(401, "denied tok-new"); };
    const err = await updateHeadersApp({ userId: "u1", id: app.id, headers: [{ name: "X-Api-Key", value: "tok-new" }] }, bad).catch((e) => e);
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("tok-new");
    expect(evictSession).toHaveBeenCalledWith("u1", "https://mcp.example.com/mcp");
  });
});

describe("verify time limit", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("create 400s with the generic message, evicts, and persists nothing when verify never settles", async () => {
    vi.useFakeTimers();
    const hang = vi.fn(() => new Promise<void>(() => undefined));
    const p = createHeadersApp(args, hang).catch((e) => e);
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1);
    const err = await p;
    expect(err).toBeInstanceOf(HeadersAppError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Could not connect to the server with these headers");
    expect(evictSession).toHaveBeenCalled();
    vi.useRealTimers();
    expect(await listCustomApps("u1")).toHaveLength(0);
  });

  it("update times out the same way and keeps the stored headers", async () => {
    const app = await createHeadersApp(args, ok);
    vi.useFakeTimers();
    const hang = vi.fn(() => new Promise<void>(() => undefined));
    const p = updateHeadersApp({ userId: "u1", id: app.id, headers: [{ name: "X-Api-Key", value: "tok-new" }] }, hang).catch((e) => e);
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1);
    const err = await p;
    expect(err.status).toBe(400);
    vi.useRealTimers();
    expect((await listCustomApps("u1"))[0].headers).toEqual([{ name: "X-Api-Key", value: "tok-abc" }]);
  });
});
