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
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema, createDb } from "../src/db";
import type { DbAdapter } from "../src/db-adapter";

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

    it("migrates the pre-release connectors table and connector: keys", async () => {
      // Recreate the old table + seed pre-rename data, then re-apply the schema.
      const blob = backend.name === "sqlite" ? "BLOB" : "BYTEA";
      await db.exec(
        `CREATE TABLE connectors (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, metadata TEXT NOT NULL, client_id TEXT, client_secret_enc ${blob}, created_at INTEGER, updated_at INTEGER, UNIQUE(user_id, name))`
      );
      await db.run("INSERT INTO connectors (id, user_id, name, base_url, metadata) VALUES (?, ?, ?, ?, ?)", ["old-id", "u1", "notion", "https://x", "{}"]);
      await db.run("INSERT INTO connections (user_id, integration) VALUES (?, ?)", ["u1", "connector:old-id"]);
      await db.run("INSERT INTO audit_log (user_id, integration, action, success) VALUES (?, ?, ?, ?)", ["u1", "connector:old-id", "EXECUTE", true]);

      await applySchema(db);

      const apps = await db.all<{ id: string; name: string }>("SELECT id, name FROM custom_apps");
      expect(apps.map((a) => `${a.id}:${a.name}`)).toContain("old-id:notion");
      const conn = await db.get<{ integration: string }>("SELECT integration FROM connections");
      expect(conn?.integration).toBe("custom:old-id");
      const audit = await db.get<{ integration: string }>("SELECT integration FROM audit_log");
      expect(audit?.integration).toBe("custom:old-id");
      await expect(db.get("SELECT 1 FROM connectors")).rejects.toThrow();
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
  });
}
