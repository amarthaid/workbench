---
title: Observability
description: The Prometheus metrics endpoint and the metrics it emits, OpenTelemetry tracing, and the audit log destinations.
---

Three separate mechanisms: Prometheus metrics on `/metrics`, OpenTelemetry spans,
and an audit log of tool executions. Metrics and the audit log work out of the
box. Tracing needs an exporter you configure yourself.

## Metrics

```bash
curl http://localhost:3000/metrics
```

`GET /metrics` serves a Prometheus text exposition from a dedicated registry. It
includes `collectDefaultMetrics` — Node process, GC, and heap gauges — plus four
custom metrics.

| Metric | Type | Labels | Buckets |
|---|---|---|---|
| `workbench_http_requests_total` | Counter | `method`, `route`, `status` | — |
| `workbench_http_request_duration_seconds` | Histogram | `method`, `route`, `status` | 0.005 → 5, 10 buckets |
| `workbench_tool_executions_total` | Counter | `integration`, `tool`, `success` | — |
| `workbench_tool_execution_duration_seconds` | Histogram | `integration`, `tool`, `success` | 0.05 → 30, 9 buckets |

The two tool metrics are the interesting ones — the per-integration, per-tool
success rate and latency of the handlers agents run:

```promql
sum by (integration) (rate(workbench_tool_executions_total{success="false"}[5m]))

histogram_quantile(0.95,
  sum by (le, integration) (rate(workbench_tool_execution_duration_seconds_bucket[5m])))
```

> [!WARNING] Both tool metrics cover handler execution only
> They are incremented around the handler call, after the connection check and
> argument validation. A call rejected with `NOT_CONNECTED`, or one whose
> arguments fail schema validation, returns before either metric is touched — so
> neither appears in `workbench_tool_executions_total{success="false"}`. Both are
> audit-logged, so query the audit log for those.

HTTP metrics are recorded in request/response hooks, labelled by the matched route
pattern where one exists and the raw URL otherwise. `/metrics` excludes itself, so
scraping does not inflate its own counters.

> [!WARNING] `/metrics` is unauthenticated, and its `route` label is unbounded
> There is no auth on the endpoint. Route labels expose which routes exist and
> tool labels expose which integrations are in use. Worse, an unmatched request
> has no route pattern, so the hook falls back to the raw `request.url` — every
> distinct 404 URL becomes its own label value and its own time series, and a
> scanner hitting random paths grows the registry without limit until the process
> runs out of memory. Keep the endpoint on an internal network or block it at the
> reverse proxy, and rate-limit or drop unmatched paths in front of the server.

There is no log-level setting. The Fastify logger is constructed inline with a
redaction list and nothing else — no `LOG_LEVEL` variable exists in the config
schema or is read from the environment, so the logger runs at Fastify's default
level and the only way to change it is to edit the source.

Because there is no `/health`, `/healthz`, or `/readyz` route anywhere in the
server, and the image declares no `HEALTHCHECK`, `/metrics` is also the only HTTP
endpoint available for an orchestrator liveness probe. A TCP check on the listen
port is the alternative.

## Tracing

OpenTelemetry is initialized for its side effect at server startup. It registers a
`NodeTracerProvider` with an `HttpInstrumentation`, under the service name
`workbench`, and the server code wraps operations in spans through a `withSpan`
helper that sets OK/ERROR status and records exceptions.

The entire setup is wrapped in try/catch and loaded with `require()` rather than
`import`, so a partially installed or version-mismatched OTel dependency logs
`[telemetry] disabled: …` and the server still boots. If you expect traces and see
that line, that is where to look.

> [!NOTE] No exporter is configured in the repository
> The SDK is started with `traceExporter: undefined`. Spans are produced but
> nothing ships them anywhere by default, and there is no OTLP endpoint setting in
> the config schema. Export is configured entirely through the standard `OTEL_*`
> environment variables the SDK reads on its own.

To point it at a collector, set the standard variables on the process:

