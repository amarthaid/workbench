import { z } from "zod";

// Comma-separated allowlist of admin emails. Trimmed and lowercased once here so
// every comparison elsewhere is a plain `includes`. Empty entries are dropped:
// ADMIN_EMAILS="," must not produce an entry that matches a user with no email.
export function parseAdminEmails(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export const configSchema = z.object({
  PORT: z.string().default("3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ENCRYPTION_KEY: z.string().length(64).default(
    process.env.NODE_ENV === "test"
      ? "0000000000000000000000000000000000000000000000000000000000000000"
      : ""
  ),
  DATABASE_URL: z.string().default("./data/tokens.db"),
  PLUGINS_DIR: z.string().default("./plugins"),
  // Where audit events go: a comma-separated list of `db` (alias `sqlite`:
  // the configured DATABASE_URL, SQLite or PostgreSQL), `stdout` and `kafka`.
  // `kafka` is always a copy: listing it also writes the database
  // (src/audit/destinations.ts).
  AUDIT_LOG_DEST: z
    .string()
    .default("db")
    .refine(
      (v) => v.split(",").map((s) => s.trim()).filter(Boolean).length > 0
        && v.split(",").map((s) => s.trim()).filter(Boolean).every((s) => ["db", "sqlite", "stdout", "kafka"].includes(s)),
      { message: "AUDIT_LOG_DEST must be a comma-separated list of db, sqlite, stdout, kafka" }
    ),
  // Tool-call arguments / results in the audit log (src/audit/payload.ts):
  // off (default), args, or full (args + result). Sanitised and capped per
  // value (arguments and result each have their own cap, in UTF-8 bytes of the
  // JSON text); stored in `audit_payload` and carried in the Kafka / stdout
  // events. Curl proxy bodies are never recorded.
  AUDIT_PAYLOAD: z.enum(["off", "args", "full"]).default("off"),
  // At most 256 KiB each, so an event carrying both stays under Kafka's
  // default 1 MB message limit (message.max.bytes).
  AUDIT_PAYLOAD_ARGS_MAX_BYTES: z.coerce.number().int().min(256).max(262_144).default(8192),
  AUDIT_PAYLOAD_RESULT_MAX_BYTES: z.coerce.number().int().min(256).max(262_144).default(8192),
  // Kafka copy of the audit log (only read when AUDIT_LOG_DEST lists kafka).
  AUDIT_LOG_KAFKA_BROKERS: z.string().optional(), // comma-separated host:port
  AUDIT_LOG_KAFKA_TOPIC: z.string().default("audit-log"),
  AUDIT_LOG_KAFKA_CLIENT_ID: z.string().default("workbench"),
  AUDIT_LOG_KAFKA_SSL: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  AUDIT_LOG_KAFKA_SASL_MECHANISM: z.enum(["plain", "scram-sha-256", "scram-sha-512"]).optional(),
  AUDIT_LOG_KAFKA_SASL_USERNAME: z.string().optional(),
  AUDIT_LOG_KAFKA_SASL_PASSWORD: z.string().optional(),
  // Events waiting for Kafka, held in memory. Past it new events are dropped
  // from the Kafka copy (the database still has them).
  AUDIT_LOG_KAFKA_QUEUE_MAX: z.coerce.number().int().positive().default(10000),
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
  // Who may use /api/admin/* and the portal's Admin page. Empty (the default)
  // means nobody: admin is off unless an operator names an admin.
  ADMIN_EMAILS: z.string().default("").transform(parseAdminEmails),
  // How often each process re-reads instance_settings, so a change an admin made
  // through another worker or pod reaches this one. A change made through this
  // process applies immediately.
  INSTANCE_SETTINGS_POLL_SECONDS: z.coerce.number().int().positive().default(5),
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
  // Virtual speaker + mic per user's chromium so an agent can take part in a
  // browser call (docs/superpowers/specs/2026-10-07-browser-audio-pipeline-design.md).
  // Off: no PulseAudio daemon, no devices, the audio tools answer AUDIO_DISABLED.
  // TEST ONLY. Lets agent tabs load loopback URLs (chromium e2e fixtures on
  // 127.0.0.1). Agent tabs otherwise fail every request to loopback, because
  // every user's chromium debug endpoint listens there
  // (src/auth/agent-net-guard.ts). Ignored when NODE_ENV is "production".
  BROWSER_ALLOW_LOOPBACK: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Loopback ports agent tabs MAY open, comma-separated (e.g. "8080"), so
  // a local developer can point the agent at a dev server. Honoured in every
  // environment. Never opens a live chromium debug port or this server's own
  // port, even when listed (src/auth/browser-url.ts).
  BROWSER_LOOPBACK_ALLOW_PORTS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n > 0 && n < 65536)
    ),
  BROWSER_AUDIO_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Hard cap on one audio session, so a forgotten uplink cannot hold a
  // chromium and two child processes forever. Above slaude's own 120-minute
  // call cap, so the client ends a long call before the server does.
  BROWSER_AUDIO_MAX_MINUTES: z.coerce.number().int().positive().max(1440).default(180),
  // How long a fresh audio session waits for its first SSE reader or uplink
  // before ending "idle" (afterwards the allowance is 60 s). Long enough for a
  // human to approve the call in the voice client.
  BROWSER_AUDIO_FIRST_ATTACH_SECONDS: z.coerce.number().int().positive().max(3600).default(600),
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
  // Dedicated scrape credential for GET /metrics (Prometheus process/app
  // metrics, including the full internal route table and tool-execution
  // counters). Unset = the endpoint is closed: metrics were previously
  // served to anyone with no authentication at all, which handed an
  // unauthenticated caller the route table and connected-integration names
  // for free. Set this and point the scraper's Authorization: Bearer header
  // at it to re-enable scraping.
  METRICS_TOKEN: z.string().optional(),
  // Internal URL for /mcp — used to route browser tools/call requests through
  // the mesh so that Istio's consistent-hash DestinationRule (keyed on
  // X-Browser-Session) places Chromium on the same replica for every call.
  // Set to the k8s ClusterIP service URL, e.g. http://a-workbench/mcp.
  // Leave unset for single-replica or local-dev deployments.
  INTERNAL_MCP_URL: z.string().url().optional(),
  // Which proxies in front of the server to trust for X-Forwarded-For, so
  // request.ip (the audit log's source_ip, the request log's remoteAddress)
  // is the client and not the load balancer. Unset = trust none (the direct
  // peer is the address). "true" = trust every hop (only when nothing can
  // reach the server except through your proxy); a number = that many hops;
  // otherwise a comma-separated list of proxy IPs / CIDRs (include the pod
  // range when INTERNAL_MCP_URL forwards between replicas).
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v): boolean | number | string[] | undefined => {
      const s = v?.trim();
      if (!s || s === "false") return undefined;
      if (s === "true") return true;
      if (/^\d+$/.test(s)) return Number(s);
      return s.split(",").map((x) => x.trim()).filter(Boolean);
    }),
  // A single-value header a CDN puts the real client address in, e.g.
  // cf-connecting-ip (Cloudflare), true-client-ip, x-real-ip. Believed only
  // when the connection comes from a peer TRUST_PROXY trusts, and only when it
  // is a valid IP; otherwise the X-Forwarded-For / socket address stands.
  // Ignored without TRUST_PROXY (src/trust-proxy.ts).
  CLIENT_IP_HEADER: z
    .string()
    .optional()
    .transform((v) => v?.trim().toLowerCase() || undefined)
    .refine((v) => v === undefined || /^[a-z0-9-]{1,64}$/.test(v), {
      message: "CLIENT_IP_HEADER must be a header name, e.g. cf-connecting-ip",
    }),
});

export const config = configSchema.parse(process.env);
