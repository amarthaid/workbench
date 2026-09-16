import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { putSecret } from "../src/vault/store";
import { consumeOtl } from "../src/vault/otl";
import { vaultPlugin, VAULT_INTEGRATION_NAME } from "../src/plugins/internal/vault";

const tool = (name: string) => {
  const t = vaultPlugin.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const run = (name: string, userId: string, args: Record<string, unknown> = {}) => {
  const t = tool(name);
  return t.handler({ userId } as never, t.inputSchema.parse(args) as never) as Promise<any>;
};

beforeEach(async () => {
  await db.run("DELETE FROM user_vaults");
  await db.run("DELETE FROM pending_auth");
  await putSecret("u1", "pw", "hunter2", "login");
});

describe("vault plugin", () => {
  it("registers the two tools under the vault integration with no auth", () => {
    expect(vaultPlugin.integration.name).toBe(VAULT_INTEGRATION_NAME);
    expect(vaultPlugin.integration.auth).toEqual({ type: "none" });
    expect(vaultPlugin.tools.map((t) => t.name).sort()).toEqual(["vault_list", "vault_presign"]);
  });

  it("every tool name is vault_-prefixed so executeSingle exempts it", () => {
    for (const t of vaultPlugin.tools) expect(t.name.startsWith("vault_")).toBe(true);
  });

  it("vault_list returns metadata and never the value", async () => {
    const r = await run("vault_list", "u1");
    expect(r.secrets).toEqual([
      expect.objectContaining({ name: "pw", description: "login", last_used_at: null }),
    ]);
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(r.secrets[0].reference).toBe("{{vault:pw}}");
  });

  it("vault_presign mints a single-use url", async () => {
    const r = await run("vault_presign", "u1", { name: "pw" });
    expect(r.url).toMatch(/\/api\/vault\/otl\/[0-9a-f]{32}$/);
    expect(typeof r.expires_at).toBe("string");
    const token = r.url.split("/").pop();
    expect(await consumeOtl(token)).toEqual({ userId: "u1", name: "pw" });
  });

  it("vault_presign reports NOT_FOUND and INVALID_NAME", async () => {
    expect(await run("vault_presign", "u1", { name: "nope" })).toEqual({ error: "NOT_FOUND" });
    expect(await run("vault_presign", "u1", { name: "Bad" })).toEqual({ error: "INVALID_NAME" });
  });

  it("vault_presign schema caps ttl", () => {
    expect(() => tool("vault_presign").inputSchema.parse({ name: "pw", ttl_seconds: 601 })).toThrow();
    expect(() => tool("vault_presign").inputSchema.parse({ name: "pw", ttl_seconds: 0 })).toThrow();
  });

  it("tool descriptions tell the agent never to echo the value", () => {
    const d = tool("vault_presign").description.toLowerCase();
    expect(d).toContain("once");
    expect(d).toContain("curl");
    expect(tool("vault_list").description).toContain("{{vault:");
  });
});
