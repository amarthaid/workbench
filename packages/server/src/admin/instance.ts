import { config } from "../config";
import { db } from "../db";
import { auditStored } from "../audit/query";
import { parseAuditDest } from "../audit/destinations";
import { readVersion } from "../version";

export interface InstanceInfo {
  version: string;
  db_backend: "sqlite" | "postgres";
  cluster_enabled: boolean;
  /** Normalised AUDIT_LOG_DEST, e.g. "db" or "db,kafka". */
  audit_log_dest: string;
  audit_stored: boolean;
  user_count: number;
  admin_count: number;
}

const VERSION = readVersion();

export async function getInstanceInfo(): Promise<InstanceInfo> {
  const row = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM users");
  return {
    version: VERSION,
    db_backend: db.dialect,
    cluster_enabled: !!config.CLUSTER_ENABLED,
    audit_log_dest: parseAuditDest(config.AUDIT_LOG_DEST).join(","),
    audit_stored: auditStored(),
    user_count: Number(row?.n ?? 0),
    // A count, not the list: the allowlist is not for display.
    admin_count: (config.ADMIN_EMAILS ?? []).length,
  };
}
