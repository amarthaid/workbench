# Browser File Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the browser move files in both directions — a page-triggered download lands in the user's workspace, and a file from the workspace can be put into an `<input type="file">`.

**Architecture:** `CdpClient` grows an event subscription, which it has never had. A second, lazily-created client on the browser target carries the `Browser.*` domain, because `setDownloadBehavior` and the download events do not live on the page target. Download routing is configured once at session creation, so a download always lands in the right place whether or not anyone was waiting for it; events are only used to await a specific one. Upload goes through `Runtime.evaluate` to an `objectId` and then `DOM.setFileInputFiles`, which takes server-side absolute paths — which works only because chromium runs on the same host as the server.

**Tech Stack:** TypeScript, CDP over `ws`, Fastify, vitest (`npm run test -w @a-workbench/server`).

**Spec:** `docs/superpowers/specs/2026-09-15-browser-file-transfer-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-15-agent-file-workspace.md` Tasks 1-2. `userFilePath`, `resolveExistingFile` and the store must exist
before Task 3 here.

## Global Constraints

- This repo is **public**. Never commit personal PII, company or internal
  project names, internal hostnames, or secrets. Test fixtures use synthetic
  values only: `user-1`, `u1`, `test@example.com`, `acme`, `demo-repo`.
- **No AI co-authorship.** Never add a `Co-Authored-By:` or "Generated with …"
  trailer naming Claude/Anthropic, and never commit under an AI author identity.
  `.githooks/commit-msg` enforces both.
- Run the server suite with `npm run test -w @a-workbench/server`. A single
  file: `npx vitest run tests/<file>.test.ts` from `packages/server`.
- The browser plugin stays **internal** (`plugins/internal/browser.ts`, not
  under `PLUGINS_DIR`). Nothing in this plan may expose browser control through
  `ToolContext` — a third-party plugin must never be able to drive the user's
  logged-in session.
- Network observation (`Network.*`) and selector-addressed clicking are **out of
  scope**. They build on Task 1's event layer and get their own spec.
- `tests/cdp-bridge.chromium.test.ts` is the existing pattern for a test that
  needs a real chromium. Follow it for anything that cannot be faked.

---

### Task 1: Event subscription in `CdpClient`

`CdpClient` dispatches command replies and throws away everything else
(`auth/browser-session.ts:35`):

```typescript
if (typeof msg.id !== "number") return;
```

Every CDP event lands on that line. There is no subscription mechanism at all,
so nothing downstream in this plan — or in the deferred network work — can be
built until one exists.

**Files:**
- Modify: `packages/server/src/auth/browser-session.ts:12-82` (`CdpClient`)
- Test: `packages/server/tests/cdp-events.test.ts`

