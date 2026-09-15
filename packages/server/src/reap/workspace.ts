import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

// Agent-file-workspace sweep. Like ./profiles.ts this is a LEAF module: node
// builtins only, no config, no database.

export interface WorkspaceReapResult {
  /** Files deleted for age. */
  expired: number;
  /** Files evicted because their owner was over quota. */
  evicted: number;
  freedBytes: number;
  users: number;
  deleted: string[];
}

export interface WorkspaceReapOptions {
  dir: string;
  ttlHours: number;
  maxBytesPerUser?: number;
  now?: number;
  dryRun?: boolean;
}

interface Candidate {
  path: string;
  bytes: number;
  mtimeMs: number;
}

async function listUserFiles(userDir: string): Promise<Candidate[]> {
  let entries;
  try {
    entries = await readdir(userDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = join(userDir, e.name);
    try {
      const st = await stat(p);
      out.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* raced with a writer */
    }
  }
  return out;
}

/**
 * Sweep the workspace.
 *
 * Retention is AGE ONLY: a file older than `ttlHours` goes, whether or not
 * anything is using it. That is the whole reason this can run out of process
 * with no coordination, no liveness set and no secrets — and it dissolves two
 * races rather than handling them:
 *
 *  - A `.crdownload` chromium is still writing has an mtime of *now*, so its
 *    age is ~0 and it is never a candidate. No suffix skip is needed, and
 *    partial files are swept like anything else once they are genuinely stale,
 *    which is what stops an abandoned upload leaking disk forever.
 *  - A file unlinked while it is being streamed to a consumer is fine: POSIX
 *    keeps the open fd valid until the reader closes it. This is safe by
 *    accident rather than by design, so do NOT "fix" it into a
 *    copy-then-delete — that would reintroduce the disk cost this avoids.
 *
 * Quota eviction runs after the age pass, oldest first, and only for a user
 * still over the limit.
 */
export async function reapWorkspace(opts: WorkspaceReapOptions): Promise<WorkspaceReapResult> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlHours * 3_600_000;
  const result: WorkspaceReapResult = {
    expired: 0,
    evicted: 0,
    freedBytes: 0,
    users: 0,
    deleted: [],
  };

  let userDirs: string[];
  try {
    const entries = await readdir(opts.dir, { withFileTypes: true });
    userDirs = entries.filter((e) => e.isDirectory()).map((e) => join(opts.dir, e.name));
  } catch {
    return result;
  }

  const drop = async (c: Candidate): Promise<void> => {
    if (!opts.dryRun) await rm(c.path, { force: true });
    result.freedBytes += c.bytes;
    result.deleted.push(c.path);
  };

  for (const userDir of userDirs) {
    result.users++;
    const files = await listUserFiles(userDir);

    const survivors: Candidate[] = [];
    for (const f of files) {
      if (now - f.mtimeMs > ttlMs) {
        await drop(f);
        result.expired++;
      } else {
        survivors.push(f);
      }
    }

    if (!opts.maxBytesPerUser) continue;
    let used = survivors.reduce((n, f) => n + f.bytes, 0);
    if (used <= opts.maxBytesPerUser) continue;

    // Oldest first: the newest file is the one most likely to be the download
    // somebody is waiting on.
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of survivors) {
      if (used <= opts.maxBytesPerUser) break;
      await drop(f);
      result.evicted++;
      used -= f.bytes;
    }
  }

  return result;
}
