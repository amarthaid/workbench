# Space tool approvals Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Per-tool "Always allow / Ask first" for write and destructive tools in Spaces. Viewers choose in ordinary Spaces; the owner's choices are the policy in delegated Spaces; set only in the portal; enforced by the server.

**Spec:** `docs/internal/superpowers/specs/2026-11-27-space-tool-approvals-design.md` (read it first; it is the source of truth where this plan is terse).

**Architecture:** A new `space_tool_approvals` table holds per-user, per-tool overrides of the default (write = auto, destructive = ask). A new module `packages/server/src/spaces/approvals.ts` owns the policy: which user's rows apply (`delegatedFor` uses the **stored** `access_mode`), the effective mode, the auto set, the subset re-consent check and the backfill. `api.ts` reads the policy once per request and uses it for the consent check, the ask check, the shown hash and the grant. The portal's tool list gains a segmented control, Allow all switches and read-only badges; the bridge asks on `tool.approval === "ask"`.

**Tech stack:** TypeScript, Fastify, SQLite + PostgreSQL (`db` adapter in `packages/server/src/db.ts`), vitest; React + TanStack Query portal, vitest + Testing Library.

**Conventions (all tasks):**
- Public repo: no real names, emails, company or internal refs in code, tests, docs or commits. Fixtures: `owner@example.com`, `viewer@example.com`, `acme`.
- No `Co-Authored-By` or AI trailers. No emoji, no em-dashes in any text.
- Commit after each task with a conventional message (`feat(spaces): ...`, `test(spaces): ...`, `docs(spaces): ...`). Do not commit `package-lock.json` noise (`git checkout package-lock.json` if npm touched it).
- Server tests: `npm run test -w @a-workbench/server -- tests/spaces` (SQLite). PostgreSQL lane: same command with `TEST_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/workbench_test` when a local PostgreSQL is available; PG-specific cases go in `tests/db-adapter.integration.test.ts` style (skipped without the URL).
- Portal tests: `npm run test -w @a-workbench/portal` (never bare vitest).
- Type-check: `npm run typecheck:tests -w @a-workbench/server` and `npm run build -w @a-workbench/portal`.
- If `@a-workbench/shared` types change, rebuild it: `npm run build -w @a-workbench/shared`.

---

### Task 1: Schema and approval rows store

**Files:**
- Modify: `packages/server/src/db.ts` (SQLite schema string near `space_consents` ~line 155, the guarded-ALTER list ~line 393, PostgreSQL schema ~line 328, PostgreSQL ALTER block ~line 447)
- Modify: `packages/server/src/spaces/store.ts` (`deleteSpace` ~line 587)
- Modify: `packages/server/tests/spaces/helpers.ts` (`resetSpacesDb` table list)
- Create: `packages/server/src/spaces/approvals.ts`
- Test: `packages/server/tests/spaces/approvals.test.ts`

**Step 1: failing tests** in `approvals.test.ts`:
- `getApprovalRows(space, userId)` returns `{}` with no rows.
- `writeApprovals(space, userId, { a: "auto", b: "ask" }, defaults)` where `defaults = { a: "ask", b: "auto" }` stores both; writing a tool back to its default deletes its row; returns the list of real changes `[{tool, from, to}]` (empty when nothing changed).
- `writeApprovals` is all-or-nothing (run in `db.transaction`).
- `deleteSpace(name)` removes the Space's approval rows (seed rows, delete, assert empty; then re-create a Space of the same name and assert no rows).

**Step 2:** run, expect failures (module missing).

**Step 3: implement.**

Schema (SQLite; PostgreSQL identical with `BIGINT` for `updated_at`):

```sql
CREATE TABLE IF NOT EXISTS space_tool_approvals (
  space_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  mode TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_name, user_id, tool)
);
```

Column: add `"ALTER TABLE space_consents ADD COLUMN auto_tools TEXT"` to the SQLite guarded list and `ALTER TABLE space_consents ADD COLUMN IF NOT EXISTS auto_tools TEXT;` to the PostgreSQL block. Add `space_tool_approvals` to `deleteSpace`'s transaction and to `resetSpacesDb`.

`approvals.ts` (first part):

