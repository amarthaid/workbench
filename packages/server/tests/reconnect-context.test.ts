import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reconnect = vi.fn();
vi.mock("../src/auth/reconnect/runner", async (orig) => ({
  ...(await orig<typeof import("../src/auth/reconnect/runner")>()),
  reconnectSession: (...a: unknown[]) => reconnect(...a),
}));

import { db } from "../src/db";
import { registry } from "../src/plugins/registry";
import { storeCookies } from "../src/auth/cookie";
import { getReconnectState } from "../src/auth/reconnect/state";
import { createContext } from "../src/plugins/context";

const U = "user-ctx-reconnect";
const I = "acme-cookie";
const baseAuth = {
  type: "cookie" as const, loginUrl: "https://app.example.com/login",
  targetDomain: "app.example.com", cookieDomains: ["app.example.com"],
};
const cookie = (v: string) => ({ domain: "app.example.com", cookies: [{ name: "sid", value: v, domain: "app.example.com", path: "/", expires: 9999999999 }], capturedAt: 1 });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  reconnect.mockReset();
  await db.run("DELETE FROM connections WHERE user_id = ?", [U]);
  await storeCookies(U, I, cookie("tok-old"));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const withAuth = (auth: object) => vi.spyOn(registry, "getIntegration").mockReturnValue({ name: I, version: "1", auth } as any);

describe("ctx.http cookie reconnect", () => {
  it("without a session block, a 401 passes through untouched", async () => {
    withAuth(baseAuth);
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    const ctx = await createContext(U, I);
    expect((await ctx.http("https://app.example.com/api/x")).status).toBe(401);
    expect(reconnect).not.toHaveBeenCalled();
    expect((await getReconnectState(U, I)).deadAt).toBeUndefined();
  });

  it("session without reconnect: marks dead and passes the response through", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } } });
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    const ctx = await createContext(U, I);
    expect((await ctx.http("https://app.example.com/api/x")).status).toBe(401);
    expect((await getReconnectState(U, I)).deadAt).toBeTypeOf("number");
  });

  it("dead -> reconnect -> one retry with the new cookies", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } });
    fetchMock
      .mockResolvedValueOnce(new Response("no", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    reconnect.mockImplementation(async () => { await storeCookies(U, I, cookie("tok-new")); return { ok: true }; });
    const ctx = await createContext(U, I);
    const res = await ctx.http("https://app.example.com/api/x", { method: "POST", body: "{\"a\":1}" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(retryHeaders.get("cookie")).toBe("sid=tok-new");
    expect(fetchMock.mock.calls[1][1].body).toBe("{\"a\":1}");
  });

  it("retry that is still dead is returned, no second reconnect", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } });
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    reconnect.mockResolvedValue({ ok: true });
    const ctx = await createContext(U, I);
    expect((await ctx.http("https://app.example.com/api/x")).status).toBe(401);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("reconnect failure returns the original response", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } });
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    reconnect.mockResolvedValue({ ok: false, reason: "PROBE_FAILED" });
    const ctx = await createContext(U, I);
    expect((await ctx.http("https://app.example.com/api/x")).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streamed body: reconnects but does not retry", async () => {
    withAuth({ ...baseAuth, session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } });
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    reconnect.mockResolvedValue({ ok: true });
    const ctx = await createContext(U, I);
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } });
    expect((await ctx.http("https://app.example.com/api/x", { method: "POST", body, duplex: "half" } as RequestInit)).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