**Interfaces:**
- Produces: `CdpClient.on(method: string, fn: (params: Record<string, unknown>) => void): () => void`
  — returns an unsubscribe.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/tests/cdp-events.test.ts` against a fake `ws` (the
existing `cdp-bridge.test.ts` shows the pattern). Cover:

- an event frame with no `id` reaches a listener registered for its `method`
- a listener for a different method is not called
- the returned unsubscribe stops delivery
- two listeners on one method both fire
- a listener that throws does not kill the socket and does not stop the other
  listener
- `handleGone` clears listeners and rejects in-flight command promises
- a command reply is still dispatched normally (no regression)

- [ ] **Step 2: Run the tests to verify they fail**

From `packages/server`: `npx vitest run tests/cdp-events.test.ts`
Expected: FAIL — `on is not a function`.

- [ ] **Step 3: Implement**

```typescript
  private listeners = new Map<string, Set<(p: Record<string, unknown>) => void>>();

  /**
   * Subscribe to a CDP event. Returns an unsubscribe — callers must use it, or
   * a long-lived session accumulates one handler per download.
   */
  on(method: string, fn: (p: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) { set = new Set(); this.listeners.set(method, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (set!.size === 0) this.listeners.delete(method); };
  }
```

In the `message` handler, replace the early return for frames with no `id`:

```typescript
      if (typeof msg.id !== "number") {
        // Event frame. Every CDP event used to be discarded here.
        const set = msg.method ? this.listeners.get(msg.method) : undefined;
        if (set) {
          for (const fn of set) {
            // One bad listener must not take down the socket for the session.
            try { fn(msg.params ?? {}); } catch (e) { console.warn(`[cdp] listener for ${msg.method} threw:`, e); }
          }
        }
        return;
      }
```

Widen the parsed message type to include `method` and `params`. In
`handleGone`, clear `this.listeners` alongside `drainPending` — a socket that
dies mid-download must reject its waiter, not leave it hanging until a timeout
that does not apply to events.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Run the full browser suite for regressions**

`npx vitest run tests/browser-session.test.ts tests/cdp-bridge.test.ts tests/browser-actions.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth/browser-session.ts packages/server/tests/cdp-events.test.ts
git commit -m "feat(browser): CDP event subscription on the persistent client"
```

---

### Task 2: Browser-target client and download routing

`Browser.setDownloadBehavior` and the `Browser.download*` events live on the
**browser** target. The session's `cdp` is attached to the page target
(`browser-session.ts:121`), and the page-level equivalents are deprecated.
`cdpCall` (`profile-chromium.ts`) reaches the browser target but is one-shot,
so it cannot carry events.

Routing is configured **at session creation**, not lazily when a download is
armed. One chromium per user and one profile per user means the downloads
directory is known before any page is open, so there is nothing to defer — and
a download nobody armed a wait for still lands in the workspace and shows up in
`files_list`, instead of vanishing into a temp directory.

**Files:**
- Modify: `packages/server/src/auth/browser-session.ts` (`WarmSession`,
  `ensureSession`, `closeBrowserSession`)
- Test: `packages/server/tests/browser-downloads.test.ts`

**Interfaces:**
- Consumes: `userWorkspaceDir` (workspace plan Task 1).
- Produces:
  - `WarmSession.browserCdp?: CdpClient`
  - `browserClient(s: WarmSession): Promise<CdpClient>` — lazily creates and
    caches
  - download routing applied during `ensureSession`

- [ ] **Step 1: Write the failing tests**

Cover: `ensureSession` sends `Browser.setDownloadBehavior` with the calling
user's workspace directory, `behavior: "allowAndName"` and
`eventsEnabled: true`; `browserClient` returns the same instance twice;
`closeBrowserSession` closes it; two users get two different `downloadPath`
values.

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

```typescript
// Downloads are routed once, when the session is created. The directory is a
// property of the user, and there is exactly one chromium per user, so there
// is nothing to defer to first use. `allowAndName` writes each file under its
// download GUID rather than a name derived from the remote server's
// Content-Disposition — see the rename in the capture task.
await (await browserClient(session)).send("Browser.setDownloadBehavior", {
  behavior: "allowAndName",
  downloadPath: userWorkspaceDir(userId),
  eventsEnabled: true,
});
```

Create the workspace directory (mode `0o700`, plus an explicit `chmod`) before
handing the path to chromium; chromium will not create a missing download
directory.

A failure here must not break session creation — a user whose workspace is
unavailable should still get a working browser. Log and continue.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/browser-session.ts packages/server/tests/browser-downloads.test.ts
git commit -m "feat(browser): route downloads into the per-user workspace"
```

---

### Task 3: Download capture

A download is a side effect of a *click*, not a callable verb — the agent
cannot call `browser_download(url)` because the URL is the thing it does not
know. So arm, act, await. Making `browser_click` implicitly wait would charge
every click a timeout for a download that usually is not coming.

**Files:**
- Modify: `packages/server/src/auth/browser-session.ts` (capture logic),
  `packages/server/src/plugins/internal/browser.ts` (two tools)
- Test: `packages/server/tests/browser-download-capture.test.ts`

**Interfaces:**
- Consumes: Task 1's `on`, Task 2's `browserClient`, the workspace store.
- Produces:
  - `expectDownload(s, opts): { handle: string }`
  - `awaitDownload(s, handle): Promise<{ name: string; bytes: number }>`
  - Tools `browser_expect_download`, `browser_await_download`

- [ ] **Step 1: Write the failing tests**

Drive a fake `Browser.downloadWillBegin` / `Browser.downloadProgress` pair
through the client. Cover:

- a completed download renames `<guid>` to the sanitized suggested filename
- **a `suggestedFilename` of `../../escape.csv` stays inside the workspace** —
  the name arrives from the remote server's `Content-Disposition` and is
  attacker-controlled
- a `suggestedFilename` that is empty, or is only separators, gets a fallback
- two downloads with the same suggested name both survive (collision suffix)
- `state: "canceled"` rejects the waiter
- a download over `WORKSPACE_MAX_FILE_BYTES` is rejected and leaves no file
- a socket that dies mid-download rejects the waiter rather than hanging
- `awaitDownload` past its timeout rejects and unsubscribes its listener

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

```typescript
// suggestedFilename comes from the remote server's Content-Disposition, so it
// is attacker-controlled: it is a candidate name, never a path. allowAndName
// is what makes this safe to get wrong — chromium has already written to a
// GUID we generated, so the worst a hostile name can do is fail validation.
const safe = safeRelPath(path.basename(suggested ?? "")) ?? `download-${guid}`;
```

Rename within the same directory, so the operation is atomic. On a collision,
suffix before the extension (`statement (2).csv`).

Call `touch(userId)` on every `downloadProgress`: `reapIdleSessions`
(`BROWSER_SESSION_TTL_SECONDS` = 300) must not close a session while a large
transfer is still running.

Enforce the size cap from `totalBytes` when the server sends one, and again
against the finished file when it does not.

Tool descriptions must state that a captured file is deleted 24 hours after it
lands, and that `browser_await_download` returns the expiry — an agent that
needs it to outlive the window has to hand it to Drive or Slack in the same run.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Verify against a real chromium**

Extend `tests/cdp-bridge.chromium.test.ts`'s pattern: serve a fixture page with
a link carrying `download`, click it, assert the bytes land in the workspace
directory under the right name.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth/browser-session.ts packages/server/src/plugins/internal/browser.ts packages/server/tests/browser-download-capture.test.ts
git commit -m "feat(browser): capture page downloads into the workspace"
```

---

### Task 4: Upload into a file input

`DOM.setFileInputFiles` takes **absolute, server-side paths**, and works only
because chromium runs on the same host as the server. That assumption deserves
a comment at the call site: it is the first thing that breaks if the browser
ever moves to its own pod.

Go through `Runtime` rather than `DOM.enable` + `getDocument` +
`querySelector` — `Runtime` is already enabled (`browser-session.ts:27`), and
an `objectId` avoids the nodeId staleness that bites across navigations.

**Files:**
- Modify: `packages/server/src/auth/browser-session.ts` (`uploadFile`),
  `packages/server/src/plugins/internal/browser.ts` (one tool)
- Test: `packages/server/tests/browser-upload.test.ts`

**Interfaces:**
- Consumes: `resolveExistingFile` (workspace plan Task 1), Task 1's client.
- Produces:
  - `uploadFile(s, selector, absPath): Promise<void>`
  - Tool `browser_upload_file({ selector, name })`

- [ ] **Step 1: Write the failing tests**

Cover:

- **a `name` of `../../../data/tokens.db` is refused before any CDP call is
  made** — this is the whole security case for the task
- an absolute `name` is refused
- **a symlink inside the workspace pointing at a file outside it is refused** —
  path arithmetic alone accepts it, so this is what proves the read went
  through `resolveExistingFile` and not `userFilePath`
- a `name` that does not exist in the workspace is refused with `NOT_FOUND`
- a selector matching nothing returns a clear error
- a selector matching a non-`input[type=file]` node returns a clear error
  rather than CDP's own unhelpful one
- the happy path sends `DOM.setFileInputFiles` with the resolved absolute path

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

This is an **allowlist**, not a pattern check: the only thing accepted is a
relative name, and the only path produced is one that resolves — through
symlinks — inside the calling user's workspace directory. Do not add a list of
forbidden prefixes; the traversal strings in the tests are cases that prove the
allowlist, not a mechanism.

```typescript
// The agent supplies a workspace-relative name; the server resolves it. An
// absolute path from a tool argument would make this an arbitrary-file-read
// primitive — chromium will upload whatever path it is handed, to whatever
// remote form is on the page. resolveExistingFile, not userFilePath: this is a
// read, so the symlink check applies.
const abs = await resolveExistingFile(ctx.userId, args.name);
if (!abs) return { error: "INVALID_NAME" };
```

Resolve the node, then verify it before setting files:

```typescript
const { result } = await s.cdp.send("Runtime.evaluate", {
  expression: `document.querySelector(${JSON.stringify(selector)})`,
});
```

Check `result.objectId` exists, then confirm via a second `Runtime.callFunctionOn`
that the node is an `input` with `type === "file"`. CDP's error for the wrong
node type is not something an agent can act on; ours should say what was found.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Verify against a real chromium**

Fixture page with a file input and a form; upload a workspace file; assert the
page sees the right filename and byte length.

- [ ] **Step 6: Typecheck the test suite**

`npm run typecheck:tests -w @a-workbench/server`

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/auth/browser-session.ts packages/server/src/plugins/internal/browser.ts packages/server/tests/browser-upload.test.ts
git commit -m "feat(browser): upload a workspace file into a file input"
```

---

### Task 5: Documentation and findings

**Files:**
- Modify: `docs/site/_content/integrations/browser.md` (or the equivalent page)
- Create: `docs/findings/2026-09-15-<topic>.md` for anything non-obvious the
  build turns up — the CDP event gap and the browser-vs-page target split are
  both likely candidates
- Modify: `CLAUDE.md` findings index for any finding added

- [ ] **Step 1: Document the download and upload tools**

Include the arm/act/await sequence — an agent that calls
`browser_await_download` without having armed first will otherwise wait for
something that was never subscribed.

- [ ] **Step 2: Record findings**

One finding per file, dated, following the existing format.

- [ ] **Step 3: Verify the docs build**

`node docs/site/build.mjs`

- [ ] **Step 4: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs(browser): download capture and file upload"
```
