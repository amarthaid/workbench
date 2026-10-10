import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { Writable } from "node:stream";

vi.mock("../src/config", () => ({ config: { SERVER_PUBLIC_URL: "http://localhost:3000" } }));

import { loggerOptions } from "../src/telemetry/logger";
import { registerAudioRoutes } from "../src/audio/routes";

describe("request log redaction", () => {
  it("never logs an audio capability, hit or miss", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
    const app = Fastify({ logger: { ...loggerOptions, level: "info", stream } });
    await registerAudioRoutes(app, { lookup: () => undefined, forward: async () => false });
    const cap = "capSECRETxxxxxxxxxxxxx";
    const r = await app.inject({ method: "POST", url: `/api/browser/audio/${cap}/clear` });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain(cap);
    await app.inject({ method: "GET", url: `/api/browser/audio/${cap}/stream?x=1` });
    await app.close();
    const log = lines.join("");
    expect(log).toContain("/api/browser/audio/[REDACTED]/clear");
    expect(log).not.toContain(cap);
  });
});
