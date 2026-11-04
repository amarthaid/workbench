import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestsTotal = new Counter({
  name: "workbench_http_requests_total",
  help: "Total HTTP requests handled",
  labelNames: ["method", "route", "status"] as const,
  registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
  name: "workbench_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const toolExecutionsTotal = new Counter({
  name: "workbench_tool_executions_total",
  help: "Total tool executions via execute_tool / execute_tools",
  labelNames: ["integration", "tool", "success"] as const,
  registers: [metricsRegistry],
});

export const toolExecutionDuration = new Histogram({
  name: "workbench_tool_execution_duration_seconds",
  help: "Tool execution duration in seconds",
  labelNames: ["integration", "tool", "success"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

// Kafka copy of the audit log (src/audit/kafka.ts). Zero unless AUDIT_LOG_DEST lists kafka.
export const auditKafkaSent = new Counter({
  name: "workbench_audit_kafka_sent_total",
  help: "Audit events delivered to Kafka",
  registers: [metricsRegistry],
});

export const auditKafkaDropped = new Counter({
  name: "workbench_audit_kafka_dropped_total",
  help: "Audit events dropped from the Kafka copy because the queue was full (still in the database)",
  registers: [metricsRegistry],
});

export const auditKafkaErrors = new Counter({
  name: "workbench_audit_kafka_send_errors_total",
  help: "Failed Kafka batch sends (each is retried)",
  registers: [metricsRegistry],
});

export const auditKafkaQueueDepth = new Gauge({
  name: "workbench_audit_kafka_queue_depth",
  help: "Audit events waiting to be sent to Kafka",
  registers: [metricsRegistry],
});
