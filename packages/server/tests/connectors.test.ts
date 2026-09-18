import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { normalizeBaseUrl, isBlockedHost } from "../src/connectors/ssrf";
import { namespacedName } from "../src/connectors/index";
import {
  createConnector,
  getConnector,
  getConnectorById,
  listConnectors,
  deleteConnector,
  integrationKey,
  idFromIntegrationKey,
} from "../src/connectors/store";

describe("connector naming", () => {
  it("namespaces a remote tool under the connector name", () => {
    expect(namespacedName("github", "search")).toBe("github__search");
  });

  it("round-trips the integration key", () => {
    const key = integrationKey("abc-123");
    expect(key).toBe("connector:abc-123");
    expect(idFromIntegrationKey(key)).toBe("abc-123");
    expect(idFromIntegrationKey("jira")).toBeNull();
  });
});

describe("connector URL guard", () => {
  it("accepts http(s) and strips trailing slash + query", () => {
    expect(normalizeBaseUrl("https://mcp.example.com/api/?x=1")).toBe("https://mcp.example.com/api");
    expect(normalizeBaseUrl("http://localhost:8080/mcp")).toBe("http://localhost:8080/mcp");
  });

  it("rejects non-http schemes and creds", () => {
    expect(normalizeBaseUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBaseUrl("https://user:pass@example.com/mcp")).toBeNull();
  });

  it("blocks private hosts but allows loopback (dev)", () => {
    expect(isBlockedHost("10.0.0.5")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("169.254.169.254")).toBe(true);
    expect(isBlockedHost("localhost")).toBe(false);
    expect(isBlockedHost("127.0.0.1")).toBe(false);
    expect(isBlockedHost("example.com")).toBe(false);
  });
});

describe("connector store", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM connectors");
  });

  it("creates, lists, and deletes a connector", async () => {
    const c = await createConnector({
      userId: "u1",
      name: "github-mcp",
      baseUrl: "https://mcp.example.com/mcp",
      metadata: { tokenEndpoint: "https://mcp.example.com/token", scopes: ["a"] },
      clientId: "cid",
      clientSecret: "csecret",
    });
    expect(c.id).toBeDefined();

    const listed = await listConnectors("u1");
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("github-mcp");
    // secret round-trips through encryption
    expect(listed[0].clientSecret).toBe("csecret");

    const byId = await getConnectorById(c.id);
    expect(byId?.userId).toBe("u1");

    // other users cannot see it
    expect(await getConnector("u2", c.id)).toBeNull();

    await deleteConnector("u1", c.id);
    expect(await listConnectors("u1")).toHaveLength(0);
  });
});
