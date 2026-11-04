import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DbDestination,
  SqliteDestination,
  StdoutDestination,
  FanOutDestination,
  createDestination,
  parseAuditDest,
} from "../src/audit/destinations";
import { KafkaCopy, kafkaSettingsFromConfig, type KafkaMessage, type KafkaSender } from "../src/audit/kafka";
import { auditStored } from "../src/audit/query";
import { config } from "../src/config";
import { db } from "../src/db";
import type { AuditEvent } from "@a-workbench/shared";

const ev = (user_id = "alice", extra: Partial<AuditEvent> = {}): AuditEvent => ({
  user_id,
  action: "EXECUTE",
  success: true,
  timestamp: "2024-01-01T00:00:00Z",
  ...extra,
});

beforeEach(async () => {
  await db.exec("DELETE FROM audit_log");
  vi.restoreAllMocks();
});

describe("audit destinations", () => {
  it("db destination writes to the configured database", async () => {
    await new DbDestination().log(ev());
    const count = await db.get<{ c: number }>("SELECT COUNT(*) as c FROM audit_log");
    expect(Number(count?.c)).toBe(1);
  });

  it("SqliteDestination is the old name of the db destination", () => {
    expect(SqliteDestination).toBe(DbDestination);
  });

  it("stdout destination prints json", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => void logs.push(msg));
    new StdoutDestination().log(ev());
    expect(JSON.parse(logs[0]).user_id).toBe("alice");
  });

  it("fan-out writes every destination and still surfaces a database error", async () => {
    const seen: string[] = [];
    const sync = { log: (e: AuditEvent) => void seen.push(`sync:${e.user_id}`) };
    const failing = { log: async () => { throw new Error("db down"); } };
    await expect(new FanOutDestination([sync, failing]).log(ev())).rejects.toThrow("db down");
    expect(seen).toEqual(["sync:alice"]);
  });
});

describe("AUDIT_LOG_DEST parsing", () => {
  it.each([
    [undefined, ["db"]],
    ["", ["db"]],
    ["sqlite", ["db"]],
    ["db", ["db"]],
    ["stdout", ["stdout"]],
    ["kafka", ["db", "kafka"]], // kafka is only ever a copy
    ["stdout,kafka", ["db", "stdout", "kafka"]],
    [" kafka , sqlite ", ["db", "kafka"]],
    ["db,stdout", ["db", "stdout"]],
  ])("%j → %j", (raw, want) => {
    expect(parseAuditDest(raw as string | undefined)).toEqual(want);
  });

  it("config rejects an unknown destination", async () => {
    const { configSchema } = await import("../src/config");
    expect(configSchema.safeParse({ AUDIT_LOG_DEST: "db,s3" }).success).toBe(false);
    expect(configSchema.safeParse({ AUDIT_LOG_DEST: "db,kafka" }).success).toBe(true);
  });

  describe("with the live config", () => {
    const original = config.AUDIT_LOG_DEST;
    const brokers = config.AUDIT_LOG_KAFKA_BROKERS;
    afterEach(() => {
      config.AUDIT_LOG_DEST = original;
      config.AUDIT_LOG_KAFKA_BROKERS = brokers;
    });

    it("defaults to the database", () => {
      expect(createDestination()).toBeInstanceOf(DbDestination);
      expect(auditStored()).toBe(true);
    });

    it("stdout alone is not stored", () => {
      config.AUDIT_LOG_DEST = "stdout";
      expect(createDestination()).toBeInstanceOf(StdoutDestination);
      expect(auditStored()).toBe(false);
    });

    it("kafka keeps the database: stored, and fans out", () => {
      config.AUDIT_LOG_DEST = "kafka";
      config.AUDIT_LOG_KAFKA_BROKERS = "broker-1.example.com:9092";
      expect(createDestination()).toBeInstanceOf(FanOutDestination);
      expect(auditStored()).toBe(true);
    });

    it("kafka without brokers fails at startup with a clear message", () => {
      config.AUDIT_LOG_DEST = "kafka";
      config.AUDIT_LOG_KAFKA_BROKERS = undefined;
      expect(() => createDestination()).toThrow(/AUDIT_LOG_KAFKA_BROKERS/);
    });
  });
});

describe("kafkaSettingsFromConfig", () => {
  const base = { ...config, AUDIT_LOG_KAFKA_BROKERS: " a.example.com:9092, b.example.com:9093 ," };
  it("splits brokers and passes SASL through", () => {
    const s = kafkaSettingsFromConfig({
      ...base,
      AUDIT_LOG_KAFKA_SSL: true,
      AUDIT_LOG_KAFKA_SASL_MECHANISM: "scram-sha-512",
      AUDIT_LOG_KAFKA_SASL_USERNAME: "svc",
      AUDIT_LOG_KAFKA_SASL_PASSWORD: "pw-fake",
    } as typeof config);
    expect(s.brokers).toEqual(["a.example.com:9092", "b.example.com:9093"]);
    expect(s.ssl).toBe(true);
    expect(s.sasl).toEqual({ mechanism: "scram-sha-512", username: "svc", password: "pw-fake" });
  });
  it("a SASL mechanism without credentials is refused", () => {
    expect(() =>
      kafkaSettingsFromConfig({ ...base, AUDIT_LOG_KAFKA_SASL_MECHANISM: "plain" } as typeof config)
    ).toThrow(/SASL_USERNAME/);
  });
});