```bash
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

One caveat when correlating: the resource's `service.version` is hardcoded to
`0.1.0` and does not track the release version, so do not group dashboards by it.

## Audit log

Every tool execution (over `/mcp` or [`/rest`](../reference/rest-endpoint.md)),
every `curl_session` mint (`CURL_SESSION`), every request through the curl proxy
(`CURL_REQUEST`), and every admin change is recorded as an audit event with a
timestamp, user, tool, integration, action, success flag, error message, and
duration. `AUDIT_LOG_DEST` selects where events go: a comma-separated list.

| Value | Behaviour |
|---|---|
| `db` (default; `sqlite` is the old name) | `INSERT` into the `audit_log` table of the configured database |
| `stdout` | One JSON line per event on stdout |
| `kafka` | A **copy** to a Kafka topic, always alongside `db` |

`db` writes to whichever backend `DATABASE_URL` selects, SQLite or PostgreSQL.
The admin Activity and Overview tabs read the database, so they work whenever
`db` is in the list. `kafka` never replaces it: `AUDIT_LOG_DEST=kafka` means
`db,kafka`. Only `stdout` alone leaves the table empty. The `success` column is bound as a real boolean, because
PostgreSQL rejects `1`/`0` for `BOOLEAN`. `created_at` is unix seconds. Two
indexes support querying: `(user_id, created_at)` and `(integration, created_at)`.

### Arguments and results (`AUDIT_PAYLOAD`)

Off by default. `AUDIT_PAYLOAD=args` records the arguments of every tool call
(over `/mcp` and `/rest`); `full` also records the result. Every event, payload or not,
also carries `user_email`.

- **What is recorded.** Arguments as the agent *sent* them, before
  `{{vault:NAME}}` references are resolved, so vault secrets stay placeholders. The
  result as the agent received it, already vault-scrubbed. The vault's own tools never
  record arguments.
- **Sanitised.** Any key naming a credential (`password`, `secret`, `token`,
  `apiKey`, `authorization`, `cookie`, `privateKey`, `otp`, `pin`, …), at any depth, is
  replaced with `"[REDACTED]"`. Binary data, `data:` URIs and long base64 runs (screenshots,
  file contents) become `"[binary N bytes]"`. A secret the agent typed into an ordinary
  field (for example `browser_type` text) is **not** caught: the audit log holds what the
  agent sent.
- **Limited.** Arguments and result each have a cap, in UTF-8 bytes of their JSON text:
  `AUDIT_PAYLOAD_ARGS_MAX_BYTES` and `AUDIT_PAYLOAD_RESULT_MAX_BYTES` (default 8192,
  256–262144). Past the cap the value is **cut, not dropped**: the first part is kept,
  `args_truncated` / `result_truncated` is `true`, and `args_bytes` / `result_bytes`
  hold the full size. The event itself is always written. A cut value is no longer valid
  JSON. The 256 KiB maximum keeps an event carrying both under Kafka's default 1 MB
  message limit.
- **Where it goes.** In the database, the separate `audit_payload` table (one row per
  event that has a payload); in Kafka and stdout, the `args`, `args_truncated`,
  `args_bytes`, `result`, `result_truncated`, `result_bytes` fields of the event.
- **Who can read it.** Admins, per event, from Admin → Activity → **Details**. Every
  such read writes its own `ADMIN_AUDIT_PAYLOAD_VIEW` event. Users do not see payloads on
  their own Activity page.
- **Not for curl.** `CURL_REQUEST` rows never carry bodies, headers or query strings,
  whatever `AUDIT_PAYLOAD` says.
- **Growth.** Up to the two caps per tool call, and nothing prunes it. On SQLite the
  table lives in the same file as the stored credentials; size the volume, or prune
  `audit_payload` yourself.

### Kafka copy

Set `AUDIT_LOG_DEST=db,kafka` and `AUDIT_LOG_KAFKA_BROKERS`; the other
`AUDIT_LOG_KAFKA_*` settings are in the [environment reference](../reference/environment.md#audit-and-telemetry).
The server refuses to start when `kafka` is listed and no broker is set.

- **Tool calls never wait on Kafka.** An event is written to the database as
  before and appended to an in-memory queue; one background producer drains the
  queue in order, in batches of up to 500, with `acks=all`. A broker outage
  retries with backoff (0.5 s doubling to 30 s) and does not affect tool calls.
- **The copy is bounded.** Past `AUDIT_LOG_KAFKA_QUEUE_MAX` (default 10000)
  queued events, new events are dropped from the Kafka copy, never from the
  database. Events still queued when the process exits are lost from the copy;
  on `SIGTERM`/`SIGINT` the server spends up to 5 s sending what remains.
- **At-least-once.** A send that timed out after the broker wrote it is
  retried, so a consumer can see an event twice. Each message carries an
  `event_id` to de-duplicate on.
- **Message shape.** Key: `user_id` (one user's events stay ordered within a
  partition). Value: the event as JSON, the same as the `stdout` line (including
  `user_email` and, with `AUDIT_PAYLOAD`, the captured arguments and result), plus
  `event_id`. The topic is not auto-created; create it first.
- **Metrics:** `workbench_audit_kafka_sent_total`,
  `workbench_audit_kafka_dropped_total`, `workbench_audit_kafka_send_errors_total`
  and the `workbench_audit_kafka_queue_depth` gauge. Alert on dropped > 0.

For shipping to a log aggregator, `stdout` is the destination to use. Note that
Fastify's own request log redacts `Authorization`, `x-workbench-api-key`,
`?token=`, and `?cdpToken=`, but deliberately does not redact `req.url`.
