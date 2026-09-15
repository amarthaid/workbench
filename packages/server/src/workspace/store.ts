import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { resolveExistingFile, userFilePath, userWorkspaceDir } from "./paths";

export interface FileEntry {
  name: string;
  bytes: number;
  mtime: string;
  /** When the reaper will delete this file. Age only — a read does not move it. */
  expiresAt: string;
}

export type StoreError =
  | "INVALID_NAME"
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "QUOTA_EXCEEDED";

export class WorkspaceError extends Error {
  constructor(public readonly code: StoreError, message?: string) {
    super(message ?? code);
    this.name = "WorkspaceError";
  }
}

// In-flight uploads and downloads. Never listed, never readable, and skipped by
// the reaper's own listing so a partial file cannot be handed to anything.
const PART_SUFFIX = ".part-";
/** Chromium's partial-download suffix. Same reasoning as PART_SUFFIX. */
const CRDOWNLOAD_SUFFIX = ".crdownload";

function isPartial(name: string): boolean {
  return name.includes(PART_SUFFIX) || name.endsWith(CRDOWNLOAD_SUFFIX);
}

function entryFrom(name: string, size: number, mtimeMs: number): FileEntry {
  return {
    name,
    bytes: size,
    mtime: new Date(mtimeMs).toISOString(),
    expiresAt: new Date(mtimeMs + config.WORKSPACE_TTL_HOURS * 3_600_000).toISOString(),
  };
}

/**
 * Create the user's directory. mkdir's mode is subject to umask, so chmod
 * explicitly afterwards — the same reason profile-chromium.ts does both when it
 * creates a browser profile.
 */
export async function ensureUserDir(userId: string): Promise<string> {
  const dir = userWorkspaceDir(userId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

export async function listFiles(userId: string): Promise<FileEntry[]> {
  const dir = userWorkspaceDir(userId);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (!e.isFile() || isPartial(e.name)) continue;
    try {
      const st = await stat(path.join(dir, e.name));
      out.push(entryFrom(e.name, st.size, st.mtimeMs));
    } catch {
      /* raced with the reaper */
    }
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

export async function statFile(userId: string, name: string): Promise<FileEntry | null> {
  const abs = await resolveExistingFile(userId, name);
  if (!abs) return null;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    return entryFrom(path.basename(abs), st.size, st.mtimeMs);
  } catch {
    return null;
  }
}

export async function usedBytes(userId: string): Promise<number> {
  const files = await listFiles(userId);
  return files.reduce((n, f) => n + f.bytes, 0);
}

export async function readFileBytes(
  userId: string,
  name: string,
  maxBytes = config.WORKSPACE_MAX_FILE_BYTES
): Promise<Buffer> {
  const abs = await resolveExistingFile(userId, name);
  if (!abs) throw new WorkspaceError("NOT_FOUND");
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new WorkspaceError("NOT_FOUND");
  // Refuse rather than truncate. A CSV cut off mid-row still parses, which
  // makes a silent truncation worse than an error.
  if (st.size > maxBytes) throw new WorkspaceError("TOO_LARGE", `${st.size} bytes`);
  return readFile(abs);
}

/**
 * Check a would-be write against both caps.
 *
 * Enforced here, at write time, and never left to the reaper: a write that
 * reports success and then silently vanishes is the worst failure this system
 * can produce.
 */
async function assertCapacity(userId: string, name: string, incoming: number): Promise<void> {
  if (incoming > config.WORKSPACE_MAX_FILE_BYTES) {
    throw new WorkspaceError("TOO_LARGE", `${incoming} bytes`);
  }
  const existing = (await statFile(userId, name))?.bytes ?? 0;
  const used = await usedBytes(userId);
  if (used - existing + incoming > config.WORKSPACE_MAX_BYTES_PER_USER) {
    throw new WorkspaceError("QUOTA_EXCEEDED");
  }
}

export async function writeFileBytes(
  userId: string,
  name: string,
  data: Buffer
): Promise<FileEntry> {
  const abs = userFilePath(userId, name);
  if (!abs) throw new WorkspaceError("INVALID_NAME");
  await assertCapacity(userId, name, data.byteLength);
  await ensureUserDir(userId);
  await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  await writeFile(abs, data, { mode: 0o600 });
  const st = await stat(abs);
  return entryFrom(path.basename(abs), st.size, st.mtimeMs);
}

export interface WriteHandle {
  /** Absolute path of the staging file. */
  path: string;
  stream: WriteStream;
  /** Feed bytes through this so the per-file cap is enforced as they arrive. */
  write(chunk: Buffer): Promise<void>;
  commit(): Promise<FileEntry>;
  abort(): Promise<void>;
}

/**
 * Stream a file in.
 *
 * Writes to `<name>.part-<rand>` beside the target and renames on commit —
 * same directory, so the rename is atomic, and a crashed upload leaves an
 * obvious partial rather than a truncated real file.
 */
export async function openWriteStream(userId: string, name: string): Promise<WriteHandle> {
  const abs = userFilePath(userId, name);
  if (!abs) throw new WorkspaceError("INVALID_NAME");
  await ensureUserDir(userId);
  await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });

  const staging = `${abs}${PART_SUFFIX}${randomBytes(4).toString("hex")}`;
  const stream = createWriteStream(staging, { mode: 0o600 });
  let written = 0;
  let dead = false;

  const abort = async (): Promise<void> => {
    if (dead) return;
    dead = true;
    // Wait for the stream to actually close before unlinking. createWriteStream
    // opens its fd asynchronously, so destroying it and immediately rm-ing can
    // race the open: the unlink runs first, the open then creates the file, and
    // an orphaned .part- file is left behind. "close" fires after the fd is
    // gone, whichever order those landed in.
    await new Promise<void>((resolve) => {
      if (stream.closed) return resolve();
      stream.once("close", () => resolve());
      stream.destroy();
    });
    await rm(staging, { force: true });
  };

  return {
    path: staging,
    stream,
    async write(chunk: Buffer): Promise<void> {
      written += chunk.byteLength;
      // A declared Content-Length is a claim, not a measurement, so the cap is
      // enforced against what actually arrives.
      if (written > config.WORKSPACE_MAX_FILE_BYTES) {
        await abort();
        throw new WorkspaceError("TOO_LARGE", `${written} bytes`);
      }
      await new Promise<void>((resolve, reject) => {
        stream.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
    async commit(): Promise<FileEntry> {
      if (dead) throw new WorkspaceError("NOT_FOUND");
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve()));
      });
      try {
        await assertCapacity(userId, name, written);
      } catch (e) {
        await rm(staging, { force: true });
        throw e;
      }
      await rename(staging, abs);
      const st = await stat(abs);
      return entryFrom(path.basename(abs), st.size, st.mtimeMs);
    },
    abort,
  };
}

export async function deleteFile(userId: string, name: string): Promise<boolean> {
  const abs = await resolveExistingFile(userId, name);
  if (!abs) return false;
  await rm(abs, { force: true });
  return true;
}
