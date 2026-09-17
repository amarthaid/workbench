import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseArgs, sourcePath, targetUrl, redact, coerce, TABLES } from "../src/migrate/plan";
import type { TargetColumn } from "../src/migrate/plan";

const col = (dataType: string, name = "c", isSerial = false): TargetColumn => ({ name, dataType, isSerial });

describe("migrate/plan — parseArgs", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([]).apply).toBe(false);
  });

  it("only writes when --apply is present", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
  });

  it("parses a comma-separated skip list", () => {
    expect([...parseArgs(["--skip=audit_log,pending_auth"]).skip]).toEqual(["audit_log", "pending_auth"]);
  });

  it("ignores empty entries in the skip list", () => {
    expect([...parseArgs(["--skip=audit_log,,"]).skip]).toEqual(["audit_log"]);
  });

  it("requires --allow-nonempty explicitly", () => {
    expect(parseArgs([]).allowNonEmpty).toBe(false);
    expect(parseArgs(["--allow-nonempty"]).allowNonEmpty).toBe(true);
  });
});

describe("migrate/plan — source and target resolution", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of ["SOURCE_SQLITE_PATH", "DATABASE_URL", "TARGET_DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
      delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("prefers SOURCE_SQLITE_PATH", () => {
    process.env.SOURCE_SQLITE_PATH = "/tmp/a.db";
    process.env.DATABASE_URL = "/data/tokens.db";
    expect(sourcePath()).toBe("/tmp/a.db");
  });

  it("falls back to DATABASE_URL when it is a file path", () => {
    process.env.DATABASE_URL = "./data/tokens.db";
    expect(sourcePath()).toBe("./data/tokens.db");
  });

  // The migration is normally run *after* the cutover env is prepared, so
  // DATABASE_URL may already point at PostgreSQL. Using it as the source would
  // read the empty target and report a successful no-op migration.
  it("ignores DATABASE_URL when it already points at PostgreSQL", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/d";
    expect(sourcePath()).toBe("/data/tokens.db");
  });

  it("uses TARGET_DATABASE_URL verbatim", () => {
    process.env.TARGET_DATABASE_URL = "postgres://u:p@h:5432/d";
    expect(targetUrl()).toBe("postgres://u:p@h:5432/d");
  });

  it("rejects a target that is not a postgres URL", () => {
    process.env.TARGET_DATABASE_URL = "/data/tokens.db";
    expect(() => targetUrl()).toThrow(/must be a postgres/);
  });

  it("assembles a URL from the libpq variables", () => {
    process.env.PGHOST = "db.internal";
    process.env.PGUSER = "workbench";
    process.env.PGPASSWORD = "pw";
    process.env.PGDATABASE = "workbench";
    expect(targetUrl()).toBe("postgres://workbench:pw@db.internal:5432/workbench");
  });

  it("percent-encodes credentials so a punctuated password cannot break the URL", () => {
    process.env.PGHOST = "db.internal";
    process.env.PGUSER = "user@corp";
    process.env.PGPASSWORD = "p@ss:word/1";
    process.env.PGDATABASE = "workbench";
    const url = targetUrl();
    expect(url).toContain("user%40corp");
    expect(url).toContain("p%40ss%3Aword%2F1");
    expect(new URL(url).hostname).toBe("db.internal");
  });

  it("honours PGPORT", () => {
    process.env.PGHOST = "db.internal";
    process.env.PGUSER = "u";
    process.env.PGDATABASE = "d";
    process.env.PGPORT = "6543";
    expect(targetUrl()).toContain(":6543/");
  });

  it("explains itself when nothing is configured", () => {
    expect(() => targetUrl()).toThrow(/TARGET_DATABASE_URL/);
  });
});

describe("migrate/plan — redact", () => {
  it("masks the password", () => {
    expect(redact("postgres://user:hunter2@host:5432/db")).not.toContain("hunter2");
  });

  it("keeps the host and database readable", () => {
    const out = redact("postgres://user:hunter2@host:5432/db");
    expect(out).toContain("host:5432");
    expect(out).toContain("/db");
  });

  it("never throws on junk input", () => {
    expect(redact("not a url")).toBe("<unparseable url>");
  });
});

describe("migrate/plan — coerce", () => {
  // The bug this whole exercise exists to prevent: SQLite stores booleans as
  // 0/1 and PostgreSQL refuses an integer for a BOOLEAN column.
  it("turns SQLite 0/1 into real booleans", () => {
    expect(coerce(1, col("boolean"))).toBe(true);
    expect(coerce(0, col("boolean"))).toBe(false);
  });

  it("passes booleans through untouched", () => {
    expect(coerce(true, col("boolean"))).toBe(true);
    expect(coerce(false, col("boolean"))).toBe(false);
  });

  it("reads stringly-typed booleans", () => {
    expect(coerce("0", col("boolean"))).toBe(false);
    expect(coerce("false", col("boolean"))).toBe(false);
    expect(coerce("", col("boolean"))).toBe(false);
    expect(coerce("1", col("boolean"))).toBe(true);
  });

  it("keeps a BLOB Buffer intact for bytea", () => {
    const buf = Buffer.from([0x00, 0xff, 0x7f]);
    const out = coerce(buf, col("bytea", "access_token"));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(Buffer.compare(out as Buffer, buf)).toBe(0);
  });

  it("wraps a Uint8Array for bytea", () => {
    const out = coerce(new Uint8Array([1, 2, 3]), col("bytea"));
    expect(Buffer.isBuffer(out)).toBe(true);
  });

  // A column that picked up TEXT affinity in SQLite hands back a string where
  // a Buffer was expected; PostgreSQL would reject it outright.
  it("encodes a stringly-typed blob for bytea", () => {
    const out = coerce("abc", col("bytea"));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect((out as Buffer).toString("utf8")).toBe("abc");
  });

  it("refuses a value it cannot store as bytea", () => {
    expect(() => coerce({ a: 1 }, col("bytea", "cookies"))).toThrow(/bytea/);
  });

  it("maps null and undefined to NULL", () => {
    expect(coerce(null, col("text"))).toBeNull();
    expect(coerce(undefined, col("text"))).toBeNull();
    expect(coerce(null, col("boolean"))).toBeNull();
    expect(coerce(null, col("bytea"))).toBeNull();
  });

  it("passes scalars through for ordinary columns", () => {
    expect(coerce("hello", col("text"))).toBe("hello");
    expect(coerce(42, col("integer"))).toBe(42);
    expect(coerce(9007199254740993n, col("bigint"))).toBe(9007199254740993n);
  });
});

describe("migrate/plan — TABLES", () => {
  it("covers every table the schema creates", () => {
    expect([...TABLES].sort()).toEqual(
      [
        "audit_log",
        "connections",
        "oauth_auth_codes",
        "oauth_clients",
        "oauth_refresh_tokens",
        "pending_auth",
        "user_vaults",
        "users",
      ].sort()
    );
  });
});
