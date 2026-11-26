import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

// executeSingle with an actor (a delegated Space call): the call runs as
// `userId` (the owner), the audit context names the actor, and nothing on the
// owner's behalf runs beyond the tool's own call (no cookie auto-reconnect, no
// vault lookup, no custom-app fallback).

const h = vi.hoisted(() => ({
  ensure: vi.fn(async (..._a: unknown[]) => false),
  createCtx: vi.fn((..._a: unknown[]) => ({ userId: "owner", getToken: async () => "t", http: async () => new Response(), getConfig: () => ({}) })),
  logged: [] as Array<{ event: any; actor: string | undefined }>,
  resolveVaultRefs: vi.fn(),
  getToolForUser: vi.fn(async (..._a: unknown[]) => undefined as any),
}));

vi.mock("../src/auth/reconnect/runner", () => ({ ensureCookieSession: (...a: unknown[]) => h.ensure(...a) }));
vi.mock("../src/plugins/context", () => ({ createContext: (...a: unknown[]) => h.createCtx(...a) }));
vi.mock("../src/audit/logger", async () => {
  const { currentAuditContext } = await import("../src/audit/context");
  return {
    auditLogger: {
      log: vi.fn(async (event: unknown) => {
        h.logged.push({ event, actor: currentAuditContext()?.actor_user_id });
      }),
    },
  };
});
vi.mock("../src/auth/tokens", () => ({ getToken: vi.fn(async () => ({ accessToken: "t", scopes: "" })) }));
vi.mock("../src/telemetry/tracing", () => ({ withSpan: vi.fn((_n: string, fn: Function) => fn()) }));
vi.mock("../src/vault/interpolate", async (orig) => ({
  ...(await orig<typeof import("../src/vault/interpolate")>()),
  resolveVaultRefs: (...a: unknown[]) => h.resolveVaultRefs(...a),
}));
vi.mock("../src/custom-apps/index", async (orig) => ({
  ...(await orig<typeof import("../src/custom-apps/index")>()),
  getToolForUser: (...a: unknown[]) => h.getToolForUser(...a),
}));

import { executeSingle } from "../src/mcp/meta-tools";
import { registry } from "../src/plugins/registry";
import { currentAuditContext, runWithAuditContext } from "../src/audit/context";

const handler = vi.fn(async () => ({ ok: true }));
const cookieTool = { name: "acmec_read", description: "", integration: "acme-cookie", effect: "read", inputSchema: z.object({}), handler };
const oauthTool = { name: "acmeo_read", description: "", integration: "acme-oauth", effect: "read", inputSchema: z.object({}), handler };
const integrations: Record<string, any> = {
  "acme-cookie": {
    name: "acme-cookie",
    version: "1",
    auth: { type: "cookie", loginUrl: "https://app.example.com/login", targetDomain: "app.example.com", reconnect: { steps: [] } },
  },
  "acme-oauth": { name: "acme-oauth", version: "1", auth: { type: "oauth2", authorizationUrl: "", tokenUrl: "", scopes: [] } },
};

beforeEach(() => {
  h.ensure.mockReset();
  h.ensure.mockResolvedValue(false);
  h.createCtx.mockClear();
  h.logged.length = 0;
  h.resolveVaultRefs.mockReset();
  h.getToolForUser.mockReset();
  h.getToolForUser.mockResolvedValue(undefined);
  handler.mockClear();
  vi.spyOn(registry, "getTool").mockImplementation((n: string) =>
    n === cookieTool.name ? (cookieTool as any) : n === oauthTool.name ? (oauthTool as any) : undefined
  );
  vi.spyOn(registry, "getIntegration").mockImplementation((n: string) => integrations[n]);
});

