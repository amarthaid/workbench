#!/usr/bin/env node
import { reapWorkspace, type WorkspaceReapResult } from "./workspace";
import { reapProfiles, type ProfileReapResult } from "./profiles";

// Disk sweeps as a subcommand, not a timer inside the server.
//
// The old in-server interval fired on EVERY pod, so under CLUSTER_ENABLED / HA
// N processes swept the same shared PVC concurrently. This runs once, from one
// scheduled job, against the shared volume.
//
// IMPORTANT: this file and everything it imports must stay free of ../config.
// That schema requires ENCRYPTION_KEY (length 64, empty default outside tests)
// and SESSION_SECRET, so importing it would make a directory-sweeping CronJob
// carry the encryption key. A sweep needs a path and a number. There is a test
// that runs this with no environment at all, and it is there to keep that true.

interface Flags {
  files: boolean;
  profiles: boolean;
  dir?: string;
  profilesDir?: string;
  ttlHours: number;
  ttlDays: number;
  maxBytesPerUser?: number;
  dryRun: boolean;
  json: boolean;
}

const USAGE = `Usage: npm run reap -- [options]

Sweeps the agent file workspace and the browser profile trees. With neither
--files nor --profiles, both run.

  --files                 sweep the file workspace only
  --profiles              sweep the browser profiles only
  --dir <path>            workspace root        (env WORKSPACE_DIR)
  --profiles-dir <path>   profiles root         (env BROWSER_PROFILES_DIR)
  --ttl-hours <n>         file age limit        (env WORKSPACE_TTL_HOURS, default 24)
  --ttl-days <n>          profile age limit     (env BROWSER_PROFILE_TTL_DAYS, default 30)
  --max-bytes-per-user <n>  quota to evict down to (env WORKSPACE_MAX_BYTES_PER_USER)
  --dry-run               report what would go, delete nothing
  --json                  machine-readable summary
  -h, --help
`;

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    files: false,
    profiles: false,
    dir: process.env.WORKSPACE_DIR,
    profilesDir: process.env.BROWSER_PROFILES_DIR,
    ttlHours: Number(process.env.WORKSPACE_TTL_HOURS ?? 24),
    ttlDays: Number(process.env.BROWSER_PROFILE_TTL_DAYS ?? 30),
    maxBytesPerUser: process.env.WORKSPACE_MAX_BYTES_PER_USER
      ? Number(process.env.WORKSPACE_MAX_BYTES_PER_USER)
      : undefined,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--files": flags.files = true; break;
      case "--profiles": flags.profiles = true; break;
      case "--dir": flags.dir = next(); break;
      case "--profiles-dir": flags.profilesDir = next(); break;
      case "--ttl-hours": flags.ttlHours = Number(next()); break;
      case "--ttl-days": flags.ttlDays = Number(next()); break;
      case "--max-bytes-per-user": flags.maxBytesPerUser = Number(next()); break;
      case "--dry-run": flags.dryRun = true; break;
      case "--json": flags.json = true; break;
      case "-h":
      case "--help": process.stdout.write(USAGE); process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default: throw new Error(`unknown option: ${a}`);
    }
  }

  // Neither named means both.
  if (!flags.files && !flags.profiles) { flags.files = true; flags.profiles = true; }
  return flags;
}

export interface ReapSummary {
  dryRun: boolean;
  workspace?: WorkspaceReapResult & { dir: string };
  profiles?: ProfileReapResult & { dir: string };
}

export async function runReap(flags: Flags): Promise<ReapSummary> {
  const summary: ReapSummary = { dryRun: flags.dryRun };

  if (flags.files) {
    if (!flags.dir) throw new Error("--dir (or WORKSPACE_DIR) is required for --files");
    summary.workspace = {
      dir: flags.dir,
      ...(await reapWorkspace({
        dir: flags.dir,
        ttlHours: flags.ttlHours,
        maxBytesPerUser: flags.maxBytesPerUser,
        dryRun: flags.dryRun,
      })),
    };
  }

  if (flags.profiles) {
    if (!flags.profilesDir) {
      throw new Error("--profiles-dir (or BROWSER_PROFILES_DIR) is required for --profiles");
    }
    summary.profiles = {
      dir: flags.profilesDir,
      ...(await reapProfiles({
        baseDir: flags.profilesDir,
        ttlDays: flags.ttlDays,
        dryRun: flags.dryRun,
      })),
    };
  }

  return summary;
}

function human(summary: ReapSummary): string {
  const mb = (n: number): string => `${(n / 1e6).toFixed(1)}MB`;
  const lines: string[] = [];
  const prefix = summary.dryRun ? "[dry-run] " : "";
  if (summary.workspace) {
    const w = summary.workspace;
    lines.push(
      `${prefix}workspace ${w.dir}: ${w.expired} expired, ${w.evicted} over-quota, ` +
        `${mb(w.freedBytes)} across ${w.users} user(s)`
    );
  }
  if (summary.profiles) {
    const p = summary.profiles;
    lines.push(
      `${prefix}profiles ${p.dir}: ${p.deleted.length} deleted, ${p.trimmed} trimmed, ` +
        `${mb(p.freedBytes)}, ${p.skippedActive} skipped as live`
    );
  }
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<number> {
  let flags: Flags;
  try {
    flags = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  try {
    const summary = await runReap(flags);
    process.stdout.write(flags.json ? `${JSON.stringify(summary)}\n` : `${human(summary)}\n`);
    return 0;
  } catch (e) {
    // Non-zero so a CronJob surfaces the failure rather than looking healthy.
    process.stderr.write(`reap failed: ${(e as Error).message}\n`);
    return 1;
  }
}

// Only when actually invoked as the CLI, so the module stays importable by tests.
if (process.argv[1] && /reap[/\\]cli\.(ts|js)$/.test(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
