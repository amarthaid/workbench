import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { normalizeBaseUrl, isBlockedHost } from "../src/custom-apps/ssrf";
import { namespacedName } from "../src/custom-apps/index";
import {
  createCustomApp,
  getCustomApp,
  getCustomAppById,
  listCustomApps,
  deleteCustomApp,
  integrationKey,
  idFromIntegrationKey,
} from "../src/custom-apps/store";

describe("app naming", () => {
  it("namespaces a remote tool under the app name", () => {
    expect(namespacedName("github", "search")).toBe("github__search");
  });

  it("round-trips the integration key", () => {
    const key = integrationKey("abc-123");
    expect(key).toBe("custom:abc-123");
    expect(idFromIntegrationKey(key)).toBe("abc-123");
    expect(idFromIntegrationKey("jira")).toBeNull();
  });
});

describe("app URL guard", () => {
  it("accepts http(s) and strips trailing slash + query", () => {
    expect(normalizeBaseUrl("https://mcp.example.com/api/?x=1")).toBe("https://mcp.example.com/api");
  });

  it("rejects non-http schemes and creds", () => {
    expect(normalizeBaseUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBaseUrl("https://user:pass@example.com/mcp")).toBeNull();
  });

  it("blocks private hosts; loopback only when NODE_ENV=development", () => {
    expect(isBlockedHost("10.0.0.5")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("169.254.169.254")).toBe(true);
    expect(isBlockedHost("example.com")).toBe(false);

    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    process.env.NODE_ENV = "development";
    expect(isBlockedHost("localhost")).toBe(false);
    expect(isBlockedHost("127.0.0.1")).toBe(false);
    process.env.NODE_ENV = orig;
  });

  it("blocks IPv4-mapped IPv6 private hosts", () => {
    // [::ffff:a9fe:a9fe] is 169.254.169.254 in IPv4-mapped IPv6 notation.
    expect(isBlockedHost("[::ffff:a9fe:a9fe]")).toBe(true);
    expect(isBlockedHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(isBlockedHost("[::ffff:7f00:1]")).toBe(true); // 127.0.0.1 mapped
  });
});

describe("app store", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM custom_apps");
  });

  it("creates, lists, and deletes a app", async () => {
    const c = await createCustomApp({
      userId: "u1",
      name: "github-mcp",
      baseUrl: "https://mcp.example.com/mcp",
      metadata: { tokenEndpoint: "https://mcp.example.com/token", scopes: ["a"] },
      clientId: "cid",
      clientSecret: "csecret",
    });
    expect(c.id).toBeDefined();

    const listed = await listCustomApps("u1");
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("github-mcp");
    // secret round-trips through encryption
    expect(listed[0].clientSecret).toBe("csecret");

    const byId = await getCustomAppById(c.id);
    expect(byId?.userId).toBe("u1");

    // other users cannot see it
    expect(await getCustomApp("u2", c.id)).toBeNull();

    await deleteCustomApp("u1", c.id);
    expect(await listCustomApps("u1")).toHaveLength(0);
  });
});
