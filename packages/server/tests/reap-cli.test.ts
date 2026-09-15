import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, runReap } from "../src/reap/cli";

let ws: string;
let profiles: string;

const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "reap-cli-ws-"));
  profiles = mkdtempSync(join(tmpdir(), "reap-cli-prof-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(profiles, { recursive: true, force: true });
});

function putFile(user: string, name: string, ageMs: number): string {
  const dir = join(ws, user);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "xxxxx");
  const t = new Date(Date.now() - ageMs);
  utimesSync(p, t, t);
  return p;
}

function putProfile(name: string, ageMs: number): string {
  const dir = join(profiles, name);
  mkdirSync(join(dir, "Default"), { recursive: true });
  mkdirSync(join(dir, "Default", "Cache"), { recursive: true });
  writeFileSync(join(dir, "Default", "Cache", "data_1"), "x".repeat(2048));
  writeFileSync(join(dir, "Default", "Cookies"), "state");
  const t = new Date(Date.now() - ageMs);
  utimesSync(join(dir, "Default", "Cookies"), t, t);
  return dir;
}

describe("reap CLI", () => {
  it("sweeps both trees when neither --files nor --profiles is given", () => {
    const flags = parseArgs([]);
    expect(flags.files).toBe(true);
    expect(flags.profiles).toBe(true);
  });

  it("--files leaves the profiles tree untouched", async () => {
    const file = putFile("u1", "old.csv", 48 * HOUR);
    const profile = putProfile("p1", 400 * DAY);

    await runReap(parseArgs(["--files", "--dir", ws, "--ttl-hours", "24"]));

    expect(existsSync(file)).toBe(false);
    expect(existsSync(profile)).toBe(true);
  });

  it("--profiles leaves the workspace untouched", async () => {
    const file = putFile("u1", "old.csv", 48 * HOUR);
    const profile = putProfile("p1", 400 * DAY);

    await runReap(parseArgs(["--profiles", "--profiles-dir", profiles, "--ttl-days", "30"]));

    expect(existsSync(file)).toBe(true);
    expect(existsSync(profile)).toBe(false);
  });

  it("treats a profile touched inside the live window as live", async () => {
    // Out of process there is no activeProfiles set; a use-marker that moved
    // recently is the substitute.
    const busy = putProfile("busy", 2 * 60_000);
    const summary = await runReap(
      parseArgs(["--profiles", "--profiles-dir", profiles, "--ttl-days", "30"])
    );
    expect(summary.profiles!.skippedActive).toBe(1);
    expect(existsSync(join(busy, "Default", "Cache"))).toBe(true);
  });

  it("trims a profile whose marker is older than the live window", async () => {
    const idle = putProfile("idle", 3 * DAY);
    await runReap(parseArgs(["--profiles", "--profiles-dir", profiles, "--ttl-days", "30"]));
    expect(existsSync(join(idle, "Default", "Cache"))).toBe(false);
    expect(existsSync(join(idle, "Default", "Cookies"))).toBe(true);
  });

  it("deletes nothing under --dry-run", async () => {
    const file = putFile("u1", "old.csv", 48 * HOUR);
    await runReap(parseArgs(["--files", "--dir", ws, "--ttl-hours", "24", "--dry-run"]));
    expect(existsSync(file)).toBe(true);
  });

  it("rejects an unknown option", () => {
    expect(() => parseArgs(["--wat"])).toThrow(/unknown option/);
  });

  it("reads defaults from the environment", () => {
    vi.stubEnv("WORKSPACE_DIR", "/from/env");
    vi.stubEnv("WORKSPACE_TTL_HOURS", "9");
    try {
      const flags = parseArgs([]);
      expect(flags.dir).toBe("/from/env");
      expect(flags.ttlHours).toBe(9);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs with NO environment at all — no ENCRYPTION_KEY, no database", () => {
    putFile("u1", "old.csv", 48 * HOUR);
    const cli = resolve(__dirname, "../src/reap/cli.ts");
    // A bare env proves nothing in this import graph reaches config.ts, whose
    // schema demands ENCRYPTION_KEY and SESSION_SECRET. If it ever does, a
    // directory-sweeping CronJob starts needing the encryption key.
    const out = execFileSync(
      process.execPath,
      [resolve(__dirname, "../../../node_modules/.bin/tsx"), cli, "--files", "--dir", ws, "--json"],
      { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" }
    );
    const summary = JSON.parse(out);
    expect(summary.workspace.expired).toBe(1);
  });
});
