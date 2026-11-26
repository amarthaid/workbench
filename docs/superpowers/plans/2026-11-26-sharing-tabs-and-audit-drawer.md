# Sharing tabs and audit drawer: implementation plan

Spec: `docs/superpowers/specs/2026-11-26-sharing-tabs-and-audit-drawer-design.md`.
Commands: `npm run test -w @a-workbench/server`, `npm run test -w @a-workbench/portal`
(add `-- <file>` to run one file). Test first, then the change, for every task.

## Tasks

### 1. Server: tell the portal the permission is missing
- Files: `packages/server/src/spaces/api.ts` (list ~L210, detail ~L282, PATCH
  response ~L414 and write path ~L372-383), `packages/portal/src/spaces-api.ts`
  (Space types, ~L10 and L49), spaces API tests.
- `delegate_access` stays as stored. Add `delegation_blocked: "no_permission"`
  for the owner only; read `can()` once per request.
- Tests: blocked owner gets stored `delegate_access: true` plus
  `delegation_blocked`; with the permission, no flag; a viewer never gets it.
  A people-only PATCH leaves `access_mode` and `delegated_tools_hash`. A widening
  PATCH while blocked turns the mode off and audits it with the reason.
- Update `tests/spaces/api.test.ts:463-479` (owner after revoke).

### 2. Server: audit filters
- Files: `packages/server/src/audit/query.ts` (`ListAuditOptions`,
  `ListAllAuditOptions`, both list functions), the two route handlers that parse
  query strings, `packages/portal/src/api.ts` types.
- Add `since`, `until`, `delegated`, `space`, `auth`, and (personal only)
  `person`: email, max 254 characters, exact case-insensitive, applied inside
  the `user_id = me OR actor_user_id = me` scope. Also new
  `GET /api/activity/people?since=&until=`: distinct other parties on the
  caller's delegated rows, max 50 with counts, same 90-day cap. Validate: integers,
  `until >= since`, range at most 90 days when `since` is sent (400 otherwise;
  no `since` keeps today's behaviour), `space` and `auth` against a fixed set or
  a name pattern, and refuse unknown `status` on the personal endpoint too, as
  admin does. `person` matches `COALESCE(users.email, recorded)` like the rows.
- Schema: add `idx_audit_created ON audit_log (created_at, id)` for both
  backends (RC release). Compare `EXPLAIN` before and after.
- Tests per filter on both functions, the 90-day rejection, and that paging
  with a cursor still works with filters set.

### 2b. Server: admin Space search endpoint
- Files: new route in the admin routes (next to `admin/users.ts` handlers), a
  small query function over `spaces`, `packages/portal/src/api.ts` client.
- `GET /api/admin/spaces?q=&limit=`: admin permission only, `q` 2 to 64
  characters (400 otherwise), `limit` default and max 20, `%` and `_` escaped,
  name prefix as an index range, title via `LOWER(title) LIKE ? ESCAPE`, prefix
  hits first, sorted by name. Returns `{ spaces: [...], has_more }`, no count.
- Tests: non-admin gets 403; short `q` gets 400; limit capped; prefix beats
  substring order; `%` in `q` matches literally; no private data beyond name,
  title, owner email.

### 3. Server: origin fields on the personal endpoint
- Files: `audit/query.ts` (`UserAuditEventRow`, select list), personal route,
  `ActivityEvent` type.
- Return `auth_method`, `client_name`, `source_ip`, `user_agent`; null them when
  `delegation.direction === "for_me"`.
- Test: a for_me row has all four null; a by_me and an own row have them.

### 4. Portal: shared filter bar and activity query hook
- New `components/ActivityFilters.tsx`: All / Errors, date range, a Filters
  button with count badge, and a popover (App, Space, Person or User,
  Credential, Delegated only) holding a draft that commits on Apply (Reset,
  Esc and outside click discard), plus the chips line. Tests: editing the draft
  makes no activity request; Apply makes exactly one; Esc discards. Both pages use it; the admin page passes the User field instead of Person.
- Extend `fetchActivity` / `fetchAdminActivity` options. Reuse the existing
  `changeFilter` reset of paged rows.

### 5. Portal: detail drawer
- New `components/ActivityDrawer.tsx` with focus trap, Esc, scrim, Newer / Older
  and arrow keys. Rows become keyboard-activatable.
- Admin payload: keep `fetchAdminActivityPayload` and `staleTime: Infinity`;
  fetch only after the Show click. Remove `PayloadModal` from `ActivityCard`.
- Tests: opens on click and Enter, closes on Esc, payload not requested until
  Show, for_me row shows the withheld-origin note.

### 6. Portal: personal Activity page
- `pages/Activity.tsx`: filter bar, drawer, agent line under the app name.
- Space filter uses `SpaceCombobox` (task 7) with the personal source: Spaces
  from `fetchSpaces`, filtered in the browser, no extra requests.
- Delegated rows: second muted line in the App / Tool cell with the other
  person and Space ("Used by ..." / "On access of ..."). No new column.
- Person filter: `PersonCombobox` fed by `useQuery(["activity","people",range])`
  with long `staleTime`, filtered in memory; picking sets `person` and turns on
  Delegated only. Tests: delegated row shows the person line in the tool cell,
  non-delegated does not; typing makes at most one people call and zero activity
  calls until a pick; person filter never returns rows outside the user's own
  scope (server test in task 2).

### 7. Portal: admin Activity card and email combobox
- `components/admin/ActivityCard.tsx`: same table columns plus Duration and the
  delegation line; filter bar; drawer.
- New `components/admin/UserEmailCombobox.tsx`: `useQuery(["admin","users"])`
  with long `staleTime`, in-memory filter, keyboard handling, empty and
  `total > 500` states.
- Test (the important one): type five characters and assert the users endpoint
  was called at most once and the activity endpoint zero times until a pick.

- New `components/SpaceCombobox.tsx`, shared by both pages. Props: a `source`
  (`local` list, or `remote` search function). Remote mode: min 2 characters,
  250 ms debounce, abort on newer keystroke, `useQuery(["admin","spaces",q])`
  with long `staleTime`, results limit 20.
- Test: with the remote source, type five characters quickly and assert at most
  one spaces call, zero with 1 character, zero activity calls until a pick;
  retyping a cached query makes no call; the local source makes no calls.

### 8. Portal: Sharing dialog tabs
- `spaces/SharingModal.tsx`: split `SharingForm` into `AccessTab` and
  `PeopleTab`, tab badges, button text rule, no tab strip when `delegation_blocked` (muted line plus a Turn off button),
  Only-me link to People. `wasOn` and `widening` still read stored
  `delegate_access`. The confirm step is untouched.
- Styles: `.space-share-*` additions in `styles.css`.
- Update `SharingModal.test.tsx` (the "still turn it off" case stays valid); add
  cases for no tabs, badges, the button text and Turn off while blocked.
- Update `ActivityCard.test.tsx` (debounce, `PayloadModal` removed).

### 9. Docs and release
- Release notes under `docs/releases/` (RC, new index), findings note on the
  blocked-delegation rules (stored kept, widening turns it off), update
  `docs/site/_content/reference/http-api.md` for the new params and endpoints,
  and add the findings index line to `CLAUDE.md`.
- Pre-commit scrub from `CLAUDE.md`; no real emails in fixtures.

## Order and risk

1, 2, 2b, 3 first (server, independent of each other), then 4 and 5, then 6, 7, 8.
Task 8 depends only on task 1. Task 2 carries the one schema change (index), so
the release is an RC; check query plans on PostgreSQL too.

## Decide before starting

Nothing open. 90-day cap confirmed; admin Space search decided.
