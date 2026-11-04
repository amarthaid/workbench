import { AuditEvent } from "@a-workbench/shared";
import { config } from "../config";
import { db } from "../db";
import { createKafkajsSender, KafkaCopy, kafkaSettingsFromConfig } from "./kafka";

export interface AuditDestination {
  log(event: AuditEvent): void | Promise<void>;
}

/**
 * The `audit_log` table in the configured database (DATABASE_URL: SQLite or
 * PostgreSQL). Captured arguments / results (AUDIT_PAYLOAD) go to the
 * separate `audit_payload` table keyed by the audit row's id, so the summary
 * queries (Activity, Overview) never read the wide columns.
 */
export class DbDestination implements AuditDestination {
  async log(event: AuditEvent): Promise<void> {
    const hasPayload = event.args !== undefined || event.result !== undefined;
    const params = [
      event.user_id,
      event.user_email ?? null,
      event.source_ip ?? null,
      event.user_agent ?? null,
      event.auth_method ?? null,
      event.client_id ?? null,
      event.client_name ?? null,
      event.integration ?? null,
      event.tool ?? null,
      event.action,
      // A real boolean, not 1/0: `success` is BOOLEAN and PostgreSQL rejects
      // an integer for it. The SQLite adapter converts on the way in.
      event.success,
      event.error ?? null,
      event.duration_ms ?? null,
      Math.floor(new Date(event.timestamp).getTime() / 1000),
    ];
    const insert = `INSERT INTO audit_log (user_id, user_email, source_ip, user_agent, auth_method, client_id, client_name,
         integration, tool, action, success, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    if (!hasPayload) {
      await db.run(insert, params);
      return;
    }
    // RETURNING works on both backends (SQLite >= 3.35).
    const row = await db.get<{ id: number | string }>(`${insert} RETURNING id`, params);
    if (!row) return;
    try {
      await db.run(
        `INSERT INTO audit_payload (audit_id, args, args_truncated, args_bytes, result, result_truncated, result_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(row.id),
          event.args ?? null,
          !!event.args_truncated,
          event.args_bytes ?? null,
          event.result ?? null,
          !!event.result_truncated,
          event.result_bytes ?? null,
        ]
      );
    } catch (e) {
      // The audit row is written; losing its payload must not fail the tool call.
      console.error("[audit] payload write failed:", e instanceof Error ? e.message : e);
    }
  }
}

/** @deprecated The old name; it always wrote the configured database, SQLite or not. */
export const SqliteDestination = DbDestination;

export class StdoutDestination implements AuditDestination {
  log(event: AuditEvent): void {
    console.log(JSON.stringify(event));
  }
}

export type AuditDestName = "db" | "stdout" | "kafka";

/**
 * The destinations AUDIT_LOG_DEST names, in a fixed order. `sqlite` is an
 * alias for `db`. `kafka` is only ever a copy: listing it adds `db` too, so
 * `kafka` alone means `db,kafka` and the admin Activity tab keeps working.
 */
export function parseAuditDest(raw: string | undefined): AuditDestName[] {
  const names = new Set<AuditDestName>();
  for (const part of (raw || "db").split(",")) {
    const s = part.trim();
    if (s === "db" || s === "sqlite") names.add("db");
    else if (s === "stdout" || s === "kafka") names.add(s);
  }
  if (names.has("kafka")) names.add("db");
  if (!names.size) names.add("db");
  return (["db", "stdout", "kafka"] as const).filter((n) => names.has(n));
}

/**
 * Fan an event out to several destinations. The Kafka copy and stdout are
 * synchronous and never throw, so they run first; the database write is
 * awaited last and its error, if any, still reaches the caller as before.
 */
export class FanOutDestination implements AuditDestination {
  constructor(private readonly dests: AuditDestination[]) {}
  async log(event: AuditEvent): Promise<void> {
    const pending: Array<void | Promise<void>> = [];
    for (const d of this.dests) pending.push(d.log(event));
    await Promise.all(pending);
  }
}

let kafkaCopy: KafkaCopy | null = null;

export function createDestination(): AuditDestination {
  const names = parseAuditDest(config.AUDIT_LOG_DEST);
  const dests: AuditDestination[] = [];
  // Kafka first: it only queues, so it never waits behind the database write.
  if (names.includes("kafka")) {
    const s = kafkaSettingsFromConfig(config);
    kafkaCopy = new KafkaCopy({ topic: s.topic, queueMax: s.queueMax, sender: createKafkajsSender(s) });
    dests.push(kafkaCopy);
  }
  if (names.includes("stdout")) dests.push(new StdoutDestination());
  if (names.includes("db")) dests.push(new DbDestination());
  return dests.length === 1 ? dests[0] : new FanOutDestination(dests);
}

/** On shutdown: send what the Kafka copy still holds, within `timeoutMs`. No-op without Kafka. */
export async function flushAuditDestinations(timeoutMs: number): Promise<void> {
  await kafkaCopy?.flush(timeoutMs);
}
