import path from "node:path";
import { config } from "../config";

// Where the agent file workspace lives on disk. Mirrors jots/dir.ts so tests
// can redirect the root with a single vi.mock.
//
// Unlike the jots and browser-profile roots this has no sibling-of-the-database
// default beyond the config knob: it is meant to be its own mount. RWX on a
// shared PVC solves visibility between pods, not capacity, and a growing
// per-user tree sharing a volume with tokens.db is
// docs/findings/2026-08-06-browser-profile-disk-growth.md all over again.
export function workspaceRoot(): string {
  return path.resolve(config.WORKSPACE_DIR);
}
