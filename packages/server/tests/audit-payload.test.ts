import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { captureValue, isSecretKey, sanitizeForAudit } from "../src/audit/payload";
import { AuditLogger } from "../src/audit/logger";
import { DbDestination } from "../src/audit/destinations";
import { resetAuditEmailCache } from "../src/audit/user-email";
import { resetClientNameCache } from "../src/audit/client-name";
import { runWithAuditContext } from "../src/audit/context";
import { getAuditPayload } from "../src/audit/query";
import { config } from "../src/config";
import { db } from "../src/db";

describe("isSecretKey", () => {
  it.each([
    "password", "Password", "apiKey", "api_key", "x-api-key", "client_secret", "accessToken", "refresh_token",
    "Authorization", "cookie", "privateKey", "private_key", "sessionId", "otp", "pin", "auth", "credentials",
  ])("redacts %s", (k) => expect(isSecretKey(k)).toBe(true));
  it.each(["footprint", "spinner", "author", "pinned", "description", "query", "page", "keyboard", "options"])(
    "keeps %s",
    (k) => expect(isSecretKey(k)).toBe(false)
  );
});

describe("sanitizeForAudit", () => {
  it("redacts credential-named keys at any depth, keeps the rest", () => {
    expect(
      sanitizeForAudit({ q: "hello", auth: { token: "tok-abc", user: "u" }, list: [{ password: "pw-fake" }] })
    ).toEqual({ q: "hello", auth: "[REDACTED]", list: [{ password: "[REDACTED]" }] });
  });
  it("keeps vault placeholders as sent", () => {
    expect(sanitizeForAudit({ body: "key={{vault:DEPLOY_KEY}}" })).toEqual({ body: "key={{vault:DEPLOY_KEY}}" });
  });
  it("replaces binary, data: URIs and long base64 with a size note", () => {
    const b64 = Buffer.alloc(3000, 7).toString("base64");
    const out = sanitizeForAudit({
      buf: Buffer.alloc(10),
      img: `data:image/png;base64,${b64}`,
      raw: b64,
      content: [{ type: "image", data: b64 }],
      short: "aGVsbG8=",
    }) as Record<string, unknown>;
    expect(out.buf).toBe("[binary 10 bytes]");
    expect(out.img).toMatch(/^\[binary \d+ bytes\]$/);
    expect(out.raw).toBe("[binary 3000 bytes]");
    expect(out.content).toEqual([{ type: "image", data: "[binary 3000 bytes]" }]);
    expect(out.short).toBe("aGVsbG8=");
  });
  it("does not mistake long text for base64", () => {
    const prose = "word ".repeat(300);
    const ident = "x".repeat(2000);
    expect(sanitizeForAudit({ prose, ident })).toEqual({ prose, ident });
  });
  it("wrapped base64 (line breaks) is still caught", () => {
    const wrapped = Buffer.alloc(3000, 7).toString("base64").replace(/(.{76})/g, "$1\n");
    expect(sanitizeForAudit(wrapped)).toBe("[binary 3000 bytes]");
  });
  it("survives circular values and bigints", () => {
    const a: Record<string, unknown> = { n: 10n };
    a.self = a;
    expect(sanitizeForAudit(a)).toEqual({ n: "10", self: "[circular]" });
  });
});

describe("captureValue limits", () => {
  it("keeps a value under the cap whole", () => {
    expect(captureValue({ a: 1 }, 1024)).toEqual({ text: '{"a":1}', truncated: false, bytes: 7 });
  });
  it("cuts an oversized value at the cap, flags it, and keeps the full size", () => {
    const c = captureValue({ text: "x".repeat(5000) }, 1000)!;
    expect(c.truncated).toBe(true);
    expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(1000);
    expect(c.text.startsWith('{"text":"xxx')).toBe(true);
    expect(c.bytes).toBe(5000 + '{"text":""}'.length);
  });
  it("never splits a multi-byte character", () => {
    const c = captureValue("é".repeat(1000), 301)!;
    expect(c.truncated).toBe(true);
    expect(c.text).not.toContain("�");
    expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(301);
  });
  it("records nothing for undefined", () => {
    expect(captureValue(undefined, 1000)).toBeUndefined();
  });
});

