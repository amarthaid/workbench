import { describe, it, expect } from "vitest";
import path from "node:path";
import { config } from "../src/config";

describe("test database isolation", () => {
  it("never points the suite at a database inside the repository", () => {
    // DB suites start with `DELETE FROM users`. The server's default
    // DATABASE_URL is ./data/tokens.db relative to the cwd, and the docker
    // compose file bind-mounts the repo's data/ as the live database — one
    // vitest run from the repo root emptied the real users table (2026-09-16).
    // The suite has to run on its own throwaway file, wherever it is started.
    const repoRoot = path.resolve(__dirname, "../../..");
    const url = config.DATABASE_URL;
    expect(url.startsWith("postgres")).toBe(false);
    expect(path.isAbsolute(url)).toBe(true);
    expect(path.resolve(url).startsWith(repoRoot + path.sep)).toBe(false);
  });
});
