import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface FilesStats {
  files: number;
  bytes: number;
  users: number;
  /** Seconds since the oldest file was written; null when there are no files. */
  oldest_age_seconds: number | null;
  /** Largest users by bytes. Sizes only — never a file name. */
  top_users: { email: string | null; files: number; bytes: number }[];
  /** Largest single files. Sizes only. */
  largest: { email: string | null; bytes: number; age_seconds: number }[];
}

/**
 * Walk the agent file workspace: one directory per user, named by a hash of the
 * user id (`userKey`), files directly inside. Pure over its inputs so a temp
 * dir can stand in for the volume; the route supplies the hash→email map.
 * Names and contents are never read out — only sizes and times.
 */
export async function getFilesStats(o: {
  root: string;
  emailByKey: Map<string, string | null>;
  now?: number;
  topN?: number;
}): Promise<FilesStats> {
  const now = o.now ?? Date.now();
  const topN = o.topN ?? 5;
  let userDirs: string[] = [];
  try {
    const entries = await readdir(o.root, { withFileTypes: true });
    userDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    /* no workspace yet: nothing stored */
  }

  const perUser: { email: string | null; files: number; bytes: number }[] = [];
  const all: { email: string | null; bytes: number; mtimeMs: number }[] = [];
  for (const key of userDirs) {
    const email = o.emailByKey.get(key) ?? null;
    let names: string[] = [];
    try {
      names = (await readdir(join(o.root, key), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      continue;
    }
    let files = 0;
    let bytes = 0;
    for (const name of names) {
      try {
        const st = await stat(join(o.root, key, name));
        files++;
        bytes += st.size;
        all.push({ email, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* raced with the reaper or a writer */
      }
    }
    if (files > 0) perUser.push({ email, files, bytes });
  }

  const age = (ms: number) => Math.max(0, Math.floor((now - ms) / 1000));
  return {
    files: all.length,
    bytes: all.reduce((n, f) => n + f.bytes, 0),
    users: perUser.length,
    oldest_age_seconds: all.length ? age(Math.min(...all.map((f) => f.mtimeMs))) : null,
    top_users: perUser.sort((a, b) => b.bytes - a.bytes).slice(0, topN),
    largest: [...all]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, topN)
      .map((f) => ({ email: f.email, bytes: f.bytes, age_seconds: age(f.mtimeMs) })),
  };
}
