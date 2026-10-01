import { readFileSync } from "node:fs";
import { join } from "node:path";

// Where the repo-root package.json sits relative to this file depends on the
// layout. From src/ or dist/ in a checkout it is three levels up. The Docker
// image ships the compiled server flattened at /app/server with package.json
// beside it at /app, one level up. Order matters: from src/, "../package.json"
// is packages/server's own (stale) version, so the root candidate must win there.
const CANDIDATES = ["../../../package.json", "../package.json"];

export function readVersion(baseDir: string = __dirname, candidates: string[] = CANDIDATES): string {
  for (const rel of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(baseDir, rel), "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      /* try the next layout */
    }
  }
  return "0.0.0";
}
