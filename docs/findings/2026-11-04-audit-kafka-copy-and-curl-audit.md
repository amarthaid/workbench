# Audit log: Kafka as a copy, and curl sessions audited

**Date:** 2026-11-04

## What was found

- **`AUDIT_LOG_DEST=sqlite` never meant SQLite.** It wrote through the shared
  `db` adapter, so on a `postgres://` `DATABASE_URL` it wrote PostgreSQL. The
  name made operators think the audit log lived outside their configured
  database.
- **`kafka` was a stub.** `KafkaDestination` printed "Kafka not implemented"
  and the JSON line to stdout; `AUDIT_LOG_KAFKA_BROKERS`/`_TOPIC` were read by
  nothing. Worse, the setting was single-valued, so choosing `kafka` (like
  `stdout`) meant *nothing* in `audit_log`, and the admin Activity and Overview
  tabs went blank (`stored: false`).
- **The curl proxy left no audit trail.** `curl_session` (the mint) and every
  `/c/<integration>/*` request wrote no `audit_log` row, although the token
  grants raw, possibly destructive, API access. `/rest/:integration` was
  already fine: it shares `executeSingle`/`executeMany` with `/mcp`, so it
  writes the same `EXECUTE` rows.

## What changed

- `AUDIT_LOG_DEST` is a comma list of `db` (alias `sqlite`), `stdout`, `kafka`.
  `kafka` is always a copy: listing it implies `db`, so `kafka` alone is
  `db,kafka` and the admin views keep working. Only `stdout` alone is
  "not stored".
- `src/audit/kafka.ts`: `log()` appends to a bounded in-memory queue and
  returns; one background loop drains it in order (batches ≤ 500, `acks=all`),
  retrying a failed batch whole with backoff 0.5 s → 30 s. A full queue drops
  new events from the copy only, counted in
  `workbench_audit_kafka_dropped_total`. Shutdown spends up to 5 s flushing,
  before the DB pool closes. At-least-once, so each message carries an
  `event_id`.
- `CURL_SESSION` row per mint (integrations + TTL, refusals with reason, never
  the token); `CURL_REQUEST` row per proxied call with `METHOD /path` — the
  query string, headers and body are deliberately not recorded. An audit write
  failure is logged, not turned into a failed proxy response.

## Gotchas

- The Kafka send is fanned out *before* the awaited DB insert. If the insert
  then throws, the event is in Kafka but not the table; the caller still sees
  the error as before.
- kafkajs `retry` is kept short (`retries: 2`): the queue loop is the
  long-running retry, so an outage never stacks kafkajs' own multi-minute
  backoff under it.
- The topic is not auto-created (`allowAutoTopicCreation: false`).
- kafkajs 2.2.4 is the last release (2023). It is pure JS, which keeps the
  Docker image free of a native librdkafka build; revisit if it rots.
