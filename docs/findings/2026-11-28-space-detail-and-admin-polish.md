# Space detail, delete, admin Spaces tab, custom apps permission

Date: 2026-11-28

Spec: `docs/internal/superpowers/specs/2026-11-28-space-detail-and-admin-polish-design.md`.

## The suggestion click closed the Activity popover

The Activity filter popover closes on a `mousedown` handler on `document`. Choosing a suggestion with the mouse closed the whole popover, while Enter worked. Moving the list inside the wrapper was not the cause: the list was already inside. The cause is ordering. React removes the clicked option from the DOM (the list unmounts on selection state change) before the document handler runs, so `wrapper.contains(event.target)` is false for a node that is no longer attached. The fix reads `event.composedPath()`, which is captured at dispatch time and still lists the wrapper, so the click counts as inside. Any click-outside check on a control that unmounts itself in the same event needs composedPath, not `contains(target)`.

## Custom apps became a permission, with a one-time migration

`custom_apps.create` is a per-user capability, default deny. The old instance setting `custom_apps_policy` is read once and then ignored.

- Marker and rows are written in one transaction. The marker `custom_apps_policy_migrated` in `instance_settings` arbitrates between workers (the insert wins once); grant rows use `ON CONFLICT DO NOTHING`. A crash cannot leave a marker without rows or rows without a marker.
- A missing `custom_apps_policy` is treated as `all`, because that was the old default. Reading "missing" as "none" would have revoked every existing user's ability without anyone choosing it.
- Rows are written with `granted_by` `system`, so the Users tab shows they came from the migration rather than an admin.
- Default deny is safe only because of this: everyone who could add custom apps before is granted before the new default applies, and only users created later start denied. No existing custom app is deleted or disabled.

## Denied users lose existing custom-app tools too

As with policy `none` before, a user without the permission keeps their custom apps but agents stop seeing those apps' tools. The tool listing takes one `can()` read per listing, not one per app, because that path is hot. Turning the permission off is therefore not only "cannot add more"; tell admins before they flip it for someone who relies on one.

## Deleting a Space also closes open access requests

`DELETE /api/spaces/:name` reuses `deleteSpace`, which closes open `space.access` requests (maker-checker) in the same transaction as the row deletes. Otherwise an owner could later approve a request for a Space that no longer exists, or for a new Space reusing the name. The route is owner only (404 when the caller cannot open it, 403 when they can but do not own it) and writes `SPACE_DELETE`; a failed audit write is logged and does not undo the delete.

## Admin Spaces list: openers capped and paged for the visible page only

`GET /api/admin/spaces` is keyset paged on `(updated_at DESC, name ASC)` with the longhand predicate (a row-value comparison is not portable to PostgreSQL). Shares, likes and openers come from one query each for the visible page, so cost does not grow with the number of Spaces. Openers are capped at 50 per Space and `openers_30d` carries the true count, so a very popular Space cannot bloat the response. The owner's own opens are excluded. The picker search moved to `GET /api/admin/spaces/search`, and `GET /api/admin/spaces` is now the list.
