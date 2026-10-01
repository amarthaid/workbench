import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBrowserProfiles } from "../src/admin/profiles";

const bases: string[] = [];

function makeBase(): string {
  const d = mkdtempSync(join(tmpdir(), "profiles-"));
  bases.push(d);
  return d;
}

// A profile whose Cookies use-marker has `bytes` bytes and was last written
// `ageMs` ago.
function makeProfile(base: string, name: string, bytes: number, ageMs: number) {
  const marker = join(base, name, "Default", "Cookies");
  mkdirSync(join(base, name, "Default"), { recursive: true });
  writeFileSync(marker, Buffer.alloc(bytes));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(marker, t, t);
}

afterEach(() => {
  for (const d of bases.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noEmails = new Map<string, string | null>();

describe("listBrowserProfiles", () => {
  it("sorts by size, largest first, and reports each profile's size", async () => {
    const base = makeBase();
    makeProfile(base, "small", 100, 0);
    makeProfile(base, "big", 300, 0);
    const out = await listBrowserProfiles({ baseDir: base, activeDirs: [], emailByDirName: noEmails });
    expect(out.map((p) => [p.name, p.bytes])).toEqual([
      ["big", 300],
      ["small", 100],
    ]);
  });

  it("marks a profile live when its use-marker moved recently, idle otherwise", async () => {
    const base = makeBase();
    makeProfile(base, "fresh", 10, 1000);
    makeProfile(base, "stale", 10, 2 * 86_400_000);
    const out = await listBrowserProfiles({ baseDir: base, activeDirs: [], emailByDirName: noEmails });
    const byName = Object.fromEntries(out.map((p) => [p.name, p]));
    expect(byName.fresh.live).toBe(true);
    expect(byName.stale.live).toBe(false);
    expect(byName.stale.last_used).toBeLessThan(Math.floor(Date.now() / 1000) - 86_400);
  });

  it("marks a profile live when this process holds it, whatever its marker age", async () => {
    const base = makeBase();
    makeProfile(base, "held", 10, 2 * 86_400_000);
    const out = await listBrowserProfiles({
      baseDir: base,
      activeDirs: [join(base, "held")],
      emailByDirName: noEmails,
    });
    expect(out[0].live).toBe(true);
  });

  it("maps a dir name to the user's email, and leaves unknown dirs null", async () => {
    const base = makeBase();
    makeProfile(base, "user-dev", 10, 0);
    makeProfile(base, "orphan", 5, 0);
    const out = await listBrowserProfiles({
      baseDir: base,
      activeDirs: [],
      emailByDirName: new Map([["user-dev", "dev@example.com"]]),
    });
    const byName = Object.fromEntries(out.map((p) => [p.name, p]));
    expect(byName["user-dev"].email).toBe("dev@example.com");
    expect(byName.orphan.email).toBeNull();
  });

  it("copes with a missing base dir", async () => {
    const out = await listBrowserProfiles({
      baseDir: join(makeBase(), "does-not-exist"),
      activeDirs: [],
      emailByDirName: noEmails,
    });
    expect(out).toEqual([]);
  });

  it("copes with a profile that has no use-marker files, using the directory's own time", async () => {
    const base = makeBase();
    mkdirSync(join(base, "bare"));
    const old = (Date.now() - 2 * 86_400_000) / 1000;
    utimesSync(join(base, "bare"), old, old);
    const out = await listBrowserProfiles({ baseDir: base, activeDirs: [], emailByDirName: noEmails });
    expect(out).toHaveLength(1);
    expect(out[0].bytes).toBe(0);
    expect(out[0].live).toBe(false);
    expect(out[0].last_used).toBeLessThan(Math.floor(Date.now() / 1000) - 86_400);
  });

  it("treats a just-created profile with no markers as live, like the reaper does", async () => {
    // A chromium that has started but not yet written its markers must not look idle.
    const base = makeBase();
    mkdirSync(join(base, "starting"));
    const out = await listBrowserProfiles({ baseDir: base, activeDirs: [], emailByDirName: noEmails });
    expect(out[0].live).toBe(true);
  });
});
