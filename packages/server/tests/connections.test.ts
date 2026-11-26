import { describe, it, expect, beforeEach } from "vitest";

import { db } from "../src/db";
import {
  createPending,
  getPending,
  markConnected,
  reapExpired,
  redeemPending,
  _clearAll,
} from "../src/auth/connections";

describe("pending-connection store", () => {
  beforeEach(async () => {
    await _clearAll();
  });

  it("creates a PENDING record and reads it back", async () => {
    const rec = await createPending({
      userId: "u1",
      integration: "jira",
      type: "cookie",
      ttlSeconds: 600,
    });
    expect(rec.status).toBe("PENDING");
    expect(rec.connectionId).toBeDefined();
  });

  it("marks a record CONNECTED by (userId, integration)", async () => {
    const rec = await createPending({ userId: "u1", integration: "jira", type: "oauth2", ttlSeconds: 600 });
    await markConnected("u1", "jira");
    expect((await getPending(rec.connectionId))?.status).toBe("CONNECTED");
  });

  it("expires a pending cookie connection without tearing down any browser session", async () => {
    const rec = await createPending({ userId: "u1", integration: "jira", type: "cookie", ttlSeconds: 0 });
    await reapExpired();
    expect((await getPending(rec.connectionId))?.status).toBe("EXPIRED");
  });

  it("reaps an expired record and marks it EXPIRED", async () => {
    const rec = await createPending({
      userId: "u1",
      integration: "jira",
      type: "cookie",
      ttlSeconds: -1, // already expired
    });
    await reapExpired();
    expect((await getPending(rec.connectionId))?.status).toBe("EXPIRED");
  });

  it("does not reap a still-valid record", async () => {
    const rec = await createPending({ userId: "u1", integration: "jira", type: "cookie", ttlSeconds: 600 });
    await reapExpired();
    expect((await getPending(rec.connectionId))?.status).toBe("PENDING");
  });

  it("prunes a terminal record whose expiry is past the grace window", async () => {
    const rec = await createPending({ userId: "u1", integration: "jira", type: "oauth2", ttlSeconds: 600 });
    await markConnected("u1", "jira"); // terminal: CONNECTED
    expect((await getPending(rec.connectionId))?.status).toBe("CONNECTED");
    // Age the row past link expiry + grace.
    await db.run("UPDATE pending_auth SET expires_at = ? WHERE state = ?", [Math.floor(Date.now() / 1000) - 1, rec.connectionId]);
    await reapExpired();
    expect(await getPending(rec.connectionId)).toBeUndefined();
  });

  it("does not mark an expired link CONNECTED", async () => {
    const rec = await createPending({ userId: "u1", integration: "jira", type: "oauth2", ttlSeconds: -1 });
    await markConnected("u1", "jira");
    expect((await getPending(rec.connectionId))?.status).toBe("EXPIRED");
  });

  it("is shared state, not process memory: a record written straight to the table is redeemable", async () => {
    // Simulates another worker/replica having minted the link.
    const t = Math.floor(Date.now() / 1000);
    await db.run(
      "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
      ["other-proc-id", "u1", "__connect__", t + 4200, JSON.stringify({ integration: "jira", type: "cookie", status: "PENDING", createdAt: t, expiresAt: t + 600 })]
    );
    expect((await redeemPending("other-proc-id"))?.userId).toBe("u1");
    expect(await redeemPending("other-proc-id")).toBeNull();
  });

  it("only one of two concurrent redeems wins", async () => {
    const rec = await createPending({ userId: "u1", integration: "jira", type: "cookie", ttlSeconds: 600 });
    const results = await Promise.all([redeemPending(rec.connectionId), redeemPending(rec.connectionId)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not prune a terminal record still within the grace window", async () => {
    const rec = await createPending({
      userId: "u1",
      integration: "jira",
      type: "cookie",
      ttlSeconds: -1, // expiresAt ~now, within 1h grace
    });
    await reapExpired(); // PENDING → EXPIRED, but not pruned (within grace)
    expect((await getPending(rec.connectionId))?.status).toBe("EXPIRED");
  });

  it("redeems a pending record once and stamps redeemedAt", async () => {
    const rec = await createPending({ userId: "u1", integration: "jira", type: "cookie", ttlSeconds: 600 });
    const first = await redeemPending(rec.connectionId);
    expect(first).not.toBeNull();
    expect(first!.connectionId).toBe(rec.connectionId);
    expect(first!.redeemedAt).toBeGreaterThan(0);
    // Still PENDING: wait_for_connection must keep waiting until the flow completes.
    expect(first!.status).toBe("PENDING");
  });

  it("refuses a second redemption of the same record", async () => {
    const rec = await createPending({ userId: "u1", integration: "jira", type: "cookie", ttlSeconds: 600 });
    expect(await redeemPending(rec.connectionId)).not.toBeNull();
    expect(await redeemPending(rec.connectionId)).toBeNull();
  });

  it("refuses an unknown connectionId", async () => {
    expect(await redeemPending("no-such-id")).toBeNull();
  });

  it("refuses an expired record", async () => {
    const rec = await createPending({ userId: "u1", integration: "jira", type: "cookie", ttlSeconds: -1 });
    expect(await redeemPending(rec.connectionId)).toBeNull();
  });
});
