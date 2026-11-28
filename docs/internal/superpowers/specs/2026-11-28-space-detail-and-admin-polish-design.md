# Space detail modal, delete, Activity filter fixes, custom apps permission, admin Spaces tab

Status: approved design, not yet implemented.

Five related changes, one branch. They share the Spaces portal page and the
Admin area, and none of them change tool-call behavior.

## 1. Space detail modal

### Problem

Clicking a Space card opens the Space immediately. There is no place to read a
Space's full name, full description or details before opening it, and the
owner's actions (edit details, edit sharing) live in a small tile menu. There
is no way to delete a Space from the portal (only an agent can).

### Behavior

- Clicking a Space card (the tile body) opens a **detail modal**. The heart on
  the card still toggles the favorite without opening anything. The tile's
  owner menu is removed; its actions move into the modal. The "pending
  requests" badge on a tile, if any, stays visible on the tile.
- Modal content:
  - **Hero:** the Space's generated cover (`coverFor`), enlarged, with the
    initial on it, the full title and the visibility badge over or under it.
  - **Description:** the full text, not clamped.
  - **Details:** owner, last updated, the Space's tool names (grouped by app,
    names only), likes (the favorite count, with the heart toggle), and for
    the owner "N people opened it in the last 30 days" under the existing
    privacy rule (shown only for an org-wide Space or from 5 people; absent
    otherwise).
  - **Footer:** primary **Open** button (navigates to the Space as the card
    does today). For the owner also **Edit details**, **Edit sharing** and
    **Delete Space**, which open the existing modals (edit details, sharing)
    or the new delete dialog.
- The modal uses only data the list already returns (`SpaceSummary`) plus the
  tool names, so opening it makes at most one extra request, and none for the
  summary fields. If tool names are not on `SpaceSummary`, the modal fetches
  the Space detail (`GET /api/spaces/:name`) for them and shows the rest while
  it loads.

### Delete Space

- Owner only, from the detail modal. Opens a confirmation dialog that:
  - names the Space and says it cannot be undone;
  - shows the impact: the audience (Only me / Specific people with the count /
    Everyone signed in) and "N people opened it in the last 30 days" (same
    privacy rule), and says that files and data stored in the Space go with it
    and that people who have it open will lose it;
  - keeps the red **Delete Space** button disabled until the owner types the
    Space name exactly.
- New route `DELETE /api/spaces/:name`, behind the existing `/api/spaces`
  portal-session-only preHandler. It checks ownership (404 for a Space the
  caller cannot see, 403 for one they can see but do not own, as the other
  owner-only routes do), runs the existing `deleteSpace` (metadata, shares,
  consents, approvals, per-person state, files) and writes an audit row with a
  new action `SPACE_DELETE` (`user_id` = owner, `integration` = `spaces`,
  `tool` = `space:<name>`). A failed audit write is logged and does not undo
  the delete.
- After a delete the portal returns to the gallery and removes the Space from
  the cached list. Anyone with it open gets the normal "no longer exists"
  state on their next request (404 path already exists).
- The agent `delete_space` tool is unchanged.

## 2. Activity filter popover

- **Padding:** the popover's inner padding and the gaps between fields are
  equal on all four sides. The right and bottom edges are tighter than the
  left in the current layout; fix in `activity-filters.css` and check at the
  popover's real width.
- **Autocomplete click:** choosing a suggestion in the Space or User field
  with the mouse currently closes the whole popover (only Enter works). The
  popover's click-outside handler (`mousedown` on `document`, in
  `ActivityFilters.tsx`) treats the suggestion list as outside when the list
  is rendered outside the popover's wrapper. Fix: the suggestion list counts
  as inside the popover (render it inside the wrapper, or have the handler
  ignore targets within any `role="listbox"` that belongs to a field of the
  popover), so a mouse click selects the item and the popover stays open.
  Keyboard behavior is unchanged (Enter selects, Esc closes the list then the
  popover).
- Applies to both places `ActivityFilters` is used (personal Activity, Admin
  Activity).

## 3. Custom apps as a per-user permission

### Today

`custom_apps_policy` is an instance setting (`mode: all | none | allowlist`,
`user_ids`) edited in Admin Config. `customAppsAllowedFor(userId)` in
`settings/instance-settings.ts` answers from an in-memory snapshot and is used
at `api/routes.ts` (profile `canCreateCustomApps`, the create route, the
update route) and `custom-apps/index.ts` (a denied user's existing custom-app
tools are hidden). Default is `all`.

### Change

- New capability in `permissions/capabilities.ts`:
  `custom_apps.create`, default **deny**, label "Add and use custom apps",
  description "Lets this user connect their own MCP servers as custom apps."
  Admin sets Allow per user in Admin Users, next to "Delegate access in
  Spaces" (the Users tab already lists every capability generically).
