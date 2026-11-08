import { describe, it, expect, beforeEach } from "vitest";
import { AuditLogger } from "../../src/audit/logger";
import { requestLogFields, runWithAuditContext } from "../../src/audit/context";
import { resetAuditEmailCache } from "../../src/audit/user-email";
import { resetClientNameCache } from "../../src/audit/client-name";
import { db } from "../../src/db";

describe("audit client_name override", () => {
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
    await db.exec("DELETE FROM users");
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "dev@example.com"]);
    await db.run("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)", ["c1", "Claude Code", "[]"]);
  });

  it("the logger uses an explicit client_name, even over an OAuth client's name", async () => {
    await runWithAuditContext({ auth_method: "session", client_name: "space:pr-timeline" }, () =>
      logger().log({ user_id: "u1", action: "EXECUTE", success: true })
    );
    await runWithAuditContext({ auth_method: "oauth", client_id: "c1", client_name: "space:x" }, () =>
      logger().log({ user_id: "u1", action: "EXECUTE", success: true })
    );
    await runWithAuditContext({ auth_method: "oauth", client_id: "c1" }, () =>
      logger().log({ user_id: "u1", action: "EXECUTE", success: true })
    );
    expect(seen[0]).toMatchObject({ auth_method: "session", client_name: "space:pr-timeline" });
    expect(seen[0]).not.toHaveProperty("client_id");
    expect(seen[1]).toMatchObject({ client_id: "c1", client_name: "space:x" });
    expect(seen[2]).toMatchObject({ client_id: "c1", client_name: "Claude Code" });
  });

  it("requestLogFields uses it too", async () => {
    const fields = await runWithAuditContext({ auth_method: "session", client_name: "space:pr-timeline" }, () =>
      requestLogFields("u1")
    );
    expect(fields).toMatchObject({ user_email: "dev@example.com", auth_method: "session", client_name: "space:pr-timeline" });
    const oauth = await runWithAuditContext({ client_id: "c1" }, () => requestLogFields("u1"));
    expect(oauth).toMatchObject({ client_id: "c1", client_name: "Claude Code" });
  });
});
