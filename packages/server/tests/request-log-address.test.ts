import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { loggerOptions } from "../src/telemetry/logger";
import { trustProxyOption } from "../src/trust-proxy";
import { config } from "../src/config";

const saved = { t: config.TRUST_PROXY, h: config.CLIENT_IP_HEADER };
afterEach(() => {
  config.TRUST_PROXY = saved.t;
  config.CLIENT_IP_HEADER = saved.h;
});

async function loggedReq(headers: Record<string, string>) {
  const lines: string[] = [];
  const stream = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
  const app = Fastify({ logger: { ...loggerOptions, level: "info", stream }, ...trustProxyOption(config.TRUST_PROXY) });
  app.get("/x", async () => "ok");
  await app.inject({ method: "GET", url: "/x", headers });
  await app.close();
  const line = lines.map((l) => JSON.parse(l)).find((l) => l.req);
  return line.req as { remoteAddress: string; peerAddress: string };
}

describe("request log addresses", () => {
  it("without TRUST_PROXY: the socket address, headers ignored", async () => {
    config.TRUST_PROXY = undefined;
    config.CLIENT_IP_HEADER = "cf-connecting-ip";
    const req = await loggedReq({ "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "203.0.113.9" });
    expect(req).toMatchObject({ remoteAddress: "127.0.0.1", peerAddress: "127.0.0.1" });
  });

  it("behind a trusted proxy: the X-Forwarded-For client, with the proxy as peer", async () => {
    config.TRUST_PROXY = ["127.0.0.1"];
    config.CLIENT_IP_HEADER = undefined;
    const req = await loggedReq({ "x-forwarded-for": "198.51.100.1" });
    expect(req).toMatchObject({ remoteAddress: "198.51.100.1", peerAddress: "127.0.0.1" });
  });

  it("behind Cloudflare: CF-Connecting-IP, same as the audit log", async () => {
    config.TRUST_PROXY = ["127.0.0.1"];
    config.CLIENT_IP_HEADER = "cf-connecting-ip";
    const req = await loggedReq({ "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "203.0.113.9" });
    expect(req).toMatchObject({ remoteAddress: "203.0.113.9", peerAddress: "127.0.0.1" });
  });
});
