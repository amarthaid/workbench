# UI consistency: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ship `docs/internal/superpowers/specs/2026-11-28-ui-consistency-design.md` (read it first; it is the source of truth): one list look, one action language, three confirm levels, an app quick view, rich rows for Files, Vault and Agents, and the small defects found in a live review.

**Stack:** React portal (Vite, TanStack Query, react-router), vitest and Testing Library. Portal only: no server, API or schema changes.

**Conventions (all tasks):**
- Public repo: no real names, emails, company or internal refs. Fixtures: `owner@example.com`, `acme`, fake secrets such as `tok-abc`.
- No AI trailers, no emoji, no em-dashes anywhere (code, comments, tests, UI copy, docs, commits). Conventional commits, one per task. Never commit `package-lock.json` noise. Do not push.
- TDD: write the failing test, see it fail for the right reason, then implement. A test that never failed proves nothing.
- Portal tests only via `npm run test -w @a-workbench/portal` (bare vitest fails on localStorage). Build: `npm run build -w @a-workbench/portal`. Keep the stylesheet guard test passing (no shadows, no capsule radii).
- Read the current code of each page before editing; line numbers drift. Reuse `Box`, `BoxRow`, `Badge`, `Button`, `Modal`, `ConfirmDialog`, `EmptyState`, `Tooltip`, `Markdown`, `Icons`.
- Use existing CSS tokens (`--border`, `--bg-sunk`, `--text-2`, `--text-3`, `--accent`, `--danger`, spacing `--s-*`). Light and dark must both work; no hard-coded colors except white on cover art.

---

### Task 1: Shared pieces

**Files:** new `components/ui/ListRow.tsx`, `components/ui/RowActions.tsx` (`RowAction`, danger variant), `components/ui/ListSkeleton.tsx`, `components/ui/CopyChip.tsx`, `components/ui/Toast.tsx` plus a small provider and `useUndoableAction` hook in `hooks/useUndoableAction.ts`, `components/dialogs/TypedNameConfirm.tsx` (generalized from `spaces/DeleteSpaceDialog.tsx`, which then uses it), `components/ToolsAccordion.tsx` (extracted from `spaces/SpaceDetailModal.tsx`), `styles.css` (rules for these, `scrollbar-gutter: stable` on the app scroll container). Tests beside each.

Behavior (see spec "Shared pieces"):
- `ListRow`: leading icon tile, title, subtitle, chips, actions; native buttons, never a click-target wrapper around nested buttons; supports a leading checkbox slot.
- `RowAction`: text button; `danger` is red text, never filled. Actions hidden until hover are also shown on `:focus-within` and focus.
- `ListSkeleton`: N rows with the real row height.
- `CopyChip`: shows a monospace text chip with a copy icon; click copies the given text with `navigator.clipboard.writeText`, shows "Copied" for 1.5s, `aria-label` and tooltip configurable; works when clipboard is unavailable (fallback shows the text selected).
- `Toast` + `useUndoableAction({ run, delayMs = 5000 })`: shows "<label> deleted. Undo" and calls `run` after the delay; Undo cancels; unmounting the provider or leaving the page cancels pending actions without running them (per spec). Tests with fake timers.
- `TypedNameConfirm`: title, impact list slot, the name to type, danger button disabled until the exact name (case-sensitive) is typed, `busy` and `error` states. `DeleteSpaceDialog` is rewritten on top of it with unchanged behavior and tests.
- `ToolsAccordion`: moved verbatim from the Space modal (summary chips by effect, one box per app, first app open, all open when two or fewer apps, tool rows expandable with markdown descriptions and effect sentence, missing tools), plus fixes: a space before the chips in accessible names ("ngmis, 2 reads" via visually hidden text), no repeated summary chips on an app header when the list has a single app (`singleApp` prop or derived). The Space modal uses it; its existing tests pass unchanged except the accessible-name and single-app expectations.

Commit: `feat(portal): shared list, action, confirm and tools pieces`.

### Task 2: Files page

**Files:** `pages/Files.tsx` (+ tests), keeps the exports `formatBytes`, `expiryLabel`, `expiresInPhrase`.

Rich rows per spec: file-type icon tile (by extension), middle-truncated full name (a pure helper `middleTruncate(name, max)` that keeps the tail; full name in tooltip and accessible name), subtitle size and written time, expiry chip (same colors as now), visible Download icon button, Delete revealed on hover and focus, checkbox per row, bulk bar in the header band when anything is selected (Delete selected, Download selected, Clear), sort control (newest, expiring soonest, size) and a name filter only when more than 15 files, Upload as the primary header action. Single delete uses `useUndoableAction` (no dialog); bulk delete uses `ConfirmDialog` with the count and deletes sequentially, reporting failures. Skeleton while loading, `EmptyState` when none. Keep existing API calls.

Tests: truncation keeps the tail; sort orders; filter appears only above 15; single delete shows the toast, is sent after the delay, Undo cancels it; bulk delete asks for confirmation naming the count; selection state clears after delete; hover-only actions reachable by keyboard focus. Commit `feat(portal): Files as rich rows with bulk actions`.

### Task 3: Vault page

**Files:** `pages/Vault.tsx` (+ tests); `VaultSecretForm` untouched.

