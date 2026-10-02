import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    ADMIN_EMAILS: ["admin@example.com"],
    AUDIT_LOG_DEST: "sqlite",
    CLUSTER_ENABLED: false,
    INSTANCE_SETTINGS_POLL_SECONDS: 5,
  },
}));

vi.mock("../src/auth/session", () => ({
  verifySession: vi.fn((token: string) => {
    if (token === "admin-jwt") return { userId: "user-admin", email: "admin@example.com" };
    if (token === "dev-jwt") return { userId: "user-dev", email: "dev@example.com" };
    throw new Error("Invalid token");
  }),
}));

vi.mock("../src/auth/users", async (orig) => ({
  ...(await orig<typeof import("../src/auth/users")>()),
  verifyApiKey: vi.fn(async () => null),
  getUserById: vi.fn(async (id: string) => {
    if (id === "user-admin") return { id, email: "admin@example.com" };
    if (id === "user-dev") return { id, email: "dev@example.com" };
    return null;
  }),
}));

import { registerAdminRoutes } from "../src/api/admin-routes";
import { db } from "../src/db";
import { registry } from "../src/plugins/registry";
import { isIntegrationDisabled, resetSettingsForTest, getSettings } from "../src/settings/instance-settings";

const ADMIN = { authorization: "Bearer admin-jwt" };
const DEV = { authorization: "Bearer dev-jwt" };

registry.register({
  integration: {
    name: "acme-cfg",
    version: "1.0.0",
    displayName: "Acme Cfg",
    auth: { type: "oauth2", authorizationUrl: "", tokenUrl: "", scopes: [] },
  } as any,
  tools: [
    { name: "acme_cfg_search", description: "x", integration: "acme-cfg", inputSchema: z.object({}), handler: async () => ({}) } as any,
  ],
});

beforeAll(() => {
  // The same wiring the real boot does.
  registry.setDisabledPredicate(isIntegrationDisabled);
});

async function call(
  method: "GET" | "PUT",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = ADMIN
) {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app.inject({ method, url, headers, payload: payload as object | undefined });
}

beforeEach(async () => {
  for (const t of ["audit_log", "instance_settings", "users"]) await db.exec(`DELETE FROM ${t}`);
  resetSettingsForTest();
  await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["user-admin", "admin@example.com"]);
  await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["user-dev", "dev@example.com"]);
});

const WRITES = [
  ["GET", "/api/admin/config", undefined],
  ["PUT", "/api/admin/config/integrations/acme-cfg", { enabled: false }],
  ["PUT", "/api/admin/config/custom-apps", { mode: "none" }],
] as const;

describe.each(WRITES)("%s %s gate", (method, url, payload) => {
  it("401 without a session", async () => {
    expect((await call(method, url, payload, {})).statusCode).toBe(401);
  });
  it("403 for a signed-in non-admin", async () => {
    expect((await call(method, url, payload, DEV)).statusCode).toBe(403);
  });
});

describe("GET /api/admin/config", () => {
  it("lists every integration with its enabled flag, plus the custom-app policy", async () => {
    const body = JSON.parse((await call("GET", "/api/admin/config")).body);
    const acme = body.integrations.find((i: { name: string }) => i.name === "acme-cfg");
    expect(acme).toEqual({ name: "acme-cfg", display_name: "Acme Cfg", enabled: true });
    expect(body.custom_apps_policy).toEqual({ mode: "all", user_ids: [] });
  });
});

