import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

// The suite's database and workspace live in the OS temp dir, never at the
// server's cwd-relative defaults. DB suites start with `DELETE FROM users`,
// and the repo's data/ is what docker compose bind-mounts as the live
// database — one run from the wrong cwd emptied the real users table.
const scratch = path.join(os.tmpdir(), `workbench-vitest-${process.pid}`);

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: path.join(scratch, "tokens.db"),
      WORKSPACE_DIR: path.join(scratch, "workspace"),
    },
    // All test files share one real SQLite file (config.DATABASE_URL). Running
    // files in parallel lets one file's `DELETE FROM users` race another file's
    // rows mid-test. Serialize files to keep DB-touching suites deterministic.
    fileParallelism: false,
    // From vitest 4, vi.spyOn returns the already-installed spy rather than a
    // fresh one, so call history survives across tests in a describe block.
    // Assertions that read mock.calls[0] meaning "this test's call" then read
    // an earlier test's — which fails only when the runner is slow enough for
    // the values to differ, i.e. in CI and not locally.
    clearMocks: true,
    // Schema creation moved from a `src/db` import side effect into initDb();
    // without this, a fresh checkout has no tables and every DB suite fails.
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      exclude: [
        "src/index.ts",
        "src/gap/**",
        "src/telemetry/**",
        "src/audit/logger.ts",
        "**/*.d.ts",
        "**/*.test.ts",
        "tests/**",
      ],
    },
  },
});
