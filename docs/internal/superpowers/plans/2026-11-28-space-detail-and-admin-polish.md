# Space detail modal, delete, filter fixes, custom apps permission, admin Spaces tab: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ship the five changes in `docs/internal/superpowers/specs/2026-11-28-space-detail-and-admin-polish-design.md` (read it first; it is the source of truth).

**Tech stack:** TypeScript, Fastify, SQLite + PostgreSQL (`db` adapter), vitest; React + TanStack Query portal, vitest + Testing Library.

**Conventions (all tasks):**
- Public repo: no real names, emails, company or internal refs, no secrets. Fixtures: `owner@example.com`, `viewer@example.com`, `acme`.
- No `Co-Authored-By` or AI trailers. No emoji, no em-dashes in any text (code, comments, copy, docs, commits).
- TDD: failing test first, see it fail for the right reason, then implement. One commit per task, conventional messages. Never commit `package-lock.json` noise. Do not push.
- Server tests: `npm run test -w @a-workbench/server -- tests/<file>`; full: `npm run test -w @a-workbench/server`. PostgreSQL lane: `TEST_POSTGRES_URL=postgres://postgres:postgres@localhost:55433/workbench_test ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 npm run test -w @a-workbench/server` against a throwaway `docker run --rm -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=workbench_test -p 55433:5432 postgres:16` (stop it afterwards).
- Portal tests only via `npm run test -w @a-workbench/portal` (bare vitest fails on localStorage). Type-check: `npm run typecheck:tests -w @a-workbench/server`; portal build: `npm run build -w @a-workbench/portal`. Rebuild shared after changing it: `npm run build -w @a-workbench/shared`.
- Read the code named in each task before editing; line numbers drift.

---

### Task 1: Owner delete route

**Files:** `packages/server/src/spaces/api.ts` (new `DELETE /:name` next to the other owner routes), `packages/shared/src/types.ts` (`AuditEvent.action` += `"SPACE_DELETE"`), `packages/server/src/spaces/approvals.ts` or a new small `audit` helper beside `recordApprovalChange` for `recordSpaceDelete`, tests in `packages/server/tests/spaces/api.test.ts`.

Tests first: owner `DELETE /api/spaces/:name` -> 200 and every Space table is clean (spaces, space_shares, space_consents, space_tool_approvals, space_user_state, space_kv, approval requests of kind space.access if the maker-checker tables reference the Space, files dir), a later GET is 404, re-creating the same name has no stale rows; non-owner who can open it -> 403; non-viewer -> 404; API key / MCP bearer -> 401 and nothing deleted; one `SPACE_DELETE` audit row (`user_id` owner, `integration` `spaces`, `tool` `space:<name>`); a throwing audit logger still answers 200 and the Space is gone.

Implement with the existing `deleteSpace` (check it also clears maker-checker rows for the Space; if `approval_requests` rows reference a deleted Space, delete or close them in the same transaction as the maker-checker module expects, reading `packages/server/src/approvals/` first). Same 404/403 shape as the other owner-only routes. Commit `feat(spaces): owner delete route`.

### Task 2: `custom_apps.create` permission and migration

**Files:** `packages/server/src/permissions/capabilities.ts`, `packages/server/src/settings/instance-settings.ts` (keep the stored policy only for migration), `packages/server/src/api/routes.ts` (profile `canCreateCustomApps`, create route, update route), `packages/server/src/custom-apps/index.ts` (tool listing), `packages/server/src/admin/config.ts` and its route registration in `packages/server/src/api/admin-routes.ts` (remove `custom_apps_policy` from the response and delete `setCustomAppsPolicy` + route), `packages/server/src/index.ts` (run the migration after `initDb()`), new `packages/server/src/permissions/custom-apps-migration.ts`; tests: `tests/custom-apps-policy.test.ts` (rewrite for the capability), `tests/admin-config.test.ts`, `tests/admin-permissions.test.ts`, new `tests/custom-apps-migration.test.ts`, `tests/instance-settings.test.ts`.