describe("AuditLogger with AUDIT_PAYLOAD", () => {
  const saved = {
    mode: config.AUDIT_PAYLOAD,
    a: config.AUDIT_PAYLOAD_ARGS_MAX_BYTES,
    r: config.AUDIT_PAYLOAD_RESULT_MAX_BYTES,
  };
  let seen: any[];
  const logger = () => {
    const l = new AuditLogger();
    (l as any).destination = { log: (e: unknown) => void seen.push(e) };
    return l;
  };
  beforeEach(async () => {
    seen = [];
    resetAuditEmailCache();
    resetClientNameCache();
    await db.exec("DELETE FROM oauth_clients");
    await db.exec("DELETE FROM audit_payload");
    await db.exec("DELETE FROM audit_log");
    await db.exec("DELETE FROM users");
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "dev@example.com"]);
  });
  afterEach(() => {
    config.AUDIT_PAYLOAD = saved.mode;
    config.AUDIT_PAYLOAD_ARGS_MAX_BYTES = saved.a;
    config.AUDIT_PAYLOAD_RESULT_MAX_BYTES = saved.r;
  });

  it("always adds the user's email", async () => {
    await logger().log({ user_id: "u1", action: "EXECUTE", success: true });
    await logger().log({ user_id: "ghost", action: "EXECUTE", success: true });
    expect(seen[0].user_email).toBe("dev@example.com");
    expect(seen[1].user_email).toBeNull();
  });

  it("adds the request's IP, user agent, auth method and OAuth client name", async () => {
    await db.run("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)", [
      "client-abc", "Claude Code", "[]",
    ]);
    await runWithAuditContext(
      { source_ip: "203.0.113.9", user_agent: "claude-code/2.0", auth_method: "oauth", client_id: "client-abc" },
      () => logger().log({ user_id: "u1", action: "EXECUTE", success: true })
    );
    expect(seen[0]).toMatchObject({
      source_ip: "203.0.113.9",
      user_agent: "claude-code/2.0",
      auth_method: "oauth",
      client_id: "client-abc",
      client_name: "Claude Code",
    });
  });

  it("an API key has no client; an unknown client id has no name", async () => {
    await runWithAuditContext({ source_ip: "198.51.100.1", auth_method: "api_key" }, () =>
      logger().log({ user_id: "u1", action: "EXECUTE", success: true })
    );
    await runWithAuditContext({ auth_method: "oauth", client_id: "gone" }, () =>
      logger().log({ user_id: "u1", action: "EXECUTE", success: true })
    );
    expect(seen[0]).toMatchObject({ source_ip: "198.51.100.1", auth_method: "api_key" });
    expect(seen[0]).not.toHaveProperty("client_id");
    expect(seen[1]).toMatchObject({ client_id: "gone" });
    expect(seen[1]).not.toHaveProperty("client_name");
  });

  it("outside a request (background work) none of the request fields are set", async () => {
    await logger().log({ user_id: "u1", action: "REFRESH", success: true });
    for (const k of ["source_ip", "user_agent", "auth_method", "client_id", "client_name"]) {
      expect(seen[0]).not.toHaveProperty(k);
    }
  });

  it("the database row stores the request fields", async () => {
    const l = new AuditLogger();
    (l as any).destination = new DbDestination();
    await runWithAuditContext({ source_ip: "203.0.113.9", user_agent: "ua/1", auth_method: "api_key" }, () =>
      l.log({ user_id: "u1", action: "EXECUTE", success: true })
    );
    expect(
      await db.get("SELECT source_ip, user_agent, auth_method, client_id, client_name FROM audit_log")
    ).toEqual({ source_ip: "203.0.113.9", user_agent: "ua/1", auth_method: "api_key", client_id: null, client_name: null });
  });

  it("off (default): no args or result, whatever the caller passed", async () => {
    config.AUDIT_PAYLOAD = "off";
    await logger().log({ user_id: "u1", action: "EXECUTE", success: true, args: { q: 1 }, result: { r: 2 } });
    expect(seen[0]).not.toHaveProperty("args");
    expect(seen[0]).not.toHaveProperty("result");
  });

  it("args: arguments only", async () => {
    config.AUDIT_PAYLOAD = "args";
    await logger().log({ user_id: "u1", action: "EXECUTE", success: true, args: { q: 1 }, result: { r: 2 } });
    expect(seen[0]).toMatchObject({ args: '{"q":1}', args_truncated: false, args_bytes: 7 });
    expect(seen[0]).not.toHaveProperty("result");
  });

  it("full: arguments and result, each under its own cap", async () => {
    config.AUDIT_PAYLOAD = "full";
    config.AUDIT_PAYLOAD_ARGS_MAX_BYTES = 256;
    config.AUDIT_PAYLOAD_RESULT_MAX_BYTES = 300;
    await logger().log({
      user_id: "u1",
      action: "EXECUTE",
      success: true,
      args: { q: "a".repeat(100) },
      result: { body: "b".repeat(1000) },
    });
    expect(seen[0].args_truncated).toBe(false);
    expect(seen[0].result_truncated).toBe(true);
    expect(Buffer.byteLength(seen[0].result)).toBeLessThanOrEqual(300);
    expect(seen[0].result_bytes).toBeGreaterThan(1000);
  });

  it("the database keeps the payload in audit_payload, linked to the audit row", async () => {
    config.AUDIT_PAYLOAD = "full";
    const l = new AuditLogger();
    (l as any).destination = new DbDestination();
    await l.log({ user_id: "u1", action: "EXECUTE", tool: "t", success: true, args: { q: 1 }, result: [1, 2] });
    const row = await db.get<{ id: number; user_email: string }>("SELECT id, user_email FROM audit_log");
    expect(row?.user_email).toBe("dev@example.com");
    expect(await getAuditPayload(Number(row!.id))).toEqual({
      audit_id: Number(row!.id),
      args: '{"q":1}',
      args_truncated: false,
      args_bytes: 7,
      result: "[1,2]",
      result_truncated: false,
      result_bytes: 5,
    });
  });

  it("an event without a payload writes no audit_payload row", async () => {
    const l = new AuditLogger();
    (l as any).destination = new DbDestination();
    await l.log({ user_id: "u1", action: "CONNECT", success: true });
    expect(await db.all("SELECT 1 FROM audit_payload")).toHaveLength(0);
    expect(await db.all("SELECT 1 FROM audit_log")).toHaveLength(1);
  });

  it("a failed payload write keeps the audit row and does not throw", async () => {
    config.AUDIT_PAYLOAD = "args";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dest = new DbDestination();
    const orig = db.run.bind(db);
    const spy = vi.spyOn(db, "run").mockImplementation(async (sql: string, p?: any) => {
      if (sql.includes("audit_payload")) throw new Error("disk full");
      return orig(sql, p);
    });
    await expect(
      dest.log({ user_id: "u1", action: "EXECUTE", success: true, args: "{}", timestamp: new Date().toISOString() })
    ).resolves.toBeUndefined();
    spy.mockRestore();
    expect(await db.all("SELECT 1 FROM audit_log")).toHaveLength(1);
  });
});