describe("executeSingle actor option", () => {
  it("with an actor, a dead cookie session is NOT_CONNECTED and auto-reconnect is turned off", async () => {
    const ctx = {};
    const out = await runWithAuditContext(ctx, () =>
      executeSingle("owner", "acmec_read", {}, new Map(), { actorUserId: "viewer" })
    );
    expect(out).toMatchObject({ error: "NOT_CONNECTED", integration: "acme-cookie" });
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.ensure).toHaveBeenCalledWith("owner", "acme-cookie", { autoReconnect: false });
    expect(handler).not.toHaveBeenCalled();
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toMatchObject({ event: { user_id: "owner", error: "NOT_CONNECTED" }, actor: "viewer" });
  });

  it("without an actor, the cookie check may reconnect (called exactly as before) and no actor is set", async () => {
    const ctx: Record<string, unknown> = {};
    const out = await runWithAuditContext(ctx, () => executeSingle("owner", "acmec_read", {}, new Map()));
    expect(out).toMatchObject({ error: "NOT_CONNECTED" });
    expect(h.ensure.mock.calls).toEqual([["owner", "acme-cookie"]]);
    expect(ctx.actor_user_id).toBeUndefined();
    expect(h.logged[0].actor).toBeUndefined();
  });

  it("with an actor, the tool's context is created without auto-reconnect, and the audit row carries the actor", async () => {
    h.ensure.mockResolvedValue(true);
    const ctx: Record<string, unknown> = { client_name: "space:s1" };
    const out = await runWithAuditContext(ctx, () =>
      executeSingle("owner", "acmec_read", {}, new Map(), { actorUserId: "viewer" })
    );
    expect(out).toEqual({ result: { ok: true } });
    expect(h.createCtx.mock.calls).toEqual([["owner", "acme-cookie", { autoReconnect: false }]]);
    expect(ctx.actor_user_id).toBe("viewer");
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toMatchObject({ event: { user_id: "owner", success: true }, actor: "viewer" });
  });

  it("without an actor, the tool's context is created exactly as before", async () => {
    await runWithAuditContext({}, () => executeSingle("owner", "acmeo_read", {}, new Map()));
    expect(h.createCtx.mock.calls).toEqual([["owner", "acme-oauth"]]);
    expect(h.logged[0].actor).toBeUndefined();
  });

  it("with an actor and no request context, the audit row still carries the actor", async () => {
    expect(currentAuditContext()).toBeUndefined();
    const out = await executeSingle("owner", "acmeo_read", {}, new Map(), { actorUserId: "viewer" });
    expect(out).toEqual({ result: { ok: true } });
    expect(h.logged[0]).toMatchObject({ event: { user_id: "owner" }, actor: "viewer" });
  });

  it("with an actor, vault references are never resolved against the owner's vault", async () => {
    await runWithAuditContext({}, () =>
      executeSingle("owner", "acmeo_read", { q: "{{vault:pw}}" }, undefined, { actorUserId: "viewer" })
    );
    expect(h.resolveVaultRefs).not.toHaveBeenCalled();
    // Without an actor the lookup is made, as before.
    h.resolveVaultRefs.mockResolvedValue({ args: {}, substituted: new Map() });
    await runWithAuditContext({}, () => executeSingle("owner", "acmeo_read", { q: "{{vault:pw}}" }));
    expect(h.resolveVaultRefs).toHaveBeenCalledWith("owner", { q: "{{vault:pw}}" });
  });

  it("with an actor, an unknown name never falls through to the owner's custom apps", async () => {
    h.getToolForUser.mockResolvedValue({ name: "app__x", integration: "custom:1", appId: "1" });
    const out = await runWithAuditContext({}, () =>
      executeSingle("owner", "app__x", {}, new Map(), { actorUserId: "viewer" })
    );
    expect(out).toEqual({ error: "Tool not found" });
    expect(h.getToolForUser).not.toHaveBeenCalled();
    expect(h.logged[0]).toMatchObject({ event: { user_id: "owner", error: "Tool not found" }, actor: "viewer" });
  });
});