```ts
export type ApprovalMode = "auto" | "ask";
export type ApprovalRows = Record<string, ApprovalMode>;

export async function getApprovalRows(spaceName: string, userId: string): Promise<ApprovalRows>;
export async function writeApprovals(
  spaceName: string,
  userId: string,
  next: Record<string, ApprovalMode>,
  defaults: Record<string, ApprovalMode>
): Promise<Array<{ tool: string; from: ApprovalMode; to: ApprovalMode }>>;
```

`writeApprovals` reads current rows inside the transaction, computes `from = rows[tool] ?? defaults[tool]`, skips when `from === to`, deletes the row when `to === defaults[tool]`, else upserts (`ON CONFLICT (space_name, user_id, tool) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`).

**Step 4:** tests pass. **Step 5:** commit `feat(spaces): tool approval rows and schema`.

---

### Task 2: Policy functions

**Files:**
- Modify: `packages/server/src/spaces/approvals.ts`
- Test: `packages/server/tests/spaces/approvals.test.ts`

**Step 1: failing tests**, a table-driven matrix over a Space fixture with tools: one read, one write, one destructive, one `delegable: false` write, one missing (use the existing fixtures in `tests/spaces/fixtures.ts`; add tools there if needed):
- `delegatedFor(space, viewerId)`: true only for stored `accessMode === "owner"` and viewer not owner. True also while delegation is paused (`delegatedToolsHash` mismatch) or the owner lacks `spaces.delegate_access` (no `delegationFor` call involved).
- `policySource(space, viewerId)`: owner id when delegated, else viewer id.
- `defaultMode(tool)`: write -> auto, destructive / unknown effect -> ask, read -> null.
- `approvalFor(space, viewerId, toolName, rows)`: read -> null; missing or internal -> "ask"; otherwise `rows[tool] ?? defaultMode`.
- `autoSet(space, viewerId, rows)`: sorted names whose `approvalFor` is "auto"; when `delegatedFor`, leaves out `delegable: false` tools.
- `approvalEditable(space, viewerId, toolName)`: false for read, missing, or when `delegatedFor`.

**Step 3: implement** in `approvals.ts`, reusing `registry.getTool`, `effectOf` from `@a-workbench/shared`, and the same internal-tool check `api.ts` uses for `missing` (move that check into a small exported helper if it is local to `api.ts`, and use it from both). Signatures take `rows` so callers control the single read:

```ts
export function delegatedFor(space: Space, viewerId: string): boolean {
  return space.accessMode === "owner" && viewerId !== space.ownerId;
}
export async function policyRows(space: Space, viewerId: string): Promise<ApprovalRows> {
  return getApprovalRows(space.name, delegatedFor(space, viewerId) ? space.ownerId : viewerId);
}
```

**Step 4:** pass. **Step 5:** commit `feat(spaces): approval policy`.

---

### Task 3: Consent with the auto set

**Files:**
- Modify: `packages/server/src/spaces/store.ts` (`grantConsent`, add `getConsentRow`)
- Modify: `packages/server/src/spaces/approvals.ts`
- Test: `packages/server/tests/spaces/approvals.test.ts`

**Step 1: failing tests:**
- `shownConsentHash(space, viewerId, auto)`: equals `consentHash(space, viewerId)` for owner and ordinary viewer; for a delegated viewer equals `sha256(JSON.stringify([consentHash(space, viewerId), auto]))` and differs when `auto` differs.
- `checkConsent(space, viewerId, rows)` returns `{ consented: boolean, reason?: "tools" | "approvals" }`:
  - no consent row -> `{ consented: false }` (no reason);
  - stored hash mismatch -> `{ consented: false, reason: "tools" }`;
  - delegated viewer, hash matches, `autoSet ⊆ approved` -> consented;
  - owner loosens a destructive tool -> `{ consented: false, reason: "approvals" }`;
  - owner tightens a write -> still consented;
  - `auto_tools` NULL counts as the Space's current write tools (delegable only);
  - owner and ordinary viewer skip the subset check.
- `grantConsent(space, userId, autoTools)` stores `auto_tools` as JSON when an array is given and NULL when `null`.

