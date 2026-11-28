# UI consistency: one list look, one action language

Date: 2026-11-28

Spec: `docs/internal/superpowers/specs/2026-11-28-ui-consistency-design.md`.

## The rules

Files, Vault, Agents, Apps, Home, Settings and the admin pages follow the same few rules, taken from the Spaces gallery and modal.

- Objects with an identity are rich rows in a bordered list box with a header band. The page's one primary action is a purple button at the right of the band; no purple buttons inside rows. Tables stay only for large tabular data (Activity, Admin Users, Admin Activity).
- Two actions or fewer on a row are shown; a menu only for three or more. Actions are text buttons, destructive ones are red text and never filled. Hover-only actions are also revealed on focus.
- Three confirm levels: an undo toast (recoverable or short-lived, a single file delete), a simple confirm that names the object (revoke an agent by client id, bulk file delete), a typed name (irreversible with dependents: Space, secret, custom app).
- Loading is skeleton rows of real row height, never zeros or an empty message before data arrives. Filter and sort live in the header band and only above 15 items. The scroll container uses `scrollbar-gutter: stable` so pages stop shifting by the scrollbar width.

## Detail modals only for objects with nested content

A Space and an app contain a list of tools, each with an effect and a description, so a modal earns its click. A file, a secret or an agent has about four facts and they fit in the row, so a modal would restate the row and put a click in front of every action. The rule is a test to apply to future objects, not a style preference.

## The undo delay and why the row is hidden

A single file delete has no dialog. The portal waits 5 seconds before sending the delete, and Undo inside the window cancels it. This is client-side only: the server has no soft delete and no trash, and adding one for a 24 hour buffer would be more machinery than the file is worth.

The trade-offs:

- The delete is not sent until the window ends, so a closed tab inside the window cancels it (the file is kept, not deleted). That is the safe direction and the toast says so by existing: nothing was lost.
- The row is hidden while the delete is pending. Showing it would invite a second Delete or a Download of a file the user believes is gone, and a refetch in the window would bring it back and look like Undo had been pressed. Hiding is local state, so Undo only needs to unhide.
- Bulk delete does not use the toast. It confirms with the count and deletes sequentially through the same endpoint, reporting a failure count, because a long undo window over many rows is hard to reason about.

## /apps/:name stays a full page

The app quick view is a modal, but the app detail stays a route. It holds forms and flows (reconnect, custom-app headers, browser session tools, Remove app) that do not belong in a modal, and it is a deep-link target: connect links and Space consent screens send people to it. The quick view ends in a Manage link to it. Home app tiles skip the quick view and go straight to the page, since Home is where people go to act, not to read.

Custom apps: the old Delete became **Remove app** with a typed-name confirm, because removing an app takes its stored headers and its tools away from agents.

## Smaller behavior worth knowing

- The Vault copy chip copies the `{{vault:name}}` reference, never the value (the portal never has the value). The tooltip says so.
- Settings Theme offers Light and Dark only. The spec listed System as optional ("if supported") and it was not built.
- `GET /api/integrations/:name` now returns each tool's `effect` (from `effectOf`), so the shared tools accordion groups app tools by effect like the Space modal does, without a second request.

## Accessible names

- Modal dialogs had no accessible name when they used a hero header. `Modal` now takes an `ariaLabel` and the quick view and the Space modal pass one; without it a screen reader announced an unnamed dialog.
- Chips inside a button ran into the label ("ngmis2 reads"). A space is added before the chips in the accessible name.
- Row buttons name their target: "Delete <file>", "Download <file>", "Select <file>", "Copy reference for <secret>", so a list of identical "Delete" buttons is distinguishable. Two agents with the same name are told apart by the client id shown in the row and used in the confirm.
- Rows are not click targets that hide nested buttons; real buttons keep the plain tab order.
