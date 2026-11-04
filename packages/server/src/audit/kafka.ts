// Kafka copy of the audit log.
//
// The database stays the record (the admin Activity and Overview tabs read
// it); Kafka gets a copy. A tool call must never wait on, or fail because of,
// the broker, so `log()` only appends to an in-memory queue and returns. One
// background loop drains it in batches, in order, retrying with backoff while
// the broker is down. The queue is bounded: past AUDIT_LOG_KAFKA_QUEUE_MAX the
// newest events are dropped from the copy and counted. Events still queued
// when the process dies are lost from the copy (never from the database);
// `flush()` on shutdown sends what it can within its deadline.
//
// Delivery is at-least-once: a send that times out after the broker wrote it
// is retried, so a consumer can see an event twice. Each message carries an
// `event_id` (per-process random prefix + sequence) to de-duplicate on.

import { randomBytes } from "node:crypto";
import { Kafka, logLevel, type Producer, type SASLOptions } from "kafkajs";
import type { AuditEvent } from "@a-workbench/shared";
import { config } from "../config";
import { auditKafkaDropped, auditKafkaErrors, auditKafkaQueueDepth, auditKafkaSent } from "../telemetry/metrics";
import type { AuditDestination } from "./destinations";

const BATCH_MAX = 500;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const WARN_EVERY_MS = 60_000;

export interface KafkaMessage {
  key: string;
  value: string;
}

/** What the queue needs from a producer; the real one wraps kafkajs. */
export interface KafkaSender {
  send(topic: string, messages: KafkaMessage[]): Promise<void>;
  disconnect(): Promise<void>;
}

export interface KafkaCopyOptions {
  topic: string;
  queueMax: number;
  sender: KafkaSender;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  warn?: (msg: string) => void;
}

export interface KafkaSettings {
  brokers: string[];
  topic: string;
  clientId: string;
  ssl: boolean;
  sasl?: SASLOptions;
  queueMax: number;
}

