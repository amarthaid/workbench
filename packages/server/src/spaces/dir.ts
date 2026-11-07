import path from "node:path";
import { config } from "../config";

// Where Space files live on disk. Mirrors jots/dir.ts: a sibling of the SQLite
// DB unless SPACES_DIR overrides it. Resolved (absolute) so the serve
// traversal guard can compare prefixes reliably.
export function spacesRoot(): string {
  const base = config.SPACES_DIR || path.join(path.dirname(config.DATABASE_URL), "spaces");
  return path.resolve(base);
}