/** A sender the test controls: each send waits for the test to resolve or reject it. */
function fakeSender() {
  const calls: Array<{ topic: string; messages: KafkaMessage[]; resolve: () => void; reject: (e: Error) => void }> = [];
  let disconnected = false;
  const sender: KafkaSender = {
    send: (topic, messages) =>
      new Promise<void>((resolve, reject) => calls.push({ topic, messages: [...messages], resolve, reject })),
    disconnect: async () => {
      disconnected = true;
    },
  };
  return { sender, calls, isDisconnected: () => disconnected };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("KafkaCopy", () => {
  const noSleep = () => Promise.resolve();

  it("log() returns at once and never waits on the broker", () => {
    const f = fakeSender();
    const copy = new KafkaCopy({ topic: "audit-log", queueMax: 10, sender: f.sender, sleep: noSleep });
    expect(copy.log(ev())).toBeUndefined();
    expect(copy.pending).toBe(1);
  });

  it("sends events in order, keyed by user, with a unique event_id", async () => {
    const f = fakeSender();
    const copy = new KafkaCopy({ topic: "audit-log", queueMax: 10, sender: f.sender, sleep: noSleep });
    copy.log(ev("alice"));
    await tick();
    copy.log(ev("bob"));
    copy.log(ev("carol"));
    f.calls[0].resolve();
    await tick();
    expect(f.calls[1].messages.map((m) => m.key)).toEqual(["bob", "carol"]);
    f.calls[1].resolve();
    await tick();
    expect(copy.pending).toBe(0);
    expect(f.calls[0].topic).toBe("audit-log");
    const ids = [...f.calls[0].messages, ...f.calls[1].messages].map((m) => JSON.parse(m.value).event_id);
    expect(new Set(ids).size).toBe(3);
    expect(JSON.parse(f.calls[0].messages[0].value)).toMatchObject({ user_id: "alice", action: "EXECUTE" });
  });

  it("a failed batch is retried whole, before anything newer", async () => {
    const f = fakeSender();
    const sleeps: number[] = [];
    const copy = new KafkaCopy({
      topic: "t",
      queueMax: 10,
      sender: f.sender,
      sleep: async (ms) => void sleeps.push(ms),
      warn: () => {},
    });
    copy.log(ev("alice"));
    await tick();
    copy.log(ev("bob"));
    f.calls[0].reject(new Error("broker down"));
    await tick();
    expect(f.calls[1].messages.map((m) => m.key)).toEqual(["alice", "bob"]);
    f.calls[1].reject(new Error("still down"));
    await tick();
    expect(sleeps).toEqual([500, 1000]); // exponential backoff
    f.calls[2].resolve();
    await tick();
    expect(copy.pending).toBe(0);
  });

  it("drops new events past queueMax and warns at most once a minute", async () => {
    const f = fakeSender();
    const warnings: string[] = [];
    const copy = new KafkaCopy({ topic: "t", queueMax: 2, sender: f.sender, sleep: noSleep, warn: (m) => void warnings.push(m) });
    for (const u of ["a", "b", "c", "d", "e"]) copy.log(ev(u));
    expect(copy.pending).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/queue full/);
    // The first send started with "a" alone; "b" waits its turn; c, d, e were dropped.
    expect(f.calls[0].messages.map((m) => m.key)).toEqual(["a"]);
    f.calls[0].resolve();
    await tick();
    expect(f.calls[1].messages.map((m) => m.key)).toEqual(["b"]);
  });

  it("flush sends what is queued, then disconnects and ignores later events", async () => {
    const f = fakeSender();
    const copy = new KafkaCopy({ topic: "t", queueMax: 10, sender: f.sender, sleep: noSleep });
    copy.log(ev());
    const flushed = copy.flush(1000);
    await tick();
    f.calls[0].resolve();
    expect(await flushed).toBe(0);
    expect(f.isDisconnected()).toBe(true);
    copy.log(ev());
    expect(copy.pending).toBe(0);
  });

  it("flush gives up at its deadline when the broker never answers", async () => {
    const f = fakeSender();
    const warnings: string[] = [];
    const copy = new KafkaCopy({ topic: "t", queueMax: 10, sender: f.sender, sleep: noSleep, warn: (m) => void warnings.push(m) });
    copy.log(ev());
    expect(await copy.flush(20)).toBe(1);
    expect(warnings.join()).toMatch(/not sent to Kafka before shutdown/);
  });
});
