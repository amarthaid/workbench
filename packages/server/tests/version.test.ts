import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readVersion } from "../src/version";

const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "version-"));
  dirs.push(d);
  return d;
}

function write(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readVersion", () => {
  it("dev layout: takes the repo-root version, not packages/server's own", () => {
    const d = scratch();
    write(join(d, "package.json"), JSON.stringify({ version: "1.2.3" }));
    write(join(d, "packages/server/package.json"), JSON.stringify({ version: "0.0.1" }));
    expect(readVersion(join(d, "packages/server/src"))).toBe("1.2.3");
  });

  it("image layout: finds package.json beside the flattened server dir", () => {
    const d = scratch();
    write(join(d, "x/app/package.json"), JSON.stringify({ version: "2.0.0" }));
    expect(readVersion(join(d, "x/app/server"))).toBe("2.0.0");
  });

  it("falls through a candidate that has no version", () => {
    const d = scratch();
    write(join(d, "package.json"), JSON.stringify({ name: "no-version" }));
    write(join(d, "x/app/package.json"), JSON.stringify({ version: "3.1.4" }));
    expect(readVersion(join(d, "x/app/server"))).toBe("3.1.4");
  });

  it("falls through a candidate that is not valid JSON", () => {
    const d = scratch();
    write(join(d, "package.json"), "not json");
    write(join(d, "x/app/package.json"), JSON.stringify({ version: "3.1.5" }));
    expect(readVersion(join(d, "x/app/server"))).toBe("3.1.5");
  });

  it('returns "0.0.0" when no candidate exists', () => {
    const d = scratch();
    mkdirSync(join(d, "a/b/c"), { recursive: true });
    expect(readVersion(join(d, "a/b/c"))).toBe("0.0.0");
  });

  it("reads the real repo root by default", () => {
    const rootPkg = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const expected = (JSON.parse(readFileSync(rootPkg, "utf8")) as { version: string }).version;
    expect(readVersion()).toBe(expected);
  });
});
