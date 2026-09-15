import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer, type WebSocket as WS } from "ws";
import type { AddressInfo } from "node:net";

vi.mock("../src/config", () => ({
  config: {
    NODE_ENV: "test",
    ENCRYPTION_KEY: "0".repeat(64),
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    BROWSER_SESSION_TTL_SECONDS: 300,
    BROWSER_PROFILE_TTL_DAYS: 30,
    WORKSPACE_DIR: "./data/workspace",
  },
}));

import { CdpClient } from "../src/auth/browser-session";

let wss: WebSocketServer;
let serverSocket: WS;
let url: string;

beforeEach(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

async function connect(): Promise<CdpClient> {
  const connected = new Promise<WS>((resolve) => wss.once("connection", (s) => resolve(s)));
  const client = new CdpClient(url);
  serverSocket = await connected;
  await client.ready;
  return client;
}

/** Push a CDP event frame (no `id`) down to the client. */
function emit(method: string, params: Record<string, unknown> = {}): void {
  serverSocket.send(JSON.stringify({ method, params }));
}

/** Let the socket deliver whatever is queued. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe("CdpClient events", () => {
  it("delivers an event frame to a listener for its method", async () => {
    const client = await connect();
    const seen: Record<string, unknown>[] = [];
    client.on("Browser.downloadProgress", (p) => seen.push(p));

    emit("Browser.downloadProgress", { guid: "g1", state: "completed" });
    await settle();

    expect(seen).toEqual([{ guid: "g1", state: "completed" }]);
    client.close();
  });

  it("does not deliver to a listener for another method", async () => {
    const client = await connect();
    const other = vi.fn();
    client.on("Network.responseReceived", other);

    emit("Browser.downloadProgress", { guid: "g1" });
    await settle();

    expect(other).not.toHaveBeenCalled();
    client.close();
  });

  it("stops delivery after unsubscribe", async () => {
    const client = await connect();
    const fn = vi.fn();
    const off = client.on("Browser.downloadWillBegin", fn);

    emit("Browser.downloadWillBegin", { guid: "g1" });
    await settle();
    off();
    emit("Browser.downloadWillBegin", { guid: "g2" });
    await settle();

    expect(fn).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("fans one event out to every listener on that method", async () => {
    const client = await connect();
    const a = vi.fn();
    const b = vi.fn();
    client.on("Page.loadEventFired", a);
    client.on("Page.loadEventFired", b);

    emit("Page.loadEventFired", {});
    await settle();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("survives a listener that throws, and still runs the others", async () => {
    const client = await connect();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const good = vi.fn();
    client.on("Page.loadEventFired", () => {
      throw new Error("boom");
    });
    client.on("Page.loadEventFired", good);

    emit("Page.loadEventFired", {});
    await settle();

    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();

    // The socket is still usable: a command still round-trips.
    serverSocket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      serverSocket.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
    });
    await expect(client.send("Page.getLayoutMetrics")).resolves.toEqual({ ok: true });

    warn.mockRestore();
    client.close();
  });

  it("still dispatches command replies", async () => {
    const client = await connect();
    serverSocket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      serverSocket.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method } }));
    });

    await expect(client.send("Page.navigate", { url: "about:blank" })).resolves.toEqual({
      echoed: "Page.navigate",
    });
    client.close();
  });

  it("clears listeners and rejects in-flight commands when the socket dies", async () => {
    const client = await connect();
    const fn = vi.fn();
    client.on("Browser.downloadProgress", fn);
    const inflight = client.send("Page.navigate", { url: "about:blank" });

    serverSocket.close();
    await expect(inflight).rejects.toThrow(/closed/);

    // A download waiter has no command in flight, so nothing else would ever
    // wake it — the listener map has to be torn down with the socket.
    emit("Browser.downloadProgress", { guid: "g1" });
    await settle();
    expect(fn).not.toHaveBeenCalled();
  });

  it("ignores an event frame with no method", async () => {
    const client = await connect();
    const fn = vi.fn();
    client.on("Browser.downloadProgress", fn);

    serverSocket.send(JSON.stringify({ params: { guid: "g1" } }));
    serverSocket.send("not json at all");
    await settle();

    expect(fn).not.toHaveBeenCalled();
    client.close();
  });
});
