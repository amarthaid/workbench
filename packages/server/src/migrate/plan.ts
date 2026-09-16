/**
 * Pure planning + value-coercion logic for the SQLite → PostgreSQL migration.
 *
 * Deliberately imports nothing from `../db`: that module instantiates the
 * process-wide adapter on import, which would open a database just to unit-test
 * a string helper. Everything here is a pure function over its arguments.
 */
import type { SqlParam } from "../db-adapter";

/**
 * Copy order is cosmetic — the schema declares no foreign keys — but keeping
 * users first makes the progress output read sensibly.
 *
 * `pending_auth` and `oauth_auth_codes` hold in-flight handshake state that
 * expires within minutes. They are copied for completeness; `--skip` them if
 * the cutover is not immediate, since the rows will be dead on arrival.
 */
export const TABLES = [
  "users",
  "connections",
  "audit_log",
  "oauth_clients",
  "oauth_auth_codes",
  "oauth_refresh_tokens",
  "pending_auth",
  "user_vaults",
] as const;

/** Rows read from SQLite per round trip, and rows per INSERT sent to PostgreSQL. */
export const READ_BATCH = 500;
export const WRITE_BATCH = 200;

export interface TargetColumn {
  name: string;
  dataType: string;
  isSerial: boolean;
}

export function parseArgs(argv: string[]) {
  const skip = new Set<string>();
  for (const a of argv) {
    if (a.startsWith("--skip=")) {
      for (const t of a.slice("--skip=".length).split(",")) {
        if (t.trim()) skip.add(t.trim());
      }
    }
  }
  return {
    apply: argv.includes("--apply"),
    allowNonEmpty: argv.includes("--allow-nonempty"),
    skip,
  };
}

export function sourcePath(): string {
  const explicit = process.env.SOURCE_SQLITE_PATH;
  if (explicit) return explicit;
  const url = process.env.DATABASE_URL;
  if (url && !url.startsWith("postgres://") && !url.startsWith("postgresql://")) return url;
  return "/data/tokens.db";
}

export function targetUrl(): string {
  const explicit = process.env.TARGET_DATABASE_URL;
  if (explicit) {
    if (!explicit.startsWith("postgres://") && !explicit.startsWith("postgresql://")) {
      throw new Error("TARGET_DATABASE_URL must be a postgres:// or postgresql:// URL");
    }
    return explicit;
  }
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
  if (!PGHOST || !PGUSER || !PGDATABASE) {
    throw new Error(
      "No target configured. Set TARGET_DATABASE_URL, or PGHOST/PGUSER/PGDATABASE (+ PGPASSWORD, PGPORT)."
    );
  }
  const auth = PGPASSWORD
    ? `${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}`
    : encodeURIComponent(PGUSER);
  return `postgres://${auth}@${PGHOST}:${PGPORT ?? "5432"}/${PGDATABASE}`;
}

/** Never print a connection string with its password in it. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable url>";
  }
}

/**
 * Reshape one SQLite value for its PostgreSQL column.
 *
 * The two that matter: SQLite has no boolean type and stores 0/1, which
 * PostgreSQL refuses for a BOOLEAN column; and a BLOB may come back as a string
 * when the column picked up TEXT affinity, which PostgreSQL refuses for BYTEA.
 */
export function coerce(value: unknown, column: TargetColumn): SqlParam {
  if (value === null || value === undefined) return null;

  if (column.dataType === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "0" && value.toLowerCase() !== "false" && value !== "";
    return Boolean(value);
  }

  if (column.dataType === "bytea") {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === "string") return Buffer.from(value, "utf8");
    throw new Error(`cannot store ${typeof value} in a bytea column (${column.name})`);
  }

  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value;
  return String(value);
}
