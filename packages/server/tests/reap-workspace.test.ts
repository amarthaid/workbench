import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reapWorkspace } from "../src/reap/workspace";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "reap-ws-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function put(user: string, name: string, bytes: number, ageMs = 0): string {
  const dir = join(base, user);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "x".repeat(bytes));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
  }
  return p;
}

const HOUR = 3_600_000;

describe("reapWorkspace", () => {
  it("deletes what is past the TTL and keeps what is not", async () => {
    const old = put("u1", "old.csv", 10, 25 * HOUR);
    const fresh = put("u1", "fresh.csv", 10, 1 * HOUR);

    const r = await reapWorkspace({ dir: base, ttlHours: 24 });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(r.expired).toBe(1);
    expect(r.freedBytes).toBe(10);
  });

  it("deletes regardless of anything being 'in use' — age is the only rule", async () => {
    // No liveness concept at all: this is what lets the sweep run out of
    // process with no coordination.
    const p = put("u1", "busy.csv", 10, 48 * HOUR);
    await reapWorkspace({ dir: base, ttlHours: 24 });
    expect(existsSync(p)).toBe(false);
  });

  it("does not spare a partial upload, only a recent one", async () => {
    // An in-flight .crdownload has an mtime of now, so age alone protects it.
    const inflight = put("u1", "big.csv.crdownload", 10, 0);
    const abandoned = put("u1", "stale.csv.part-abcd", 10, 48 * HOUR);

    await reapWorkspace({ dir: base, ttlHours: 24 });

    expect(existsSync(inflight)).toBe(true);
    expect(existsSync(abandoned)).toBe(false);
  });

  it("evicts oldest first when a user is over quota", async () => {
    const oldest = put("u1", "a.csv", 100, 3 * HOUR);
    const middle = put("u1", "b.csv", 100, 2 * HOUR);
    const newest = put("u1", "c.csv", 100, 1 * HOUR);

    const r = await reapWorkspace({ dir: base, ttlHours: 24, maxBytesPerUser: 150 });

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(r.evicted).toBe(2);
  });

  it("only evicts the user who is over quota", async () => {
    put("u1", "a.csv", 300, 1 * HOUR);
    const other = put("u2", "b.csv", 10, 1 * HOUR);

    const r = await reapWorkspace({ dir: base, ttlHours: 24, maxBytesPerUser: 150 });

    expect(existsSync(other)).toBe(true);
    expect(r.users).toBe(2);
    expect(r.evicted).toBe(1);
  });

  it("reports but deletes nothing under --dry-run", async () => {
    const p = put("u1", "old.csv", 10, 48 * HOUR);
    const r = await reapWorkspace({ dir: base, ttlHours: 24, dryRun: true });
    expect(existsSync(p)).toBe(true);
    expect(r.expired).toBe(1);
    expect(r.deleted).toEqual([p]);
  });

  it("returns an empty result for a directory that is not there", async () => {
    const r = await reapWorkspace({ dir: join(base, "nope"), ttlHours: 24 });
    expect(r).toMatchObject({ expired: 0, evicted: 0, users: 0 });
  });

  it("leaves an empty user directory rather than removing the user", async () => {
    put("u1", "old.csv", 10, 48 * HOUR);
    await reapWorkspace({ dir: base, ttlHours: 24 });
    expect(readdirSync(base)).toEqual(["u1"]);
  });
});