/** Read and check the AUDIT_LOG_KAFKA_* settings. Throws a message naming what is wrong. */
export function kafkaSettingsFromConfig(c: typeof config = config): KafkaSettings {
  const brokers = (c.AUDIT_LOG_KAFKA_BROKERS ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  if (!brokers.length) throw new Error("AUDIT_LOG_DEST lists kafka but AUDIT_LOG_KAFKA_BROKERS is empty");
  let sasl: SASLOptions | undefined;
  if (c.AUDIT_LOG_KAFKA_SASL_MECHANISM) {
    const username = c.AUDIT_LOG_KAFKA_SASL_USERNAME;
    const password = c.AUDIT_LOG_KAFKA_SASL_PASSWORD;
    if (!username || !password) {
      throw new Error("AUDIT_LOG_KAFKA_SASL_MECHANISM is set but AUDIT_LOG_KAFKA_SASL_USERNAME or _PASSWORD is empty");
    }
    sasl = { mechanism: c.AUDIT_LOG_KAFKA_SASL_MECHANISM, username, password } as SASLOptions;
  }
  return {
    brokers,
    topic: c.AUDIT_LOG_KAFKA_TOPIC,
    clientId: c.AUDIT_LOG_KAFKA_CLIENT_ID,
    ssl: c.AUDIT_LOG_KAFKA_SSL,
    sasl,
    queueMax: c.AUDIT_LOG_KAFKA_QUEUE_MAX,
  };
}

/** A kafkajs producer, connected on first use. */
export function createKafkajsSender(s: KafkaSettings): KafkaSender {
  const kafka = new Kafka({
    clientId: s.clientId,
    brokers: s.brokers,
    ssl: s.ssl,
    sasl: s.sasl,
    // Its own retries stay short: the queue's loop is the long-running retry.
    retry: { retries: 2 },
    logLevel: logLevel.WARN,
  });
  let producer: Producer | null = null;
  let connecting: Promise<Producer> | null = null;
  const connect = (): Promise<Producer> => {
    if (producer) return Promise.resolve(producer);
    if (!connecting) {
      const p = kafka.producer({ allowAutoTopicCreation: false });
      connecting = p.connect().then(
        () => {
          producer = p;
          connecting = null;
          // A dropped connection reconnects on the next send.
          p.on(p.events.DISCONNECT, () => {
            if (producer === p) producer = null;
          });
          return p;
        },
        (e) => {
          connecting = null;
          throw e;
        }
      );
    }
    return connecting;
  };
  return {
    async send(topic, messages) {
      const p = await connect();
      await p.send({ topic, messages, acks: -1 });
    },
    async disconnect() {
      const p = producer;
      producer = null;
      await p?.disconnect();
    },
  };
}

export class KafkaCopy implements AuditDestination {
  private readonly queue: KafkaMessage[] = [];
  private readonly idPrefix = randomBytes(6).toString("hex");
  private seq = 0;
  private draining: Promise<void> | null = null;
  private stopped = false;
  private lastWarn = 0;
  private droppedSinceWarn = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly warnFn: (msg: string) => void;

  constructor(private readonly opts: KafkaCopyOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
    this.warnFn = opts.warn ?? ((m) => console.warn(`[audit:kafka] ${m}`));
  }

  /** Queue the event and return at once; never throws. */
  log(event: AuditEvent): void {
    if (this.stopped) return;
    if (this.queue.length >= this.opts.queueMax) {
      auditKafkaDropped.inc();
      this.droppedSinceWarn += 1;
      this.warn(`queue full (${this.opts.queueMax}); dropping events from the Kafka copy`);
      return;
    }
    this.seq += 1;
    const value = JSON.stringify({ ...event, event_id: `${this.idPrefix}-${this.seq}` });
    this.queue.push({ key: event.user_id, value });
    auditKafkaQueueDepth.set(this.queue.length);
    this.kick();
  }

  /** Events waiting to be sent (tests, diagnostics). */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Send what is queued, giving up at the deadline, then disconnect. Later
   * `log()` calls are ignored. Returns the number of events left unsent.
   */
  async flush(timeoutMs: number): Promise<number> {
    const deadline = new Promise<void>((r) => setTimeout(r, timeoutMs).unref());
    this.kick();
    await Promise.race([this.waitEmpty(), deadline]);
    this.stopped = true;
    const left = this.queue.length;
    if (left) this.warnFn(`${left} event(s) not sent to Kafka before shutdown`);
    await Promise.race([this.opts.sender.disconnect().catch(() => undefined), deadline]);
    return left;
  }

  private async waitEmpty(): Promise<void> {
    while (this.queue.length && !this.stopped) await (this.draining ?? this.sleep(10));
  }

  private kick(): void {
    if (!this.draining && !this.stopped) this.draining = this.drain().finally(() => (this.draining = null));
  }

  private async drain(): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    while (this.queue.length && !this.stopped) {
      const batch = this.queue.slice(0, BATCH_MAX);
      try {
        await this.opts.sender.send(this.opts.topic, batch);
        // Only now remove them: a failed batch is retried whole, in order.
        this.queue.splice(0, batch.length);
        auditKafkaSent.inc(batch.length);
        auditKafkaQueueDepth.set(this.queue.length);
        backoff = BACKOFF_MIN_MS;
      } catch (e) {
        auditKafkaErrors.inc();
        this.warn(`send failed, retrying (${this.queue.length} queued): ${(e as Error)?.message ?? e}`);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  // At most one line a minute, so a broker outage does not flood the log.
  private warn(msg: string): void {
    const now = Date.now();
    if (now - this.lastWarn < WARN_EVERY_MS) return;
    this.lastWarn = now;
    const dropped = this.droppedSinceWarn;
    this.droppedSinceWarn = 0;
    this.warnFn(dropped > 1 ? `${msg} (${dropped} dropped since last warning)` : msg);
  }
}
