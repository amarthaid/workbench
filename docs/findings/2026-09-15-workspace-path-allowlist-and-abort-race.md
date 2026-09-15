# Two ways a file store leaks: symlinks past the path check, and a staging file past abort

_2026-09-15_

Both of these came out of building the agent file workspace. Neither is exotic,
and both are the kind of thing that looks handled until you write the test.

## 1. `path.resolve` is string arithmetic, so the allowlist had a hole

The workspace resolves a caller-supplied relative name against that user's own
directory and re-checks the prefix afterwards:

```ts
const target = path.resolve(base, rel);
if (target !== base && !target.startsWith(base + path.sep)) return null;
```

That is an allowlist, and it is the right shape — the only path it can produce
is one inside the caller's directory, and there is no list of forbidden patterns
anywhere. `../../../data/tokens.db` never survives it.

A **symlink** does. `path.resolve` normalizes text; it does not touch the
filesystem. A link sitting inside the workspace and pointing at the token
database satisfies every check above and still reads the target.

Where this matters most is `browser_upload_file`, which ends in
`DOM.setFileInputFiles` with an absolute path. Chromium uploads whatever path it
is handed, to whatever form happens to be on the page. A symlink there is not a
local file read — it is exfiltration to a third party of the attacker's
choosing.

So the resolver is now two functions, and which one you call is a real decision:

- `userFilePath(userId, name)` — pure path arithmetic, for naming a file being
  **created**.
- `resolveExistingFile(userId, name)` — adds `fs.realpath` and re-applies the
  prefix check, for anything about to **read** bytes.

Nothing in the design writes a symlink, so this is defence in depth. It is also
about six lines, the workspace sits on a volume other things can reach, and the
failure mode is silent.

One implementation detail worth an hour of somebody's time: **`realpath` the
base, not just the target.** On macOS `/tmp` is itself a symlink to
`/private/tmp`, so comparing a resolved target against an unresolved base
rejects every file in a tmpdir-backed test, and the failure reads like the guard
working correctly.

## 2. `createWriteStream` opens its fd asynchronously, so abort can lose the race

Streaming uploads write to `<name>.part-<rand>` and rename on commit. Abort
destroyed the stream and unlinked the staging file:

```ts
stream.destroy();
await rm(staging, { force: true });
```

This leaks a partial file, *sometimes*. `fs.createWriteStream` does not open the
file synchronously — it queues an open. Destroy it before that open lands and
the sequence becomes: destroy, unlink (nothing there yet), open (creates the
file). The staging file is left behind with nobody holding it.

It surfaced as a flaky test, which is the only reason it was caught at all: the
same suite had passed three runs in a row before the full-suite run lost the
race. The fix is to wait for the stream to actually close first — `"close"`
fires after the fd is gone, whichever order the open and destroy landed in:

```ts
await new Promise<void>((resolve) => {
  if (stream.closed) return resolve();
  stream.once("close", () => resolve());
  stream.destroy();
});
await rm(staging, { force: true });
```

The regression test aborts twenty-five streams immediately after opening them,
which is the tightest version of the race and fails reliably against the old
code.

Worth noting what saved us anyway: the reaper deletes by age with no exception
for partials, so an orphan would have gone within 24 hours regardless. A leak
that self-heals is still a leak, but it is a good argument for making retention
unconditional rather than clever.