**Step 3: implement.**
- `store.ts`: `getConsentRow(name, userId): Promise<{ hash: string; autoTools: string[] | null } | null>` (parse JSON; treat unparsable as NULL). `grantConsent(space, userId, autoTools: string[] | null = null)` writes the extra column in both the insert and the `ON CONFLICT` update. Keep `getConsentHash` / `hasConsent` exported for now; Task 5 replaces every caller of `hasConsent` and then deletes it.
- `approvals.ts`: `shownConsentHash`, `checkConsent`, and `legacyApprovedSet(space)` (current write tools that are delegable).

**Step 4:** pass. **Step 5:** commit `feat(spaces): consent covers the delegated auto set`.

---

### Task 4: Backfill at startup

**Files:**
- Modify: `packages/server/src/spaces/approvals.ts` (`backfillDelegatedConsents`)
- Modify: `packages/server/src/index.ts` (after `await loadPlugins();` ~line 60)
- Test: `packages/server/tests/spaces/approvals.test.ts`

**Step 1: failing tests:** seed a delegated Space (stored `access_mode = 'owner'`) with consents for the owner, a viewer (NULL), a viewer with a set already; plus an ordinary Space with a viewer consent (NULL). After `backfillDelegatedConsents()`: only the delegated viewer's NULL row is filled, with the Space's current delegable write tools; the others are unchanged. Running it twice changes nothing.

**Step 3: implement:**

```ts
export async function backfillDelegatedConsents(): Promise<number> {
  // SELECT c.space_name, c.user_id FROM space_consents c JOIN spaces s ON s.name = c.space_name
  //   WHERE c.auto_tools IS NULL AND s.access_mode = 'owner' AND c.user_id <> s.owner_id
  // for each: load the Space (getSpace), compute legacyApprovedSet, then
  //   UPDATE space_consents SET auto_tools = ? WHERE space_name = ? AND user_id = ? AND auto_tools IS NULL
}
```

Check the real column names in `spaces` (owner column) in `db.ts` before writing SQL. In `index.ts`, call it after `loadPlugins()` inside a `try/catch` that logs `[spaces] consent backfill failed: ...` and does not stop startup.

**Step 4:** pass. **Step 5:** commit `feat(spaces): backfill delegated consents with today's defaults`.

---

### Task 5: API: detail, consent, call, open and KV

**Files:**
- Modify: `packages/server/src/spaces/api.ts` (detail GET ~line 260-330, consent POST ~line 550-578, call ~line 590-712, `hasConsent` uses at ~365 and ~796)
- Modify: `packages/server/src/spaces/store.ts` (remove `hasConsent` once unused)
- Test: `packages/server/tests/spaces/api.test.ts` (and `tests/spaces/helpers.ts` if the `consent()` helper needs the new hash)

**Step 1: failing tests** (HTTP-level, using the existing app builder and helpers in `api.test.ts`):
- Detail: each non-read tool has `approval` and `approvalEditable`; read tools have neither; delegated viewer gets `approvalEditable: false` and a `consent_hash` that changes when the owner loosens a tool; owner and ordinary viewer `consent_hash` unchanged from `consentHash`.
- Detail: `reconsent_reason: "approvals"` after an owner loosening; `"tools"` after a tool list change; absent when consented or never consented.
- Consent POST: delegated viewer with a stale shown hash -> 409 `CONSENT_CHANGED`; success stores `auto_tools`; owner and ordinary viewer store NULL.
- Grant stores the set that was checked: stub/spy so that the owner's rows change after the hash check (for example, wrap `getApprovalRows` with `vi.spyOn` to return the old rows on the first call and assert it is called exactly once per request).
- Call: a write the viewer set to `ask` without `confirmed` -> 428 `CONFIRMATION_REQUIRED`; with `confirmed: true` runs; a destructive set to `auto` runs without `confirmed`; delegated viewer follows the owner's rows (owner sets write to ask -> viewer gets 428, audited with both ids as today); owner loosens -> viewer gets 403 `CONSENT_REQUIRED`.
- Call: the policy is read once per request (spy count 1).
- `/open` and KV routes refuse after a loosening exactly as after a tool change.