describe("PUT /api/admin/config/integrations/:name", () => {
  it("disables an integration: it leaves the registry, stays in the admin view, and is audited", async () => {
    const res = await call("PUT", "/api/admin/config/integrations/acme-cfg", { enabled: false });
    expect(res.statusCode).toBe(200);
    expect(registry.getIntegration("acme-cfg")).toBeUndefined();
    expect(registry.getTool("acme_cfg_search")).toBeUndefined();
    const view = JSON.parse((await call("GET", "/api/admin/config")).body);
    expect(view.integrations.find((i: { name: string }) => i.name === "acme-cfg").enabled).toBe(false);
    const row = await db.get<{ updated_by: string }>("SELECT updated_by FROM instance_settings WHERE key = ?", [
      "disabled_integrations",
    ]);
    expect(row?.updated_by).toBe("user-admin");
    const audit = await db.all<{ user_id: string; action: string; tool: string }>(
      "SELECT user_id, action, tool FROM audit_log"
    );
    expect(audit).toEqual([
      { user_id: "user-admin", action: "ADMIN_INTEGRATION_SET", tool: "admin.config.integration acme-cfg=disabled" },
    ]);
  });

  it("re-enables it", async () => {
    await call("PUT", "/api/admin/config/integrations/acme-cfg", { enabled: false });
    const res = await call("PUT", "/api/admin/config/integrations/acme-cfg", { enabled: true });
    expect(res.statusCode).toBe(200);
    expect(registry.getIntegration("acme-cfg")).toBeDefined();
    expect(getSettings().disabled_integrations).not.toContain("acme-cfg");
  });

  it("builds on the stored list, not a stale in-memory copy, so another worker's change is not lost", async () => {
    // Another worker disabled something and this process has not polled yet:
    // write straight to the table, leaving the snapshot at its defaults.
    await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [
      "disabled_integrations",
      JSON.stringify(["other-integration"]),
    ]);
    expect(getSettings().disabled_integrations).toEqual([]); // the snapshot really is stale
    const res = await call("PUT", "/api/admin/config/integrations/acme-cfg", { enabled: false });
    expect(res.statusCode).toBe(200);
    expect(getSettings().disabled_integrations).toEqual(["acme-cfg", "other-integration"]);
  });

  it("404 for an integration that is not registered, and saves nothing", async () => {
    const res = await call("PUT", "/api/admin/config/integrations/does-not-exist", { enabled: false });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "unknown_integration" });
    expect(await db.all("SELECT 1 FROM instance_settings")).toHaveLength(0);
  });

  it.each([[{}], [{ enabled: "no" }], [null]])("400 for a body without a boolean enabled: %j", async (body) => {
    const res = await call("PUT", "/api/admin/config/integrations/acme-cfg", body);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_body" });
  });
});

describe("PUT /api/admin/config/custom-apps", () => {
  it("sets the mode and audits it", async () => {
    const res = await call("PUT", "/api/admin/config/custom-apps", { mode: "none" });
    expect(res.statusCode).toBe(200);
    expect(getSettings().custom_apps_policy).toEqual({ mode: "none", user_ids: [] });
    const audit = await db.all<{ action: string; tool: string }>("SELECT action, tool FROM audit_log");
    expect(audit).toEqual([{ action: "ADMIN_CUSTOM_APPS_POLICY", tool: "admin.config.custom-apps=none" }]);
  });

  it("accepts an allowlist of users that exist", async () => {
    const res = await call("PUT", "/api/admin/config/custom-apps", { mode: "allowlist", user_ids: ["user-dev"] });
    expect(res.statusCode).toBe(200);
    expect(getSettings().custom_apps_policy).toEqual({ mode: "allowlist", user_ids: ["user-dev"] });
  });

  it("drops user_ids when the mode is not allowlist", async () => {
    await call("PUT", "/api/admin/config/custom-apps", { mode: "all", user_ids: ["user-dev"] });
    expect(getSettings().custom_apps_policy).toEqual({ mode: "all", user_ids: [] });
  });

  it("400 unknown_user when an id does not exist, and saves nothing", async () => {
    const res = await call("PUT", "/api/admin/config/custom-apps", { mode: "allowlist", user_ids: ["user-dev", "ghost"] });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "unknown_user" });
    expect(await db.all("SELECT 1 FROM instance_settings")).toHaveLength(0);
  });

  it.each([[{ mode: "everyone" }], [{}], [{ mode: "allowlist", user_ids: "user-dev" }], [{ mode: "allowlist", user_ids: [7] }], [null]])(
    "400 invalid_policy for %j",
    async (body) => {
      const res = await call("PUT", "/api/admin/config/custom-apps", body);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "invalid_policy" });
    }
  );
});
