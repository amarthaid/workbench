import { db } from "../db";
import { auditStored } from "../audit/query";
import { getConnectionStats } from "./connections";

const DAY = 86_400;

export interface UsageStats {
  /** False when audit events go to stdout or kafka: the numbers would be zeros, not facts. */
  stored: boolean;
  calls_24h: number;
  /** The 24h before that, so a card can show a trend. */
  calls_prev_24h: number;
  errors_24h: number;
  active_users_7d: number;
  total_users: number;
  disabled_users: number;
  needs_reconnect: number;
}

export interface TopTool {
  integration: string | null;
  tool: string | null;
  calls: number;
  errors: number;
  avg_ms: number | null;
}

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Headline numbers for the Overview. Tool calls are the `EXECUTE` audit rows,
 * the same definition the per-user summary uses. User and connection counts do
 * not depend on the audit destination, so they are filled in either way.
 */
export async function getUsageStats(nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<UsageStats> {
  const users = await db.get<{ total: number | string; disabled: number | string | null }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN disabled_at IS NOT NULL THEN 1 ELSE 0 END) AS disabled
       FROM users`
  );
  const conns = await getConnectionStats(nowSeconds);
  const base = {
    total_users: num(users?.total),
    disabled_users: num(users?.disabled),
    needs_reconnect: conns.integrations.reduce((n, c) => n + c.needs_reconnect, 0),
  };
  if (!auditStored()) {
    return { stored: false, calls_24h: 0, calls_prev_24h: 0, errors_24h: 0, active_users_7d: 0, ...base };
  }

  const calls = await db.get<{ cur: number | string | null; prev: number | string | null; errs: number | string | null }>(
    `SELECT SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS cur,
            SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END) AS prev,
            SUM(CASE WHEN created_at >= ? AND success = ? THEN 1 ELSE 0 END) AS errs
       FROM audit_log
      WHERE action = 'EXECUTE' AND created_at >= ?`,
    [nowSeconds - DAY, nowSeconds - DAY, nowSeconds - DAY, false, nowSeconds - 2 * DAY]
  );
  const active = await db.get<{ n: number | string }>(
    "SELECT COUNT(DISTINCT user_id) AS n FROM audit_log WHERE action = 'EXECUTE' AND created_at >= ?",
    [nowSeconds - 7 * DAY]
  );
  return {
    stored: true,
    calls_24h: num(calls?.cur),
    calls_prev_24h: num(calls?.prev),
    errors_24h: num(calls?.errs),
    active_users_7d: num(active?.n),
    ...base,
  };
}

/** The most-called tools over the last 7 days. */
export async function getTopTools(
  nowSeconds: number = Math.floor(Date.now() / 1000),
  limit = 10
): Promise<{ stored: boolean; tools: TopTool[] }> {
  if (!auditStored()) return { stored: false, tools: [] };
  const rows = await db.all<Record<string, unknown>>(
    `SELECT integration, tool, COUNT(*) AS calls,
            SUM(CASE WHEN success = ? THEN 0 ELSE 1 END) AS errors,
            AVG(duration_ms) AS avg_ms
       FROM audit_log
      WHERE action = 'EXECUTE' AND created_at >= ?
      GROUP BY integration, tool
      ORDER BY calls DESC, tool ASC
      LIMIT ?`,
    [true, nowSeconds - 7 * DAY, limit]
  );
  return {
    stored: true,
    tools: rows.map((r) => ({
      integration: (r.integration as string | null) ?? null,
      tool: (r.tool as string | null) ?? null,
      calls: num(r.calls),
      errors: num(r.errors),
      avg_ms: r.avg_ms === null || r.avg_ms === undefined ? null : Math.round(Number(r.avg_ms)),
    })),
  };
}
