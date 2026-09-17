import { z } from "zod";

const configSchema = z.object({
  PORT: z.string().default("3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ENCRYPTION_KEY: z.string().length(64).default(
    process.env.NODE_ENV === "test"
      ? "0000000000000000000000000000000000000000000000000000000000000000"
      : ""
  ),
  DATABASE_URL: z.string().default("./data/tokens.db"),
  PLUGINS_DIR: z.string().default("./plugins"),
  AUDIT_LOG_DEST: z.enum(["sqlite", "stdout", "kafka"]).default("sqlite"),
  AUDIT_LOG_KAFKA_BROKERS: z.string().optional(),
  AUDIT_LOG_KAFKA_TOPIC: z.string().default("audit-log"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  KEYCLOAK_ISSUER_URL: z.string().url().optional(),
  KEYCLOAK_CLIENT_ID: z.string().optional(),
  KEYCLOAK_CLIENT_SECRET: z.string().optional(),
  SERVER_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(32).default(
    process.env.NODE_ENV === "test"
      ? "test-session-secret-32-chars-long!!"
      : ""
  ),
  PORTAL_URL: z.string().url().default("http://localhost:5173"),
  PORTAL_DIST_DIR: z.string().default("./portal"),
  CONNECT_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  BROWSER_PROFILES_DIR: z.string().optional(),
  BROWSER_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Tabs one user may hold open in their chromium at once. Bounds an agent
  // that calls browser_start in a loop; the idle reaper bounds the rest.
  BROWSER_TAB_LIMIT: z.coerce.number().int().positive().default(8),
  // How long a chromium launch may take to bring DevTools up. A cold start in
  // a container measured 5.3s; the old fixed 40×100ms budget failed the first
  // call of every fresh container and passed the second.
  BROWSER_LAUNCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Whole-profile deletion after this many days unused. Deleting a profile logs
  // that user out of every cookie-auth integration, so it is deliberately far
  // more conservative than the cache trim, which costs nothing. 0 = never.
  BROWSER_PROFILE_TTL_DAYS: z.coerce.number().int().nonnegative().default(30),
  BROWSER_PROFILE_REAP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),
  BROWSER_DISK_CACHE_MB: z.coerce.number().int().nonnegative().default(32),
  JOTS_DIR: z.string().optional(),
  JOTS_MAX_BYTES: z.coerce.number().int().positive().default(5_242_880),
  JOTS_MAX_FILES: z.coerce.number().int().positive().default(1000),
  JOTS_UPLOAD_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // The agent file workspace. Its own mount, deliberately: RWX on a shared PVC
  // solves visibility between pods, not capacity, and a growing per-user tree
  // sharing a volume with tokens.db is
  // docs/findings/2026-08-06-browser-profile-disk-growth.md all over again.
  WORKSPACE_DIR: z.string().default("./data/workspace"),
  // Retention is age only: a file older than this is deleted whether or not
  // anything is using it, and a read does not extend its life. That is what
  // lets the reaper run out of process with no liveness state.
  WORKSPACE_TTL_HOURS: z.coerce.number().int().positive().default(24),
  WORKSPACE_MAX_FILE_BYTES: z.coerce.number().int().positive().default(104_857_600),
  WORKSPACE_MAX_BYTES_PER_USER: z.coerce.number().int().positive().default(268_435_456),
  WORKSPACE_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Maximum connections per worker pool. With CLUSTER_ENABLED the total
  // connection count is PG_POOL_MAX × worker count — keep this low enough
  // that (workers × PG_POOL_MAX) stays well under Postgres max_connections.
  PG_POOL_MAX: z.coerce.number().int().positive().default(2),
  // Milliseconds to wait for a free pool slot before rejecting. 0 = unlimited.
  PG_CONNECT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5000),
  // Enable cluster mode — forks os.availableParallelism() worker processes.
  // Requires a PostgreSQL DATABASE_URL — SQLite cannot be shared across processes.
  CLUSTER_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Internal URL for /mcp — used to route browser tools/call requests through
  // the mesh so that Istio's consistent-hash DestinationRule (keyed on
  // X-Browser-Session) places Chromium on the same replica for every call.
  // Set to the k8s ClusterIP service URL, e.g. http://a-workbench/mcp.
  // Leave unset for single-replica or local-dev deployments.
  INTERNAL_MCP_URL: z.string().url().optional(),
});

export const config = configSchema.parse(process.env);