**Step 3: implement.**
- Detail GET: `const rows = await policyRows(space, viewer.userId)`; per non-missing, non-read tool add `approval: approvalFor(...)`, `approvalEditable: approvalEditable(...)`; missing tools get `approval: "ask", approvalEditable: false`. `const auto = autoSet(space, viewer.userId, rows)`; `const c = await checkConsent(space, viewer.userId, rows)`; `consented: c.consented`, `consent_hash: shownConsentHash(space, viewer.userId, auto)`, and `...(c.reason ? { reconsent_reason: c.reason } : {})`.
- Consent POST: read `rows` once, compute `auto`, compare `shown` with `shownConsentHash(space, viewer.userId, auto)`, keep the existing delegation and connection gates, then `grantConsent(space, viewer.userId, delegatedFor(space, viewer.userId) ? auto : null)`.
- Call route: read `rows` once at step 2 and use `checkConsent(space, viewer.userId, rows)`; at step 7 replace the destructive check with `approvalFor(space, viewer.userId, toolName, rows) === "ask" && body.confirmed !== true` -> the same `refuse(428, ...)`.
- `/open` (~365) and KV (~796): `checkConsent(space, viewer.userId, await policyRows(space, viewer.userId))`.
- Delete `hasConsent` from `store.ts` once no caller is left (grep `hasConsent` across `src` and `tests`).
- Update `packages/shared/src/types.ts` only if `SpaceTool` / detail types live there (check; the portal copy is in `packages/portal/src/spaces-api.ts` and is Task 8).

**Step 4:** `npm run test -w @a-workbench/server -- tests/spaces` passes, including the existing suites (the `consent()` helper may need to send the new hash; `shownConsentHash` helper in tests already exists, update it). **Step 5:** commit `feat(spaces): enforce approval modes in consent and calls`.

---

### Task 6: PUT tool-approvals and the audit row

**Files:**
- Modify: `packages/shared/src/types.ts` (`AuditEvent.action` union ~line 181: add `"SPACE_APPROVAL_CHANGE"`), rebuild shared
- Modify: `packages/server/src/spaces/api.ts` (new route next to the consent routes)
- Modify: `packages/server/src/spaces/approvals.ts` (`recordApprovalChange`)
- Test: `packages/server/tests/spaces/api.test.ts`

**Step 1: failing tests:**
- `PUT /api/spaces/:name/tool-approvals` `{ tools: { "<write>": "ask" } }` by an ordinary viewer -> 200 `{ tools }` with the new `approval`; a second PUT back to the default deletes the row.
- 400 `INVALID_APPROVAL` for: undeclared tool, read tool, missing tool, mode `"never"`, body not an object; and nothing applied when one entry of several is invalid.
- 403 `APPROVAL_SET_BY_OWNER` for a delegated viewer, also while delegation is paused (tool change) and while the owner lacks the permission.
- 404 for someone who cannot open the Space (same as other routes).
- Allowed without consent.
- Owner of a stored-owner-mode Space: one `audit_log` row, action `SPACE_APPROVAL_CHANGE`, `integration = "spaces"`, `tool = "space:<name> approvals: <tool>=auto,<tool2>=ask"` (only real changes, in sorted tool order); no row when nothing changed; no row for an ordinary Space's owner when `access_mode = 'viewer'`; a throwing audit logger still returns 200.

