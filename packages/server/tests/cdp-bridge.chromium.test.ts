/**
 * The CDP bridge against a REAL chromium, end to end: attach dials the page
 * target, the SSE stream carries actual jpeg screencast frames back, and a
 * command POST reaches the page and answers on the stream.
 *
 * cdp-bridge.test.ts covers the transport's own rules with a fake socket. This
 * file is the one that would catch chromium disagreeing with us — an Origin it
 * refuses, a frame shape we mis-normalise — which no fake can tell you.
 *
 * Runs only when `TEST_CHROMIUM=1` and playwright's chromium is installed,
 * since a browser download is not a test dependency; skipped loudly otherwise.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { cfg, authorizeMock } = vi.hoisted(() => ({
  cfg: {
    PORTAL_URL: "http://127.0.0.1:0",
    SERVER_PUBLIC_URL: "http://127.0.0.1:0",
    BROWSER_PROFILES_DIR: "",
    DATABASE_URL: "./data/tokens.db",
    BROWSER_DISK_CACHE_MB: 32,
  },
  authorizeMock: vi.fn(),
}));
vi.mock("../src/config", () => ({ config: cfg }));
vi.mock("../src/auth/session", () => ({
  verifySession: async () => ({ userId: "e2e-user" }),
}));
vi.mock("../src/auth/cdp-authz", () => ({ authorizeCdpAttach: authorizeMock }));

import { registerCdpBridgeRoutes } from "../src/auth/cdp-bridge";
import { spawnProfileChromium } from "../src/auth/profile-chromium";

const BASE = "/api/browser-session/cdp";
const ENABLED = process.env.TEST_CHROMIUM === "1";

if (!ENABLED) {
  console.warn(
    "[cdp-bridge.chromium] TEST_CHROMIUM not set — real-browser bridge test SKIPPED. " +
      "Run TEST_CHROMIUM=1 npx vitest run tests/cdp-bridge.chromium.test.ts to cover it."
  );
}

describe.skipIf(!ENABLED)("cdp bridge against a real chromium", () => {
  it("screencasts and accepts commands over SSE + REST", async () => {
    cfg.BROWSER_PROFILES_DIR = mkdtempSync(join(tmpdir(), "e2e-prof-"));
    const spawned = await spawnProfileChromium("e2e-user", {
      startUrl: "data:text/html,<h1>hello</h1>",
    });
    authorizeMock.mockResolvedValue(spawned.cdpPageWsUrl);

    const app = Fastify();
    registerCdpBridgeRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    cfg.PORTAL_URL = origin;
    cfg.SERVER_PUBLIC_URL = origin;
    const auth = { authorization: "Bearer jwt", origin };

    try {
      const attached = await fetch(`${origin}${BASE}/attach`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ sessionId: "e2e-user", cdpToken: "ctok" }),
      });
      expect(attached.status).toBe(201);
      const { channelId } = (await attached.json()) as { channelId: string };

      const stream = await fetch(`${origin}${BASE}/events?channel=${channelId}`, { headers: auth });
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const next = async (): Promise<{ event: string; data: string }> => {
        for (;;) {
          const i = buf.indexOf("\n\n");
          if (i !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const lines = frame.split("\n").filter((l) => l && !l.startsWith(":"));
            if (!lines.length) continue;
            return {
              event: lines.find((l) => l.startsWith("event:"))!.slice(6).trim(),
              data: lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n"),
            };
          }
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          buf += decoder.decode(value, { stream: true });
        }
      };

      expect((await next()).event).toBe("ready");

      const send = (msgs: unknown[]) =>
        fetch(`${origin}${BASE}/commands?channel=${channelId}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify(msgs),
        });

      expect((await send([
        { id: 1, method: "Page.enable" },
        { id: 2, method: "Runtime.enable" },
        { id: 3, method: "Page.startScreencast", params: { format: "jpeg", quality: 60, maxWidth: 640, maxHeight: 480, everyNthFrame: 1 } },
      ])).status).toBe(202);

      // A real jpeg frame from a real chromium, plus the ack round-trip.
      let frame: { data: string; sessionId: number } | undefined;
      for (let i = 0; i < 40 && !frame; i++) {
        const msg = JSON.parse((await next()).data) as {
          method?: string;
          params?: { data: string; sessionId: number };
        };
        if (msg.method === "Page.screencastFrame") frame = msg.params;
      }
      expect(frame?.data?.length).toBeGreaterThan(500);
      expect(Buffer.from(frame!.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
      expect((await send([{ id: 4, method: "Page.screencastFrameAck", params: { sessionId: frame!.sessionId } }])).status).toBe(202);

      // Input reaches the page: type into the document and read it back.
      await send([
        { id: 5, method: "Runtime.evaluate", params: { expression: "document.title = 'driven'", returnByValue: true } },
        { id: 6, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } },
      ]);
      let title: string | undefined;
      for (let i = 0; i < 60 && title === undefined; i++) {
        const msg = JSON.parse((await next()).data) as {
          id?: number;
          result?: { result?: { value?: string } };
        };
        if (msg.id === 6) title = msg.result?.result?.value;
      }
      expect(title).toBe("driven");

      expect((await fetch(`${origin}${BASE}/detach?channel=${channelId}`, { method: "POST", headers: auth })).status).toBe(204);
      expect((await next()).event).toBe("closed");
      await expect(next()).rejects.toThrow("stream ended");
    } finally {
      spawned.proc.kill("SIGKILL");
      await app.close();
    }
  }, 60_000);
});