Tests first, per the spec's Testing section: default deny; allow row grants; create and update routes refuse a denied user (same error code as today's policy refusal); tool listing hides custom-app tools for a denied user and makes exactly one `can()` read per listing; profile `canCreateCustomApps` follows the capability; admin permission PUT accepts only the opposite of the default (allow) for this capability; Config response no longer has `custom_apps_policy` and the old PUT route is 404; migration cases (`all`, `allowlist` with a user that no longer exists, `none`, marker prevents a second run, repeat is a no-op, users inserted afterwards are denied, existing custom apps untouched, concurrent double run inserts each row once).

Implement: capability `custom_apps.create` (default deny, label "Add and use custom apps", description "Lets this user connect their own MCP servers as custom apps."). Replace `customAppsAllowedFor` at the four call sites with `await can(userId, "custom_apps.create")` (the tool-listing site: one read per listing). Migration: if `instance_settings` has `custom_apps_policy` and no `custom_apps_policy_migrated` marker, insert the marker first with an atomic insert (the insert is the arbiter; only the process whose insert took effect continues), then insert rows with `ON CONFLICT DO NOTHING` (`user_permissions`: capability `custom_apps.create`, subject as the capability store uses for a plain capability, effect `allow`, `granted_by` null or a system marker per the store's rules). Keep `custom_apps_policy` readable only inside the migration; remove the `customAppsAllowedFor` export when unused. Audit grants through the store's existing path; no audit row per migrated user (log a single `console.log` count line). Commit `feat(permissions): custom apps become a per-user permission`.

### Task 3: Admin Spaces list endpoint

**Files:** `packages/server/src/admin/spaces.ts` (new `listAdminSpaces`), `packages/server/src/api/admin-routes.ts` (`GET /api/admin/spaces`), tests `packages/server/tests/admin-spaces.test.ts` (extend or create).

Tests first: admin-only (403 for a non-admin session, 401/403 for API key); newest `updated_at` first; keyset paging across rows with equal `updated_at` (longhand predicate `updated_at < ? OR (updated_at = ? AND name > ?)` with the sort `updated_at DESC, name ASC`, cursor opaque base64 of `[updatedAt, name]`); `q` filters by name prefix (LIKE) or title substring; each item has `name,title,description,owner_email,visibility,share_count,favorite_count,openers_30d` and `openers` (emails with `last_opened_at`) for the visible page only, last 30 days, excluding the owner, and only people who can still open it (same rule as the owner-side count: skip `private` entirely); `limit` default 24, max 100; `has_more` via limit+1.

Reuse the favorite-count join from the existing gallery query in `spaces/store.ts` (read it; do not recompute differently). Two queries: the page, then openers for those names only (`WHERE space_name IN (...) AND last_opened_at >= ?`). Commit `feat(admin): list every Space`.

### Task 4: Activity filter popover fixes (portal)

**Files:** `packages/portal/src/components/ActivityFilters.tsx`, `packages/portal/src/components/activity-filters.css`, possibly `Combobox.tsx` / `SpaceCombobox.tsx` / `PersonCombobox.tsx`, tests `ActivityFilters.test.tsx` and the combobox tests.

Tests first: with a Space or Person suggestion list open, `userEvent.click` on a suggestion selects it, the popover stays open, and the draft holds the value; Esc closes the list first then the popover; a click outside (not on the list) still closes the popover. Reproduce the bug in the test before fixing (the suggestion list is outside `wrapRef`, so the document `mousedown` handler closes the popover; confirm by reading `Combobox.tsx` for where the list renders, a portal or not).

Fix: make the list count as inside (render inside the wrapper, or ignore `mousedown` targets within an element the popover owns, for example by `data-popover-owned` on the list, or `closest('[role="listbox"]')` limited to this popover's fields). Padding: equal inner padding and consistent field gaps on all four sides; assert the computed padding tokens in the test where the test environment allows, otherwise add the CSS and verify in the screenshots. Commit `fix(portal): keep the Activity filter open when picking a suggestion, even the padding`.

### Task 5: Space detail modal, delete dialog, tile changes (portal)

**Files:** `packages/portal/src/spaces/SpaceTile.tsx` (card click opens modal, heart unchanged, owner menu removed, pending badge kept), new `packages/portal/src/spaces/SpaceDetailModal.tsx` (+ test), new `packages/portal/src/spaces/DeleteSpaceDialog.tsx` (+ test), `packages/portal/src/pages/Spaces.tsx` (state for the open detail, wiring to the existing edit-details and sharing modals, delete mutation), `packages/portal/src/spaces-api.ts` (`deleteSpace(name)` via `DELETE /api/spaces/:name`, plus a tool-names source if the summary lacks them), `packages/portal/src/styles.css`, existing tests `Spaces.test.tsx`, `SpaceTile` tests.

Tests first (spec Testing section, Portal): card body click opens the detail modal and does not navigate; heart toggles without opening; Open button navigates exactly as the card did; modal shows hero cover, full unclamped title and description, owner, last updated, like count with heart, tool names grouped by app; owner sees Edit details, Edit sharing, Delete Space; non-owner sees only Open and the heart; openers line only per the privacy rule (`viewers_30d` present); delete dialog: button disabled until the exact name is typed (case-sensitive), shows audience and openers per the rule, success closes both dialogs and removes the Space from the list, failure shows the server message and keeps the dialog. The tile menu is gone (assert no menu button).

Tool names: first check whether `SpaceSummary` already carries them; if not, fetch `GET /api/spaces/:name` with `useQuery` when the modal opens and show the rest immediately. Use the existing `Modal`, `Badge`, `Button` ui components and `coverFor`. Commit `feat(portal): Space detail modal with owner actions and a typed-name delete`.

### Task 6: Admin Spaces tab, Users capability, Config cleanup (portal)

**Files:** `packages/portal/src/pages/Admin.tsx` (new tab `{ id: "spaces", label: "Spaces", path: "/admin/spaces" }` after Files), new `packages/portal/src/components/admin/SpacesTab.tsx` (+ test), `packages/portal/src/api.ts` (`fetchAdminSpaces`, remove `setAdminCustomAppsPolicy` and `custom_apps_policy` from `AdminConfig`), `packages/portal/src/components/admin/ConfigTab.tsx` (+ test: delete the custom apps box), `packages/portal/src/components/admin/UsersTab.tsx` (+ test) only if the capability list is not already rendered generically.

Tests first: tab renders mini cards with title, owner, audience, last updated, clamped description, likes, openers count; expand lists openers with emails and last opened; paging ("Load more" with the keyset cursor), search box debounced and cached; empty and error states; Config no longer has "Who can add custom apps" or calls the removed endpoint; Users shows "Add and use custom apps" with Default/Allow and the existing confirm behavior unchanged for the delegate capability.

Match the existing admin card styling (`CardBody`, `Box`). Commit `feat(admin): Spaces tab, custom apps permission in Users, config cleanup`.

### Task 7: Docs and finding

**Files:** `docs/site/_content/guides/spaces.md`, `docs/site/_content/integrations/spaces.md` (the `DELETE` route and the card/modal), `docs/site/_content/deploy/admin.md` (Spaces tab, custom apps permission, migration), `docs/findings/2026-11-28-space-detail-and-admin-polish.md` (non-obvious points: popover click-outside vs listbox, custom apps policy migration with marker, hidden tools for denied users, delete cleanup incl. maker-checker rows), `CLAUDE.md` Findings Index line. Run `node docs/site/build.mjs`. Commit `docs: Space detail, delete, admin Spaces tab, custom apps permission`.

### Task 8: Prototype screenshots (stop for the user) and verification

Shoot (Playwright, deviceScaleFactor 2, fixtures with `page.route`; the earlier script pattern is in the session scratchpad `shoot.cjs`, adapt it): detail modal (viewer, owner), delete dialog (empty and typed), Activity filter popover with an open suggestion list, Admin Users with the new permission, Admin Spaces tab (collapsed and expanded). Show them to the user and WAIT for approval before pushing. Then run the full verification: server typecheck, full server suite on SQLite and PostgreSQL, full portal suite, `npm run build`, docs build, scrub (`git diff origin/main | grep -inIE '<company>|@(icloud|gmail)\.com|<real-name>'` and an added-lines em-dash check).
