import { config } from "./config";
import type { DbAdapter } from "./db-adapter";
import { SqliteAdapter } from "./db-sqlite";
import { PostgresAdapter } from "./db-postgres";

/**
 * Pick a backend from the connection string. A `postgres://` / `postgresql://`
 * URL selects PostgreSQL; anything else is treated as a SQLite file path, which
 * keeps every existing deployment working untouched.
 */
export function createDb(url: string, pgPoolMax?: number, pgConnectTimeoutMs?: number): DbAdapter {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return new PostgresAdapter(url, pgPoolMax, pgConnectTimeoutMs);
  }
  return new SqliteAdapter(url);
}

export const db: DbAdapter = createDb(config.DATABASE_URL, config.PG_POOL_MAX, config.PG_CONNECT_TIMEOUT_MS);

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    api_key_hash TEXT,
    email TEXT UNIQUE,
    google_sub TEXT UNIQUE,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    integration TEXT NOT NULL,
    access_token BLOB,
    refresh_token BLOB,
    expires_at INTEGER,
    scopes TEXT,
    cookies BLOB,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, integration)
  );

  CREATE TABLE IF NOT EXISTS pending_auth (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    integration TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    integration TEXT,
    tool TEXT,
    action TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    error TEXT,
    duration_ms INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_integration ON audit_log(integration, created_at);

  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT,
    resource TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT,
    expires_at INTEGER NOT NULL
  );
`;

const POSTGRES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    api_key_hash TEXT,
    email TEXT UNIQUE,
    google_sub TEXT UNIQUE,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
  );

  CREATE TABLE IF NOT EXISTS connections (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    integration TEXT NOT NULL,
    access_token BYTEA,
    refresh_token BYTEA,
    expires_at INTEGER,
    scopes TEXT,
    cookies BYTEA,
    created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
    updated_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
    UNIQUE(user_id, integration)
  );

  CREATE TABLE IF NOT EXISTS pending_auth (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    integration TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    integration TEXT,
    tool TEXT,
    action TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    error TEXT,
    duration_ms INTEGER,
    created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_integration ON audit_log(integration, created_at);

  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
  );

  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT,
    resource TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT,
    expires_at INTEGER NOT NULL
  );
`;

async function initSqliteSchema(db: DbAdapter): Promise<void> {
  await db.exec(SQLITE_SCHEMA);
  for (const stmt of [
    "ALTER TABLE users ADD COLUMN email TEXT",
    "ALTER TABLE users ADD COLUMN google_sub TEXT",
    "ALTER TABLE connections ADD COLUMN cookies BLOB",
    "ALTER TABLE pending_auth ADD COLUMN session_data TEXT",
    "ALTER TABLE pending_auth ADD COLUMN code_verifier TEXT",
    "ALTER TABLE users ADD COLUMN api_key_enc BLOB",
    "ALTER TABLE connections ADD COLUMN config TEXT",
    "ALTER TABLE pending_auth ADD COLUMN config TEXT",
    "ALTER TABLE oauth_refresh_tokens ADD COLUMN created_at INTEGER",
    "ALTER TABLE users ADD COLUMN keycloak_sub TEXT",
    "ALTER TABLE users ADD COLUMN api_key_sha TEXT",
    "ALTER TABLE pending_auth ADD COLUMN nonce TEXT",
  ]) {
    try {
      await db.exec(stmt);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) throw e;
    }
  }
  try {
    await db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_keycloak_sub ON users(keycloak_sub) WHERE keycloak_sub IS NOT NULL"
    );
  } catch { /* already exists */ }
  try {
    await db.exec(
      "CREATE INDEX IF NOT EXISTS idx_users_api_key_sha ON users(api_key_sha) WHERE api_key_sha IS NOT NULL"
    );
  } catch { /* already exists */ }
}

async function initPostgresSchema(db: DbAdapter): Promise<void> {
  await db.exec(POSTGRES_SCHEMA);
  // PostgreSQL 9.6+ supports ADD COLUMN IF NOT EXISTS
  await db.exec(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
    ALTER TABLE connections ADD COLUMN IF NOT EXISTS cookies BYTEA;
    ALTER TABLE pending_auth ADD COLUMN IF NOT EXISTS session_data TEXT;
    ALTER TABLE pending_auth ADD COLUMN IF NOT EXISTS code_verifier TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_enc BYTEA;
    ALTER TABLE connections ADD COLUMN IF NOT EXISTS config TEXT;
    ALTER TABLE pending_auth ADD COLUMN IF NOT EXISTS config TEXT;
    ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS created_at INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS keycloak_sub TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_sha TEXT;
    ALTER TABLE pending_auth ADD COLUMN IF NOT EXISTS nonce TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_keycloak_sub ON users(keycloak_sub) WHERE keycloak_sub IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_api_key_sha ON users(api_key_sha) WHERE api_key_sha IS NOT NULL;
  `);
}

/**
 * Create the schema and run migrations on `target`. Idempotent.
 *
 * Takes the adapter rather than closing over the module singleton so the
 * integration suite can stand up a throwaway database of either dialect and
 * exercise exactly the DDL production runs.
 */
export async function applySchema(target: DbAdapter): Promise<void> {
  if (target.dialect === "sqlite") {
    await initSqliteSchema(target);
  } else {
    await initPostgresSchema(target);
  }
}

export function initDb(): Promise<void> {
  return applySchema(db);
}