**Step 3: implement.** Validate first (every key declared by the Space, tool exists, non-read, mode in `auto|ask`), then `writeApprovals(space.name, viewer.userId, tools, defaults)`, then audit if `space.ownerId === viewer.userId && space.accessMode === "owner" && changes.length > 0`, then return the same `tools` array the detail builds (extract the detail's tool-list builder into a function so both use it). `recordApprovalChange` mirrors `recordDelegationChange` (try/catch, `console.error` on failure).

**Step 4:** pass. **Step 5:** commit `feat(spaces): portal route to set tool approvals`.

---

### Task 7: Portal-only guarantees

**Files:**
- Test: `packages/server/tests/spaces/api.test.ts`, `packages/server/tests/spaces/plugin.test.ts`
- Modify (only if a test fails): `packages/server/src/plugins/internal/spaces.ts`

**Step 1: tests:**
- `PUT .../tool-approvals` with an API key / MCP bearer (whatever `api.test.ts` already uses to show the `/api/spaces` preHandler refuses non-session tokens) -> 401, and no row written.
- Through the plugin handlers in `plugin.test.ts`: seed approval rows for the owner and a viewer; run `update_space` (metadata, files, a tool list change, and visibility to private) and `deploy_space` over the same Space; assert the rows are unchanged afterwards.
- `deploy_space` / `update_space` input schemas have no approval-related property (assert the schema keys).

**Step 2:** run; these should pass without code changes. If any fails, fix the plugin so it never touches `space_tool_approvals`.

**Step 5:** commit `test(spaces): approvals are portal-only`.

---

### Task 8: Portal API client and bridge

**Files:**
- Modify: `packages/portal/src/spaces-api.ts` (`SpaceTool`, `SpaceDetail`, new `setToolApprovals`)
- Modify: `packages/portal/src/spaces/bridge.ts` (`isDestructive` use at ~224; keep the function only if still needed elsewhere)
- Test: `packages/portal/src/spaces/bridge.test.ts`

**Step 1: failing tests:**
- A tool with `approval: "ask"` (including a write) opens the confirm modal and sends `confirmed: true` after Allow.
- A tool with `approval: "auto"` (including a destructive) calls without the modal and without `confirmed`.
- A tool with no `approval` (read) calls without the modal.
- A 428 on an `auto` tool still asks and retries once (stale view, unchanged behavior).
- A Space message `{ type: "setApproval", ... }` (and any unknown type) is ignored: no API call, no state change.

**Step 3: implement.**
- `SpaceTool`: `approval?: "auto" | "ask"; approvalEditable?: boolean;`. `SpaceDetail`: `reconsent_reason?: "tools" | "approvals"`.
- `setToolApprovals(name, tools: Record<string, "auto" | "ask">): Promise<{ tools: SpaceTool[] }>` (PUT, `authHeaders` with JSON body, throws `SpaceApiError` like the other calls).
- Bridge: `const needsAsk = tool.approval === "ask" || (tool.approval === undefined && isDestructive(tool) && tool.effect !== "read")`. The fallback keeps an old server response safe; document it in a one-line comment.

**Step 4:** portal tests pass. **Step 5:** commit `feat(portal): bridge asks by approval mode`.

---

### Task 9: Tool list controls, Allow all and badges

**Files:**
- Modify: `packages/portal/src/spaces/ToolList.tsx`
- Reuse: `packages/portal/src/components/ui/Segmented.tsx`, `packages/portal/src/components/ui/Switch.tsx`
- Modify: `packages/portal/src/styles.css` (only for layout of the row control and the hint)
- Test: create `packages/portal/src/spaces/ToolList.test.tsx`

**Step 1: failing tests:**
- `effectLabel`: read -> Reads, write -> Writes, destructive and unknown -> "Deletes or changes".
- Editable mode (`approvals` + `onApprovalChange` props): each non-read row shows a Segmented "Always allow | Ask first" reflecting the mode; changing it calls `onApprovalChange({ [tool]: mode })`.
- Per-box Allow all switch: on when every non-read, editable tool in the box is auto; turning on sends every such tool as auto; turning off sends each tool's default (write auto, destructive ask), not all ask.
- Top-level Allow all (shown when there is more than one box with non-read tools, otherwise the box switch is enough): same, across boxes. Hint text under it: "Actions run without asking you. If this Space changes later, you approve it again."
- Read-only mode (`approvalEditable: false` tools, delegated viewer): badges "Runs without asking" / "Asks first", no controls, and the line "The owner decides which actions ask first." above the list.
- Missing tools: no control.

**Step 3: implement.** Props:

```ts
approvals?: Record<string, "auto" | "ask">;      // current choices (local or from the detail)
onApprovalChange?: (change: Record<string, "auto" | "ask">) => void;
```

When `onApprovalChange` is absent, render badges only. Defaults helper `defaultApproval(tool)` lives next to `effectLabel`.

**Step 4:** pass. **Step 5:** commit `feat(portal): per-tool approval controls`.

---

### Task 10: Consent screen, View tools and Sharing modal wiring

**Files:**
- Modify: `packages/portal/src/pages/SpaceShell.tsx` (consent screen ~line 70-110, approve mutation ~line 396, View tools ~line 345, re-consent copy ~line 550)
- Modify: `packages/portal/src/spaces/SharingModal.tsx`
- Test: `packages/portal/src/pages/SpaceShell.test.tsx`, `packages/portal/src/spaces/SharingModal.test.tsx`

**Step 1: failing tests:**
- Consent (ordinary): controls preset from the detail; changing one and clicking Approve sends the PUT with only the changed tools, then the consent POST with `consent_hash` from the detail; no PUT when nothing changed; a PUT failure shows its message and does not POST consent.
- Consent (delegated viewer): badges only, no PUT, consent POST with the detail's hash; `reconsent_reason: "approvals"` shows "The owner changed which actions run without asking."; `"tools"` keeps today's copy.
- View tools (ordinary viewer and owner): a change sends the PUT at once and updates the cached detail (`queryClient.setQueryData` with the returned `tools`), so the bridge's next call uses it.
- View tools (delegated viewer): badges only.
- View tools (owner, stored delegation on): note "Viewers follow these settings. Changing an action to Always allow asks each viewer to approve again."
- Sharing modal with Delegate my access on: "N actions run without asking for viewers. Change in View tools." where N counts delegable non-read tools with `approval === "auto"`; hidden when delegation is off; singular "1 action runs".

**Step 3: implement.** Keep the consent choices in component state seeded from `space.tools`; the approve mutation becomes `PUT (if dirty) -> grantSpaceConsent(name, data.consent_hash)`; keep the existing `onError` refetch on `INTEGRATION_NOT_CONNECTED` / `CONSENT_CHANGED`.

**Step 4:** pass. **Step 5:** commit `feat(portal): approvals on the consent screen, View tools and Sharing`.

---

### Task 11: Prototype screenshots (checkpoint, stop for the user)

Run the portal against a dev server with a seeded Space (follow how earlier Space screenshots were made: `npm run dev`, Playwright, `deviceScaleFactor: 2`). Capture:
1. Consent, ordinary Space, with the controls and both Allow all levels.
2. Consent, delegated viewer, badges only.
3. Re-consent after an owner loosening.
4. View tools, ordinary viewer.
5. View tools, owner of a delegated Space, with the note.
6. Sharing modal with the summary line.

Show them to the user and wait for go-ahead before Task 12. Apply requested changes, re-shoot, repeat.

---

### Task 12: Docs and finding

**Files:**
- Modify: `docs/site/_content/guides/spaces.md` (how viewers choose Always allow / Ask first; delegated Spaces follow the owner)
- Modify: `docs/site/_content/integrations/spaces.md` (the HTTP surface: `approval`, `approvalEditable`, `reconsent_reason`, `PUT /tool-approvals`, `APPROVAL_SET_BY_OWNER`, `INVALID_APPROVAL`, the 428 now covering writes set to Ask first)
- Create: `docs/findings/2026-11-27-space-tool-approvals.md` (non-obvious points: stored vs in-effect delegation and why, subset re-consent with tighten-free, grant stores what was checked, one policy read per request, backfill needs the registry so it runs after `loadPlugins`, page-swap exposure of Always allow)
- Modify: `CLAUDE.md` Findings Index (one line, same style as the others)

Build: `node docs/site/build.mjs` (no broken links). Commit `docs(spaces): tool approvals`.

---

### Task 13: Full verification

Run and report output:
- `npm run typecheck:tests -w @a-workbench/server`
- `npm run test -w @a-workbench/server` (SQLite)
- PostgreSQL lane with `TEST_POSTGRES_URL` set if a local PostgreSQL is available; otherwise say it was not run locally and rely on CI.
- `npm run test -w @a-workbench/portal`
- `npm run build`
- `node docs/site/build.mjs`
- Scrub: `git diff origin/main --stat` and `git diff origin/main | grep -inIE '<company>|@(icloud|gmail)\.com'` returns nothing.

Then superpowers:finishing-a-development-branch (do not push or open a PR without the user's go).