Rich rows: key icon tile, name, description, subtitle "Updated X, last used Y" (or "never"), the `{{vault:name}}` reference as a `CopyChip` (copies the reference only; tooltip "Copies the reference, never the value"), actions Replace (link to the existing replace route) and Delete (red text). Delete uses `TypedNameConfirm` with the secret name and a note that references to it will stop working. Header band: Add secret (primary) and One-time link (secondary). Skeleton and empty state. Tests: the copy writes exactly the reference string; delete disabled until the exact name; replace goes to `/vault/:name/replace`; empty state. Commit `feat(portal): Vault as rich rows with copyable references`.

### Task 4: Agents page

**Files:** `pages/Agents.tsx` (+ tests).

Rich rows: initial tile, agent name, client id always visible (monospace), connected time, scope chip, visible red-text Revoke. Revoke opens `ConfirmDialog` naming the client id ("Revoke access for <name> (<client id>)?"). The "Connect an agent" box keeps its content with the shared header-band and action rules. Skeleton, empty state. Tests: two agents with the same name both show their client ids; revoke confirm text includes the client id; revoke calls the API once on confirm and not on cancel. Commit `feat(portal): Agents as rich rows`.

### Task 5: Apps quick view and app detail

**Files:** `pages/Apps.tsx` (+ tests), new `components/AppQuickView.tsx` (+ tests), `pages/AppDetail.tsx` (+ tests), `components/IntegrationLogo.tsx` reuse.

- Apps tile click opens `AppQuickView` (a `Modal` in the Space modal's language: header band with logo and name and a connection chip; one facts line with auth type, version and tool count; the single-app tools via `ToolsAccordion` fed from `fetchIntegration`; footer with the primary action (Connect, Reconnect, or Open settings for built-ins) and **Manage** linking to `/apps/:name`). The route `/apps/:name` and all deep links stay unchanged.
- `AppDetail`: replace the tools table with `ToolsAccordion`, give the page header the logo, keep every form and flow (reconnect, headers editor, browser tools, disconnect, custom app removal). Disconnect and custom app removal use the shared red-text style, with a typed-name confirm for removing a custom app (irreversible, has the user's tokens).
- Apps page header: the "+" icon button becomes a labeled primary button "Add custom app" in the header band; filters keep their position.
Tests: tile click opens the quick view and does not navigate; Manage goes to `/apps/:name`; Connect action present when not connected; tools accordion renders descriptions as markdown and effect badges; deep link `/apps/slack` still renders the page; custom app removal needs the typed name. Commit `feat(portal): app quick view and app detail on the shared look`.

### Task 6: Home, Settings, Admin and Space fixes

**Files:** `pages/Home.tsx`, `pages/Settings.tsx`, `components/admin/UsersTab.tsx`, `components/admin/SpacesTab.tsx`, `spaces/SpaceDetailModal.tsx`, `components/ActivityFilters.tsx` (and Space/Person combobox where needed), `styles.css`; tests next to each.

- Home: stat cards and lists show skeletons while loading, never zeros or "No apps connected yet"; "Your apps" becomes compact tiles (as in Apps); add a "Your Spaces" row with the top few gallery tiles (reuse `SpaceTile` in compact size, click opens the Space detail modal as on the Spaces page).
- Settings: the Theme row becomes a labeled `Segmented` control (Light, Dark, plus System only if the theme hook supports it); Regenerate key and Revoke follow the row action rules (Revoke red text).
- Admin Users: fixed date column widths so Joined and Last active stay on one line; the actions cell wraps inside the card instead of overflowing; Disable and Revoke key use the red-text rule.
- Admin Spaces cards: add the generated cover (reuse `Cover`) as a thin left band.
- Space detail modal: show the "Delegated" or "Delegated, paused" chip beside the audience chip in the header band, same conditions as the tile.
- Activity filter: after picking a Space the field shows the Space title and keeps the slug as the value.
Tests: Home shows skeletons then data and never renders "No apps connected yet" while loading; theme control switches theme; Admin Users actions cell has wrapping styles and no fixed-width overflow (assert class and CSS rule); the Delegated chip; the filter shows the title. Commit `fix(portal): loading states, theme control, admin and Space details`.

### Task 7: Docs and finding

**Files:** `docs/site/_content/guides/*.md` where these pages are described (grep for Files, Vault, Agents, Apps), `docs/findings/2026-11-28-ui-consistency.md` (the rules, why detail modals only for nested content, the undo-delay trade-off, `/apps/:name` stays a route), `CLAUDE.md` Findings Index line, `node docs/site/build.mjs`. Commit `docs: UI consistency rules and updated page descriptions`.

### Task 8: Screenshots (stop for the user) and verification

Shoot with Playwright (dark and light, 2x, fixtures via `page.route`; adapt the screenshot script used for the earlier Space modal shots): Files (many rows, selection with the bulk bar, undo toast), Vault, Agents (two agents with the same name), Apps with the quick view open, an app detail page, Home (loading skeleton and loaded), Settings, Admin Users, Admin Spaces, the Space modal with the Delegated chip. Show them and WAIT for the user's approval before pushing. Then: portal tests (full), `npm run build`, docs build, `typecheck:tests` and the server suite are unchanged and need not be rerun, scrub (company names, emails, added-line em-dashes, AI trailers).
