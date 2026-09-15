import { describe, it, expect } from "vitest";
import path from "node:path";
import { jotsRoot } from "../../src/jots/dir";
import { config } from "../../src/config";

describe("jotsRoot", () => {
  it("defaults to a 'jots' dir next to the database", () => {
    // Wherever the suite's DATABASE_URL points (a temp dir, see
    // vitest.config.ts), jots sit beside it.
    expect(jotsRoot()).toBe(path.resolve(path.dirname(config.DATABASE_URL), "jots"));
  });
});