- The three route call sites and the tool-list call site use
  `await can(userId, "custom_apps.create")` instead of `customAppsAllowedFor`.
  Behavior is unchanged otherwise: a denied user cannot add or update custom
  apps and does not see existing custom-app tools (as with policy `none`
  today). The tool-list site is hot, so it takes one `can()` read per listing,
  not per app.
- The "Who can add custom apps" box and its `PUT` route
  (`setCustomAppsPolicy`, `setAdminCustomAppsPolicy`) are removed from Admin
  Config. `custom_apps_policy` stays in `instance_settings` only as the source
  for the migration below, then is ignored; the `AdminConfig` response drops
  the field.
- **Migration (once, at startup, after `initDb()`):** if `custom_apps_policy`
  is set and no `custom_apps.create` rows exist yet and a marker
  (`instance_settings` key `custom_apps_policy_migrated`) is absent, then
  - mode `all`: insert an allow row for every existing user;
  - mode `allowlist`: insert an allow row for each listed user that still
    exists;
  - mode `none`: insert nothing;
  then set the marker. Idempotent and safe across cluster workers (the marker
  insert arbitrates; rows use `ON CONFLICT DO NOTHING`). Users created after
  the upgrade start denied. No custom app that already exists is deleted or
  disabled.
- Audit: grants use the existing permission-change audit. The old
  `ADMIN_CUSTOM_APPS_POLICY` action stays in the union for old rows.

## 4. Admin "Spaces" tab

- New tab **Spaces** in Admin (after Files, before Users is fine). A list of
  mini cards, one per Space, newest updated first:
  - title and name;
  - owner email;
  - audience (Only me / Specific people (N) / Everyone signed in);
  - last updated (relative time);
  - description, clamped to two lines;
  - like count;
  - "N people opened it in 30 days"; expanding the card lists who opened it
    (emails) and when they last opened it. Admin only.
- Read only in this round: no delete, edit or open from the admin list.
- Server: `GET /api/admin/spaces?limit&cursor&q` (admin gate as the other
  `/api/admin` routes), keyset paged on `(updated_at, name)` with a longhand
  predicate (as the Activity query does) so it works on SQLite and
  PostgreSQL. `q` filters by name prefix or title substring using the same
  LIKE approach as `searchAdminSpaces`. Opener lists come from a second query
  for the visible page only (`space_user_state` joined to users and filtered
  to the last 30 days), so the list never loads every Space's openers. The
  existing `GET /api/admin/spaces/search` (picker) is unchanged.
- Opens are the existing per-person `space_user_state.last_opened_at` data;
  the owner's own opens are excluded from "people" to match the owner view.

## Non-goals

- Admin delete or edit of other people's Spaces.
- Changing how a Space opens, or the consent flow.
- Per-app granularity for custom apps (one capability for all custom apps).
- Showing opener names to owners (owners keep the count-only rule).

## Testing

Server (SQLite and PostgreSQL lanes):
- `DELETE /api/spaces/:name`: owner deletes and every table is cleaned, 403
  for a non-owner who can open it, 404 for one who cannot, 401 with an MCP
  token or API key, audit row written, a throwing audit logger still 200,
  name reuse leaves no stale rows (consents, approvals, per-person state).
- `custom_apps.create`: default deny, allow row grants, create/update routes
  refuse a denied user, tool listing hides apps for a denied user, profile
  `canCreateCustomApps` follows it, admin PUT only accepts allow.
- Migration: `all` grants every existing user, `allowlist` only the listed,
  `none` grants nobody, runs once (marker), idempotent on repeat, users added
  later are denied, existing custom apps remain.
- Admin Config no longer returns or accepts the policy.
- `GET /api/admin/spaces`: admin only (403 otherwise), paging across equal
  `updated_at`, `q` filter, openers limited to 30 days and excluding the
  owner, nothing returned for non-admin session or API key.

Portal:
- Card click opens the modal and does not navigate; heart does not open the
  modal; the Open button navigates; modal shows hero, full description,
  likes, owner extras only for the owner, no menu on the tile.
- Delete dialog: button disabled until the exact name is typed, shows
  audience and openers per the privacy rule, success removes the Space and
  closes, failure shows the error and keeps the dialog.
- Activity filters: padding class applied on all sides (assert the CSS
  tokens), a mouse click on a Space or User suggestion selects it and keeps
  the popover open; Esc order unchanged.
- Admin Users shows the new capability; Config no longer has the custom apps
  box.
- Admin Spaces tab: renders cards, paging, search, expand lists openers.

Prototype screenshots before finishing UI work: Space detail modal (viewer and
owner), delete dialog, Activity filter popover with an open suggestion list,
Admin Users with the new permission, Admin Spaces tab.

## Rollout

- No schema change except the new Admin routes' queries and one
  `instance_settings` marker row. No manual step; the migration runs at
  startup. Because it changes who can add custom apps for new users, call it
  out in the release notes ("new users cannot add custom apps until an admin
  allows it; existing users keep access").
