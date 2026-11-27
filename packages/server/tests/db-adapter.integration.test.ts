/**
 * Integration tests for the database layer, run against BOTH backends.
 *
 * The point of these is that they are the same assertions either way: the whole
 * value of `DbAdapter` is that a call site written once behaves identically on
 * SQLite and on PostgreSQL, and the only way to know that is to run it on both.
 * Every difference the adapters paper over — placeholder style, boolean
 * binding, BLOB vs BYTEA, transaction handling, affected-row counts — has a
 * test here.
 *
 * SQLite always runs, against a throwaway file. PostgreSQL runs only when
 * `TEST_POSTGRES_URL` is set, and is skipped loudly otherwise; CI sets it from
 * a service container so the PostgreSQL path is genuinely exercised on every
 * pull request. Skipping silently would leave the backend this PR exists for
 * completely untested.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema, createDb } from "../src/db";
import type { DbAdapter } from "../src/db-adapter";
import { can, clearPermission, listPermissions, setPermission } from "../src/permissions/store";
import {
  _setNowForTest,
  countDelegatedSpaces,
  deleteSpace,
  delegationSuspended,
  distinctOpeners,
  favoriteCounts,
  getSpace,
  recordOpen,
  setFavorite,
  setShares,
  toolsHash,
  updateSpaceMeta,
  upsertSpace,
  userSpaceStates,
} from "../src/spaces/store";
import { delegationFor, recordDelegationChange } from "../src/spaces/delegation";
import { getShares } from "../src/spaces/store";
import { decide } from "../src/approvals/engine";
import { ACCOUNT_ACTIVATE, SPACE_ACCESS, _registerKindForTest, type Actor, type Kind } from "../src/approvals/kinds";
import { cancelRequest, decideRequest, getRequest, insertRequest, pagePending } from "../src/approvals/store";
import { createUserForSignup } from "../src/approvals/signup";
import { config } from "../src/config";
import { getUserStatus, setUserStatus } from "../src/auth/user-status";

// Modules that use the process-wide `db` (the permissions store) run against
// the backend under test by pointing this holder at it. Unset, the real `db`
// answers, so nothing else in the process changes.
const target = vi.hoisted(() => ({ current: null as DbAdapter | null }));
vi.mock("../src/db", async (orig) => {
  const real = await orig<typeof import("../src/db")>();
  const db = new Proxy(real.db, {
    get(fallback, key) {
      const t = target.current ?? fallback;
      const v = Reflect.get(t, key) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { ...real, db };
});

const PG_URL = process.env.TEST_POSTGRES_URL;

if (!PG_URL) {
  console.warn(
    "[db-adapter.integration] TEST_POSTGRES_URL not set — PostgreSQL tests SKIPPED. " +
      "Run `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16` and set " +
      "TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:5432/postgres to cover the PostgreSQL path."
  );
}

const backends = [
  {
    name: "sqlite",
    enabled: true,
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-db-"));
      const adapter = createDb(path.join(dir, "test.db"));
      return { adapter, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
  },
  {
    name: "postgres",
    enabled: !!PG_URL,
    make: () => ({ adapter: createDb(PG_URL ?? "postgres://unused"), cleanup: () => undefined }),
  },
];

for (const backend of backends) {
  describe.skipIf(!backend.enabled)(`DbAdapter — ${backend.name}`, () => {
    let db: DbAdapter;
    let cleanup: () => void;

    beforeAll(async () => {
      const made = backend.make();
      db = made.adapter;
      cleanup = made.cleanup;
      await applySchema(db);
    });

    afterAll(async () => {
      await db.close();
      cleanup();
    });

    beforeEach(async () => {
      // Order matters only for readability — there are no FK constraints.
      for (const t of ["audit_log", "connections", "users", "oauth_refresh_tokens", "oauth_clients", "pending_auth"]) {
        await db.run(`DELETE FROM ${t}`);
      }
    });

    it("reports the dialect it was built for", () => {
      expect(db.dialect).toBe(backend.name);
    });

    it("applies the schema idempotently", async () => {
      // Second run must not throw on already-existing tables, columns or indexes.
      await applySchema(db);
      await applySchema(db);
      const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
      expect(Number(row?.n)).toBe(0);
    });

    it("round-trips text through ? placeholders", async () => {
      await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "u1@example.com"]);
      const row = await db.get<{ id: string; email: string }>("SELECT id, email FROM users WHERE id = ?", ["u1"]);
      expect(row?.email).toBe("u1@example.com");
    });

    it("keeps a literal ? in a string comparison out of the placeholder count", async () => {
      // Regression guard for the naive `sql.replace(/\?/g, …)` rewrite: with it,
      // the literal below consumed $1 and the real placeholder got $2, which
      // PostgreSQL rejects as "bind message supplies 1 parameters".
      await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u-q", "who?@example.com"]);
      const row = await db.get<{ id: string }>("SELECT id FROM users WHERE email LIKE '%?%' AND id = ?", ["u-q"]);
      expect(row?.id).toBe("u-q");
    });

    it("round-trips binary through BLOB/BYTEA", async () => {
      const secret = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
      await db.run("INSERT INTO connections (user_id, integration, access_token) VALUES (?, ?, ?)", [
        "u1",
        "jira",
        secret,
      ]);
      const row = await db.get<{ access_token: Buffer }>(
        "SELECT access_token FROM connections WHERE user_id = ? AND integration = ?",
        ["u1", "jira"]
      );
      expect(Buffer.isBuffer(row?.access_token)).toBe(true);
      expect(Buffer.compare(Buffer.from(row!.access_token), secret)).toBe(0);
    });

    // The bug this suite was written for: `success` is BOOLEAN, and PostgreSQL
    // refuses an integer for it ("column is of type boolean but expression is
    // of type integer"). Call sites pass real booleans; SQLite's adapter maps
    // them to 1/0 on the way in.
    it("accepts real booleans for BOOLEAN columns", async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.run(
        "INSERT INTO audit_log (user_id, action, success, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
        ["u1", "EXECUTE", true, now, "u1", "EXECUTE", false, now]
      );
      const rows = await db.all<{ success: boolean | number }>("SELECT success FROM audit_log ORDER BY id");
      expect(rows.map((r) => Boolean(r.success))).toEqual([true, false]);
    });

    it("stores NULL for an explicit null bind", async () => {
      await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u-null", null]);
      const row = await db.get<{ email: string | null }>("SELECT email FROM users WHERE id = ?", ["u-null"]);
      expect(row?.email).toBeNull();
    });

    it("fills created_at from the schema default", async () => {
      await db.run("INSERT INTO users (id) VALUES (?)", ["u-default"]);
      const row = await db.get<{ created_at: number }>("SELECT created_at FROM users WHERE id = ?", ["u-default"]);
      expect(Number(row?.created_at)).toBeGreaterThan(1_700_000_000);
    });

    it("reports affected rows from run()", async () => {
      await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["a", "a@example.com"]);
      await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["b", "b@example.com"]);
      expect((await db.run("UPDATE users SET email = ? WHERE id = ?", ["a2@example.com", "a"])).changes).toBe(1);
      expect((await db.run("UPDATE users SET email = ? WHERE id = ?", ["x", "missing"])).changes).toBe(0);
      expect((await db.run("DELETE FROM users")).changes).toBe(2);
    });

    it("returns undefined from get() and [] from all() when nothing matches", async () => {
      expect(await db.get("SELECT id FROM users WHERE id = ?", ["nope"])).toBeUndefined();
      expect(await db.all("SELECT id FROM users WHERE id = ?", ["nope"])).toEqual([]);
    });

    it("rejects when a UNIQUE constraint is violated", async () => {
      await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "dup@example.com"]);
      await expect(db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u2", "dup@example.com"])).rejects.toThrow();
    });

    describe("transactions", () => {
      it("commits every statement on success", async () => {
        await db.transaction(async (tx) => {
          await tx.run("INSERT INTO users (id, email) VALUES (?, ?)", ["t1", "t1@example.com"]);
          await tx.run("INSERT INTO users (id, email) VALUES (?, ?)", ["t2", "t2@example.com"]);
        });
        const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
        expect(Number(row?.n)).toBe(2);
      });

      it("rolls the whole thing back when the callback throws", async () => {
        await expect(
          db.transaction(async (tx) => {
            await tx.run("INSERT INTO users (id, email) VALUES (?, ?)", ["r1", "r1@example.com"]);
            throw new Error("boom");
          })
        ).rejects.toThrow("boom");
        const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
        expect(Number(row?.n)).toBe(0);
      });

      it("returns the callback's value", async () => {
        const out = await db.transaction(async (tx) => {
          await tx.run("INSERT INTO users (id) VALUES (?)", ["v1"]);
          return "returned";
        });
        expect(out).toBe("returned");
      });

      it("stays usable after a rolled-back transaction", async () => {
        await expect(
          db.transaction(async () => {
            throw new Error("boom");
          })
        ).rejects.toThrow("boom");
        await db.run("INSERT INTO users (id) VALUES (?)", ["after"]);
        expect(await db.get("SELECT id FROM users WHERE id = ?", ["after"])).toBeTruthy();
      });

      // The shape refresh-token rotation relies on: both callers see the row in
      // their SELECT, but only one DELETE can report a row. Without the
      // transaction (and on PostgreSQL, without pinning to one pooled
      // connection) both would proceed and mint two valid successors.
      it("lets exactly one of two concurrent claims delete the row", async () => {
        await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["contested", "c@example.com"]);

        const claim = () =>
          db.transaction(async (tx) => {
            const row = await tx.get<{ id: string }>("SELECT id FROM users WHERE id = ?", ["contested"]);
            if (!row) return false;
            const { changes } = await tx.run("DELETE FROM users WHERE id = ?", ["contested"]);
            return changes === 1;
          });

        const [a, b] = await Promise.all([claim(), claim()]);
        expect([a, b].filter(Boolean)).toHaveLength(1);
      });

      // The same arbitration without a transaction — the shape the jot upload
      // token relies on (jots/pending.ts). The transaction above is what keeps
      // a whole claim-and-mint sequence atomic; for deciding *who* consumed a
      // single-use row, the `changes === 1` check is sufficient on its own:
      // both callers see the row, the database serialises the deletes, and only
      // one of them reports removing it.
      //
      // Worth pinning on both backends rather than just SQLite: this is what
      // makes a single-use token single-use across workers, and CLUSTER_ENABLED
      // only ever runs on PostgreSQL.
      it("lets exactly one of three concurrent claims delete the row without a transaction", async () => {
        await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["contested", "c@example.com"]);

        const claim = async () => {
          const row = await db.get<{ id: string }>("SELECT id FROM users WHERE id = ?", ["contested"]);
          if (!row) return false;
          const { changes } = await db.run("DELETE FROM users WHERE id = ?", ["contested"]);
          return changes === 1;
        };

        const results = await Promise.all([claim(), claim(), claim()]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });

    // ON CONFLICT ... DO UPDATE with excluded.*, the LEFT JOIN, and BIGINT
    // granted_at (a string from node-postgres) all differ by backend.
    describe("permissions store", () => {
      beforeAll(() => {
        target.current = db;
      });
      afterAll(() => {
        target.current = null;
      });
      beforeEach(async () => {
        await db.run("DELETE FROM user_permissions");
      });

      it("upserts one rule, reads it through can(), and lists grantedAt as a number", async () => {
        await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["user-admin", "admin@example.com"]);
        const cap = "spaces.delegate_access";
        expect(await can("u1", cap)).toBe(false);

        await setPermission({ userId: "u1", capability: cap, effect: "allow", grantedBy: "user-admin" });
        expect(await can("u1", cap)).toBe(true);
        await setPermission({ userId: "u1", capability: cap, effect: "deny", grantedBy: "user-admin" });
        expect(await can("u1", cap)).toBe(false);
        await setPermission({ userId: "u1", capability: cap, effect: "allow", grantedBy: "user-admin" });

        const rows = await db.all("SELECT * FROM user_permissions WHERE user_id = ?", ["u1"]);
        expect(rows).toHaveLength(1);

        const [view] = await listPermissions("u1");
        expect(view).toMatchObject({ effect: "allow", source: "rule", grantedBy: "user-admin", grantedByEmail: "admin@example.com" });
        expect(typeof view.grantedAt).toBe("number");
        expect(view.grantedAt).toBeGreaterThan(0);

        expect(await clearPermission("u1", cap)).toBe(true);
        expect(await clearPermission("u1", cap)).toBe(false);
      });
    });

    describe("audit actor columns", () => {
      beforeAll(() => {
        target.current = db;
      });
      afterAll(() => {
        target.current = null;
      });
      beforeEach(async () => {
        await db.run("DELETE FROM audit_log");
      });

      it("the db destination writes actor_user_id and actor_email", async () => {
        const { DbDestination } = await import("../src/audit/destinations");
        await new DbDestination().log({
          user_id: "u1",
          action: "EXECUTE",
          success: true,
          timestamp: "2026-01-01T00:00:00Z",
          actor_user_id: "u2",
          actor_email: "qa@example.com",
        });
        const row = await db.get<{ user_id: string; actor_user_id: string; actor_email: string }>(
          "SELECT user_id, actor_user_id, actor_email FROM audit_log WHERE actor_user_id = ?",
          ["u2"]
        );
        expect(row).toEqual({ user_id: "u1", actor_user_id: "u2", actor_email: "qa@example.com" });
      });

      it("indexes the actor partially, only rows that have one", async () => {
        const def =
          db.dialect === "sqlite"
            ? (await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", ["idx_audit_actor_nn"]))?.sql
            : (await db.get<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = ?", ["idx_audit_actor_nn"]))?.indexdef;
        expect(def).toMatch(/actor_user_id IS NOT NULL/i);
      });

      it("Activity reads a delegated row from both sides; admin filters on either email", async () => {
        const { listAuditEvents, listAllAuditEvents } = await import("../src/audit/query");
        await db.run("INSERT INTO users (id, email) VALUES (?, ?), (?, ?)", ["u1", "dev@example.com", "u2", "qa@example.com"]);
        await db.run(
          `INSERT INTO audit_log (user_id, user_email, actor_user_id, actor_email, client_name, tool, action, success, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'EXECUTE', ?, ?), (?, NULL, NULL, NULL, NULL, ?, 'EXECUTE', ?, ?)`,
          ["u1", "dev@example.com", "u2", "qa@example.com", "space:team-dash", "delegated", true, 200, "u3", "unrelated", true, 300]
        );

        const owner = await listAuditEvents({ userId: "u1", limit: 10 });
        expect(owner.map((r) => r.delegation)).toEqual([
          { direction: "for_me", other_email: "qa@example.com", space: "team-dash" },
        ]);
        const viewer = await listAuditEvents({ userId: "u2", limit: 10, status: "success", cursor: { createdAt: 250, id: 1e9 } });
        expect(viewer.map((r) => r.delegation)).toEqual([
          { direction: "by_me", other_email: "dev@example.com", space: "team-dash" },
        ]);

        const admin = await listAllAuditEvents({ limit: 10, email: "QA@example.com" });
        expect(admin.map((r) => [r.tool, r.user_email, r.actor_email])).toEqual([["delegated", "dev@example.com", "qa@example.com"]]);
      });
    });

    // A delegated call end to end below the route: the owner's token is read,
    // and the audit row (through the logger's database destination) names
    // both people.
    describe("delegated execution", () => {
      beforeAll(async () => {
        target.current = db;
        const { registerFixtures } = await import("./spaces/fixtures");
        registerFixtures();
      });
      afterAll(() => {
        target.current = null;
      });

      it("executeDelegated runs on the owner's token and audits both ids", async () => {
        const { storeToken } = await import("../src/auth/tokens");
        const { executeDelegated } = await import("../src/mcp/meta-tools");
        const { runWithAuditContext } = await import("../src/audit/context");
        await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "dev@example.com"]);
        await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u2", "qa@example.com"]);
        await storeToken("u1", "acme-oauth", { accessToken: "tok-owner", scopes: "" });
        await storeToken("u2", "acme-oauth", { accessToken: "tok-viewer", scopes: "" });
        const out = await runWithAuditContext({ client_name: "space:s1" }, () =>
          executeDelegated("u1", "u2", "acmeo_whoami", {})
        );
        expect(out).toEqual({ result: { token: "tok-owner" } });
        const row = await db.get<Record<string, unknown>>(
          "SELECT user_id, user_email, actor_user_id, actor_email, client_name, tool FROM audit_log WHERE action = 'EXECUTE'"
        );
        expect(row).toEqual({
          user_id: "u1",
          user_email: "dev@example.com",
          actor_user_id: "u2",
          actor_email: "qa@example.com",
          client_name: "space:s1",
          tool: "acmeo_whoami",
        });
      });
    });

    // The CASE with a NULL-able placeholder (PostgreSQL needs a type for it),
    // ON CONFLICT ... RETURNING, and the read-then-upsert transaction.
    describe("spaces access mode", () => {
      beforeAll(() => {
        target.current = db;
      });
      afterAll(() => {
        target.current = null;
      });
      beforeEach(async () => {
        await db.run("DELETE FROM spaces");
      });
      const base = { name: "s1", ownerId: "u1", title: "T", tools: ["acme_list"], visibility: "org" as const };

      it("round-trips access_mode and delegated_tools_hash through the store", async () => {
        expect(await upsertSpace(base)).toEqual({ result: "ok", modeReset: false });
        expect(await getSpace("s1")).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });

        const on = await updateSpaceMeta("s1", "u1", {
          accessMode: "owner",
          confirmDelegation: true,
          expectedToolsHash: toolsHash(base.tools),
        });
        expect(on).toMatchObject({ modeReset: false });
        expect(await getSpace("s1")).toMatchObject({ accessMode: "owner", delegatedToolsHash: toolsHash(base.tools) });
        expect(await countDelegatedSpaces("u1")).toBe(1);

        // Redeploy without a mode keeps it; another owner is refused.
        expect(await upsertSpace({ ...base, tools: ["acme_other"] })).toEqual({ result: "ok", modeReset: false });
        expect(delegationSuspended((await getSpace("s1"))!)).toBe(true);
        expect(await upsertSpace({ ...base, ownerId: "u2" })).toEqual({ result: "taken", modeReset: false });

        expect(await upsertSpace({ ...base, visibility: "private" })).toEqual({ result: "ok", modeReset: true });
        expect(await getSpace("s1")).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });
        expect(await countDelegatedSpaces("u1")).toBe(0);
      });

      // disabled_at is a nullable integer read raw, and the audit row is
      // written through the logger's database destination.
      it("delegationFor reads the owner row and permission; the change is audited", async () => {
        await db.run("DELETE FROM users WHERE id IN ('u1', 'u2')");
        await db.run("DELETE FROM user_permissions");
        await db.run("DELETE FROM audit_log");
        await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "dev@example.com"]);
        await upsertSpace(base);
        await updateSpaceMeta("s1", "u1", { accessMode: "owner", confirmDelegation: true, expectedToolsHash: toolsHash(base.tools) });
        const s = (await getSpace("s1"))!;
        expect(await delegationFor(s)).toMatchObject({ mode: "off", reason: "turned_off" });
        await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
        expect(await delegationFor(s)).toEqual({ mode: "owner", runAs: "u1" });
        await db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [1700000000, "u1"]);
        expect(await delegationFor(s)).toMatchObject({ mode: "off", reason: "turned_off" });
        await db.run("DELETE FROM users WHERE id = ?", ["u1"]);
        expect(await delegationFor(s)).toMatchObject({ mode: "off", reason: "turned_off" });

        await recordDelegationChange(s, "u1", "off", "audience set to only me");
        const row = await db.get<{ user_id: string; action: string; tool: string; error: string | null }>(
          "SELECT user_id, action, tool, error FROM audit_log WHERE action = ?",
          ["SPACE_DELEGATION_OFF"]
        );
        expect(row).toEqual({
          user_id: "u1",
          action: "SPACE_DELEGATION_OFF",
          tool: "space:s1 (reason: audience set to only me)",
          error: null,
        });
      });
    });

    // The counts join the share list to users by lowercased email and use
    // EXISTS, COALESCE and an upsert with DO UPDATE: the parts most likely to
    // read differently on the two backends.
    describe("space favorites and opens", () => {
      beforeAll(() => {
        target.current = db;
      });
      afterAll(() => {
        target.current = null;
        _setNowForTest(() => Date.now());
      });
      beforeEach(async () => {
        for (const t of ["space_user_state", "space_shares", "spaces", "users"]) await db.run(`DELETE FROM ${t}`);
        for (const [id, email] of [
          ["owner", "Owner@Example.com"],
          ["a", "A@Example.com"],
          ["b", "b@example.com"],
          ["c", "c@example.com"],
        ]) {
          await db.run("INSERT INTO users (id, email) VALUES (?, ?)", [id, email]);
        }
        _setNowForTest(() => 1_000_000);
      });
      const mk = (name: string, visibility: "private" | "org" | "users") =>
        upsertSpace({ name, ownerId: "owner", title: name, tools: [], visibility });

      it("setFavorite is idempotent and keeps the first time; unfavoriting keeps the row for the open time", async () => {
        await mk("s1", "org");
        await setFavorite("s1", "a", true);
        _setNowForTest(() => 2_000_000);
        await setFavorite("s1", "a", true);
        const row = await db.get<{ favorited_at: number | string }>("SELECT favorited_at FROM space_user_state WHERE space_name = ? AND user_id = ?", ["s1", "a"]);
        expect(Number(row!.favorited_at)).toBe(1_000_000);

        await recordOpen("s1", "a");
        await setFavorite("s1", "a", false);
        expect((await userSpaceStates("a")).get("s1")).toEqual({ favorited: false, lastOpenedAt: 2_000_000 });
      });

      it("recordOpen upserts: one row per person, the time moves forward, a favorite survives", async () => {
        await mk("s1", "org");
        await setFavorite("s1", "a", true);
        await recordOpen("s1", "a");
        _setNowForTest(() => 3_000_000);
        await recordOpen("s1", "a");
        const rows = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM space_user_state WHERE space_name = ?", ["s1"]);
        expect(Number(rows[0].n)).toBe(1);
        expect((await userSpaceStates("a")).get("s1")).toEqual({ favorited: true, lastOpenedAt: 3_000_000 });
        expect((await userSpaceStates("b")).size).toBe(0);
      });

      it("favoriteCounts counts people who can still open the Space, by lowercased email, and skips private ones", async () => {
        await mk("shared", "users");
        await mk("wide", "org");
        await mk("solo", "private");
        // Shares are stored lowercased; the user's email has capitals.
        await setShares("shared", "owner", ["a@example.com", "b@example.com"]);
        for (const u of ["owner", "a", "b", "c"]) await setFavorite("shared", u, true);
        for (const u of ["a", "c"]) await setFavorite("wide", u, true);
        await setFavorite("solo", "owner", true);

        // c is not on the list, so does not count; the owner always does.
        expect(await favoriteCounts()).toEqual(new Map([["shared", 3], ["wide", 2]]));
        expect(await favoriteCounts("shared")).toEqual(new Map([["shared", 3]]));

        await setShares("shared", "owner", ["b@example.com"]);
        expect((await favoriteCounts("shared")).get("shared")).toBe(2);
        await setShares("shared", "owner", ["a@example.com", "b@example.com"]);
        expect((await favoriteCounts("shared")).get("shared")).toBe(3);
      });

      it("distinctOpeners counts other people in the window who can still open it, once each", async () => {
        await mk("shared", "users");
        await setShares("shared", "owner", ["a@example.com", "b@example.com"]);
        _setNowForTest(() => 10_000_000);
        for (const u of ["owner", "a", "b", "c"]) await recordOpen("shared", u);
        await recordOpen("shared", "a");
        await db.run("UPDATE space_user_state SET last_opened_at = ? WHERE space_name = ? AND user_id = ?", [1, "shared", "b"]);

        // Owner excluded, c has no access, b opened before the window: only a.
        expect(await distinctOpeners("owner", 5_000_000)).toEqual(new Map([["shared", 1]]));
        expect(await distinctOpeners("owner", 0)).toEqual(new Map([["shared", 2]]));
        expect(await distinctOpeners("someone-else", 0)).toEqual(new Map());
      });

      it("a title, description or audience edit does not move updatedAt; a new tool list does", async () => {
        await mk("s1", "org");
        const before = (await getSpace("s1"))!.updatedAt;
        _setNowForTest(() => 9_000_000);
        await updateSpaceMeta("s1", "owner", { title: "Renamed", description: "d" });
        await updateSpaceMeta("s1", "owner", { visibility: "private" });
        expect((await getSpace("s1"))!.updatedAt).toBe(before);
        await updateSpaceMeta("s1", "owner", { tools: ["acme_new"] });
        expect((await getSpace("s1"))!.updatedAt).toBe(9_000_000);
      });

      it("deleting a Space clears the per-person rows", async () => {
        await mk("s1", "org");
        await setFavorite("s1", "a", true);
        await recordOpen("s1", "b");
        await deleteSpace("s1");
        const left = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM space_user_state", []);
        expect(Number(left!.n)).toBe(0);
      });
    });

    // The maker-checker table: a partial unique index, a conditional UPDATE as
    // the arbiter, BIGINT times (strings from node-postgres), and a decision
    // whose effect shares one transaction with its status change.
    describe("approval requests", () => {
      beforeAll(() => {
        target.current = db;
      });
      afterAll(() => {
        target.current = null;
      });
      beforeEach(async () => {
        for (const t of ["approval_requests", "space_shares", "spaces", "audit_log", "users"]) await db.run(`DELETE FROM ${t}`);
        for (const [id, email] of [
          ["owner", "owner@example.com"],
          ["maker", "maker@example.com"],
          ["checker", "checker@example.com"],
        ]) {
          await db.run("INSERT INTO users (id, email) VALUES (?, ?)", [id, email]);
        }
      });

      const checker: Actor = { userId: "checker", email: "checker@example.com" };
      const KIND = "test.pg";

      /** A kind with a controllable effect, so the transaction behaviour is what is under test. */
      function fakeKind(apply: Kind["apply"]): Kind {
        return {
          name: KIND,
          clientCreatable: false,
          withinLimits: async () => true,
          canCreate: async () => ({ ok: false }),
          inboxFor: async () => ({ rows: [], next: null }),
          canDecide: async (a) => a.userId === "checker",
          validate: async () => ({ status: "ok" }),
          apply,
          describe: () => "pg",
          subjectLabel: async (r) => r.subject,
        };
      }

      it("creates the table and users.status, and applies the schema again without error", async () => {
        await applySchema(db);
        const col = await db.get<{ status: string }>("SELECT status FROM users WHERE id = ?", ["owner"]);
        expect(col?.status).toBe("active");
        expect(await db.all("SELECT * FROM approval_requests")).toEqual([]);
      });

      it("backfills disabled from disabled_at on every schema run, and leaves pending alone", async () => {
        await db.run("INSERT INTO users (id, email, disabled_at) VALUES (?, ?, ?)", ["old", "old@example.com", 5]);
        await db.run("INSERT INTO users (id, email, status, disabled_at) VALUES (?, ?, 'pending', ?)", ["pend", "pend@example.com", 5]);
        await applySchema(db);
        const rows = await db.all<{ id: string; status: string }>("SELECT id, status FROM users WHERE id IN ('old', 'pend') ORDER BY id");
        expect(rows).toEqual([{ id: "old", status: "disabled" }, { id: "pend", status: "pending" }]);
      });

      it("the partial unique index allows one open request per (kind, subject, requester), and a decided one frees the slot", async () => {
        const first = await insertRequest(db, { kind: KIND, subject: "x", requesterId: "maker" });
        expect(first).toBeTruthy();
        expect(await insertRequest(db, { kind: KIND, subject: "x", requesterId: "maker" })).toBeNull();
        // The index itself refuses a plain duplicate insert.
        await expect(
          db.run(
            "INSERT INTO approval_requests (id, kind, subject, requester_id, status, created_at) VALUES ('dup', ?, 'x', 'maker', 'pending', 1)",
            [KIND]
          )
        ).rejects.toThrow();
        expect(await decideRequest(db, first!, "rejected", "checker", null)).toBe(true);
        expect(await insertRequest(db, { kind: KIND, subject: "x", requesterId: "maker" })).toBeTruthy();
        // Closed rows are not constrained: any number of them may pile up.
        await db.run(
          "INSERT INTO approval_requests (id, kind, subject, requester_id, status, created_at) VALUES ('c1', ?, 'y', 'maker', 'cancelled', 1), ('c2', ?, 'y', 'maker', 'cancelled', 1)",
          [KIND, KIND]
        );
      });

      it("decide is conditional: of two decisions on one request exactly one reports a change", async () => {
        const id = (await insertRequest(db, { kind: KIND, subject: "x", requesterId: "maker" }))!;
        expect(await decideRequest(db, id, "approved", "checker", "n")).toBe(true);
        expect(await decideRequest(db, id, "rejected", "checker", null)).toBe(false);
        expect(await cancelRequest(id, "maker")).toBe(false);
        expect(await getRequest(id)).toMatchObject({ status: "approved", decidedBy: "checker", decisionNote: "n" });
      });

      it("reads BIGINT times back as numbers and pages with a cursor", async () => {
        for (let i = 1; i <= 3; i++) {
          await db.run(
            "INSERT INTO approval_requests (id, kind, subject, requester_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
            [`r${i}`, ACCOUNT_ACTIVATE, `u${i}`, `u${i}`, 1_700_000_000 + i]
          );
        }
        const r1 = await getRequest("r1");
        expect(typeof r1?.createdAt).toBe("number");
        const p1 = await pagePending(ACCOUNT_ACTIVATE, 2);
        expect(p1.rows.map((r) => r.id)).toEqual(["r3", "r2"]);
        const p2 = await pagePending(ACCOUNT_ACTIVATE, 2, p1.next!);
        expect(p2.rows.map((r) => r.id)).toEqual(["r1"]);
        expect(p2.next).toBeNull();
      });

      it("two concurrent approves (Promise.all) run the effect once", async () => {
        let applied = 0;
        const undo = _registerKindForTest(
          fakeKind(async () => {
            applied++;
            // Hold the transaction open so the second decision is genuinely concurrent.
            await new Promise((r) => setTimeout(r, 80));
            return { applied: true };
          })
        );
        try {
          const id = (await insertRequest(db, { kind: KIND, subject: "x", requesterId: "maker" }))!;
          const results = await Promise.all([
            decide(checker, id, "approve", { kinds: [KIND] }),
            decide(checker, id, "approve", { kinds: [KIND] }),
          ]);
          expect(applied).toBe(1);
          expect(results.filter((r) => r.ok && r.outcome === "approved")).toHaveLength(1);
          expect(await getRequest(id)).toMatchObject({ status: "approved" });
        } finally {
          undo();
        }
      });

      it("an approve racing a reject: one wins, and the effect runs only if approve won", async () => {
        let applied = 0;
        const undo = _registerKindForTest(
          fakeKind(async () => {
            applied++;
            await new Promise((r) => setTimeout(r, 50));
            return { applied: true };
          })
        );
        try {
          const id = (await insertRequest(db, { kind: KIND, subject: "x", requesterId: "maker" }))!;
          await Promise.all([decide(checker, id, "approve", { kinds: [KIND] }), decide(checker, id, "reject", { kinds: [KIND] })]);
          const status = (await getRequest(id))!.status;
          expect(["approved", "rejected"]).toContain(status);
          expect(applied).toBe(status === "approved" ? 1 : 0);
        } finally {
          undo();
        }
      });

      it("rolls the status change AND the effect back when apply throws", async () => {
        const undo = _registerKindForTest(
          fakeKind(async (_r, tx) => {
            await tx.run("INSERT INTO users (id, email) VALUES (?, ?)", ["effect-row", "effect@example.com"]);
            throw new Error("boom");
          })
        );
        try {
          const id = (await insertRequest(db, { kind: KIND, subject: "x", requesterId: "maker" }))!;
          await expect(decide(checker, id, "approve", { kinds: [KIND] })).rejects.toThrow("boom");
          expect(await getRequest(id)).toMatchObject({ status: "pending", decidedBy: null });
          expect(await db.get("SELECT id FROM users WHERE id = ?", ["effect-row"])).toBeUndefined();
        } finally {
          undo();
        }
      });

      it("a real space.access approve adds the share through the transaction it was handed", async () => {
        await upsertSpace({ name: "s1", ownerId: "owner", title: "s1", tools: [], visibility: "users" });
        const space = (await getSpace("s1"))!;
        const id = (await insertRequest(db, {
          kind: SPACE_ACCESS,
          subject: "s1",
          requesterId: "maker",
          payload: { space_created_at: space.createdAt },
        }))!;
        const r = await decide({ userId: "owner", email: "owner@example.com" }, id, "approve", { kinds: [SPACE_ACCESS] });
        expect(r).toMatchObject({ ok: true, outcome: "approved" });
        expect(await getShares("s1")).toEqual(["maker@example.com"]);
        expect(await getRequest(id)).toMatchObject({ status: "approved", decidedBy: "owner" });
      });

      it("deleteSpace closes the Space's open requests in its own transaction", async () => {
        await upsertSpace({ name: "s1", ownerId: "owner", title: "s1", tools: [], visibility: "users" });
        const id = (await insertRequest(db, { kind: SPACE_ACCESS, subject: "s1", requesterId: "maker", payload: {} }))!;
        await deleteSpace("s1");
        expect(await getRequest(id)).toMatchObject({ status: "cancelled", decisionNote: "space_deleted" });
      });

      it("an account.activate approve activates a still-pending user, and refuses one disabled meanwhile", async () => {
        const savedAdmins = config.ADMIN_EMAILS;
        config.ADMIN_EMAILS = ["checker@example.com"];
        try {
          for (const [uid, disabledMeanwhile] of [["p1", false], ["p2", true]] as const) {
            await db.run("INSERT INTO users (id, email, status, disabled_at) VALUES (?, ?, 'pending', 1)", [uid, `${uid}@example.com`]);
            const rid = (await insertRequest(db, { kind: ACCOUNT_ACTIVATE, subject: uid, requesterId: uid }))!;
            if (disabledMeanwhile) await db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [uid]);
            const r = await decide(checker, rid, "approve", { kinds: [ACCOUNT_ACTIVATE] });
            expect(r).toMatchObject({ ok: true, outcome: disabledMeanwhile ? "auto_rejected" : "approved" });
            expect(await getUserStatus(uid)).toBe(disabledMeanwhile ? "disabled" : "active");
          }
        } finally {
          config.ADMIN_EMAILS = savedAdmins;
        }
      });

      it("setUserStatus's from-guard is one statement on both backends", async () => {
        await db.run("INSERT INTO users (id, email, status, disabled_at) VALUES (?, ?, 'pending', 1)", ["g", "g@example.com"]);
        expect(await setUserStatus("g", "active", { from: "pending" })).toBe(true);
        expect(await setUserStatus("g", "active", { from: "pending" })).toBe(false);
        expect(await setUserStatus("g", "disabled", { nowSeconds: 77 })).toBe(true);
        const row = await db.get<{ status: string; disabled_at: number | string }>("SELECT status, disabled_at FROM users WHERE id = 'g'");
        expect(row?.status).toBe("disabled");
        expect(Number(row?.disabled_at)).toBe(77);
      });

      it("creates a pending user and its request in one transaction", async () => {
        const saved = { req: config.REQUIRE_SIGNUP_APPROVAL, admins: config.ADMIN_EMAILS };
        config.REQUIRE_SIGNUP_APPROVAL = true;
        config.ADMIN_EMAILS = ["checker@example.com"];
        try {
          const created = await createUserForSignup({ email: "new@example.com", provider: "google", sub: "g-new" });
          expect(created.pending).toBe(true);
          const row = await db.get<{ status: string; disabled_at: number | string | null }>("SELECT status, disabled_at FROM users WHERE id = ?", [created.id]);
          expect(row?.status).toBe("pending");
          expect(row?.disabled_at).not.toBeNull();
          const reqs = await db.all<{ kind: string; status: string }>("SELECT kind, status FROM approval_requests WHERE subject = ?", [created.id]);
          expect(reqs).toEqual([{ kind: ACCOUNT_ACTIVATE, status: "pending" }]);
          // An admin's email is created active, with no request.
          config.ADMIN_EMAILS = ["checker@example.com", "boss@example.com"];
          const boss = await createUserForSignup({ email: "boss@example.com", provider: "keycloak", sub: "kc-1" });
          expect(boss.pending).toBe(false);
          expect((await db.get<{ status: string }>("SELECT status FROM users WHERE id = ?", [boss.id]))?.status).toBe("active");
          expect(await db.get("SELECT id FROM approval_requests WHERE subject = ?", [boss.id])).toBeUndefined();
          // A duplicate email is refused by the unique index and leaves no half-created pair.
          config.ADMIN_EMAILS = ["checker@example.com"];
          await expect(createUserForSignup({ email: "new@example.com", provider: "google", sub: "g-other" })).rejects.toThrow();
          const dupes = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM approval_requests WHERE kind = ?", [ACCOUNT_ACTIVATE]);
          expect(Number(dupes?.n)).toBe(1);
        } finally {
          config.REQUIRE_SIGNUP_APPROVAL = saved.req;
          config.ADMIN_EMAILS = saved.admins;
        }
      });
    });
  });
}
