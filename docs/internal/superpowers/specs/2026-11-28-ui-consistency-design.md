# UI consistency: one list look, one action language, app quick view

Status: approved design, not yet implemented.

## Problem

The Spaces gallery and the Space detail modal got a lot of design work and are
the reference. The older pages (Files, Vault, Agents, parts of Apps, Home,
Settings, Admin) still use dense tables and key-value boxes, and a live review
found these inconsistencies:

- Destructive actions have four styles: a solid red button (Agents Revoke,
  Admin Disable, app Disconnect), a plain purple text link (Files and Vault
  Delete, the same as Download and Replace), a red-text outline button (Delete
  Space), and a typed-name dialog (Spaces only).
- Filter controls have two styles (underline tabs with counts on Apps and
  Admin, a filled segmented control on Spaces); search boxes differ in width.
- Loading has three styles: a centered "Loading apps..." on a blank page,
  inline "Loading Spaces ...", and Home showing zeros plus "No apps connected
  yet" before data arrives.
- Tool lists have three styles: the app detail table of raw descriptions, the
  consent page boxes, and the Space modal accordion.
- Header actions differ: a button at the top right (Files, Vault), a small "+"
  icon beside the filters (Apps).
- Pages that scroll sit about 5px to the left of pages that do not, because the
  scrollbar takes space.
- Smaller defects: the Settings theme row is a lone glyph; Admin Users date
  columns wrap and Disable overflows the card on rows with Revoke key; Admin
  Spaces cards have no covers; the Space modal does not show "Delegated";
  accessible names run together ("ngmis2 reads"); a one-app Space shows the
  same counts twice; the Activity filter shows a Space slug instead of its
  title.

## Principles

1. Tables stay only where the data is genuinely tabular and large (Activity,
   Admin Users, Admin Activity). Objects with an identity get the Spaces look.
2. **Detail modals only for objects with nested content** (Spaces, Apps). A
   file, secret or agent has about four facts, so its row shows them and a modal
   would restate the row and add a click before every action.
3. One list look, one action language, three confirm levels.

## Shared pieces (the rules)

1. **List box.** A bordered `Box` with a grey header band (title, count, the
   page's one primary action at the right as a purple button) and rows with a
   leading icon tile, title, subtitle, chips and actions. New `ListRow`
   component (`components/ui/ListRow.tsx`) on top of `BoxRow`.
2. **Row actions.** A row with two actions or fewer shows them; "..." only for
   three or more. Actions are text buttons; destructive ones are red text and
   never filled (`ui-row-action`, `ui-row-action-danger`). Hover-revealed
   actions are also revealed on focus. The same red-text style is used for
   Delete Space, Revoke, Disable, Disconnect and Delete everywhere.
3. **Three confirm levels.**
   - Undo toast, for things that expire or are recoverable (single file
     delete). The portal waits about 5 seconds before sending the delete; Undo
     cancels it. Closing the tab inside the window cancels it too.
   - Simple confirm naming the object (`ConfirmDialog`), for revocable things
     (revoke an agent, naming its client id; bulk delete of files).
   - Typed name, for irreversible things with dependents (Space, secret). The
     existing delete dialog is generalized to `TypedNameConfirm`.
4. **Primary action** sits in the header band at the right as a purple button.
   No purple buttons inside rows.
5. **Filter and sort** controls appear in the header band, same position
   everywhere, and only above about 15 items.
6. **Loading** is skeleton rows with the same height as real rows
   (`ListSkeleton`). **Empty** is one icon, one sentence and the primary action
   (`EmptyState`, already present, used everywhere).
7. **Layout.** `scrollbar-gutter: stable` on the scroll container so pages stop
   shifting; the content column does not move between pages.
8. **Accessibility.** Rows are not click targets that hide nested buttons. Use
   real buttons and the plain tab order, Escape closes, focus returns to the
   trigger, hover-only actions also show on focus. Chips inside a button get a
   space before them in the accessible name.

## Pages

### Files

Rich rows. Each row: file-type icon tile, the full machine name middle-truncated
so the timestamp tail survives (full name in a tooltip and the accessible
name), size and written time as the subtitle, the expiry chip (colored by time
left, as now) and a visible Download icon button. Delete is revealed on hover and
on focus. Rows have a checkbox; selecting one shows a bulk bar in the header band
(Delete selected, Download selected, Clear). Sort control (newest, expiring
soonest, size) and a name filter in the header band when there are more than 15
files. Single delete: undo toast, no dialog. Bulk delete: simple confirm showing
the count. Upload stays the primary action in the header band.

### Vault

Rich rows. Each row: key icon tile, the secret name and description, updated and
last used as the subtitle, and the `{{vault:name}}` reference as a click-to-copy
chip (copy icon, "Copied" feedback). It copies the reference, never the value,
and the tooltip says so. Replace opens the existing form route (it needs an
input); Delete asks for the typed secret name. Add secret and One-time link stay
in the header band (Add secret is the primary).

### Agents

Rich rows. Each row: initial tile, the agent name, the client id always visible
(two agents can share a name), connected time, the scope chip and a visible
red-text **Revoke**. Revoke opens a simple confirm naming the client id. The
"Connect an agent" box is unchanged apart from the shared styles.

### Apps and app detail

- The Apps tile click opens an **app quick view** modal in the Space modal's
  language: a header band with the app logo and name (the connection state as a
  chip), one facts line (connection, auth type, version, tool count), and the
  tools accordion (shared with the Space modal: totals by effect, one box per
  app is replaced by a single box for this one app, effect badges, descriptions
  rendered as markdown, click to expand). Footer: the primary action (Connect,
  Reconnect or Open settings) and **Manage**, which goes to the full page.
- `/apps/:name` stays a full page: it holds forms and flows (reconnect,
  custom-app headers, browser session tools) that do not belong in a modal, and
  it is a deep-link target (connect links, Space consent screens). Its tools
  table is replaced by the shared tools accordion and its header gets the logo.
- The Apps page header action: the "+" icon becomes a labeled primary button
  ("Add custom app") in the header band.

### Home

The "Your apps" list becomes tiles (the same compact tile as Apps), and a "Your
Spaces" row with the top gallery tiles is added. While data loads, stat cards
and lists show skeletons, never zeros or "No apps connected yet".

### Admin and Settings

- Admin Users: fixed column widths so dates stay on one line, and row actions
  (Revoke key, Disable) wrap inside the card instead of overflowing; destructive
  actions follow the red-text rule.
- Admin Spaces cards get the generated cover as a thin left band.
- Settings: the Theme row becomes a labeled segmented control (Light, Dark,
  System if supported); Regenerate key and Revoke follow the action rules.

### Spaces

- The detail modal shows a "Delegated" chip (and "Delegated, paused") next to the
  audience in the header, as the tile does.
- The tools accordion: accessible names get a space before the count chips;
  for a Space with a single app the summary chips are not repeated on the app
  header; the Activity filter shows the Space title and keeps the slug as the
  value.

## Shared tools accordion

`SpaceDetailModal`'s tools section is extracted to
`components/ToolsAccordion.tsx` (props: tools, default-open behavior, `single
app` mode) and reused by the Space modal, the app quick view and the app detail
page. No behavior change for the Space modal beyond the fixes above.

## Non-goals

- Converting Activity, Admin Users or Admin Activity away from tables.
- Light/dark palette changes.
- New server features. Bulk file delete reuses the existing delete endpoint
  once per file (sequentially, with a count of failures).
- Mobile app layouts beyond wrapping chips under the title below about 520px
  and collapsing actions into "..." there.

## Testing

Portal tests per component and page: ListRow, row actions (focus reveals
hover-only actions), TypedNameConfirm, undo toast (delete is sent after the
delay, Undo cancels, unmount cancels), CopyChip (copies the reference text, not
a value), ListSkeleton and empty states, ToolsAccordion (existing Space modal
tests move with it), Files (middle truncation, selection and bulk bar, sort,
filter threshold, single delete undo, bulk confirm), Vault (copy, replace link,
typed delete), Agents (client id visible, revoke confirm names it), app quick
view (opens from the tile, Manage link, Connect action), Home skeleton (no zero
flash), Admin Users (no overflow class combinations that overflow; actions
wrap), Settings theme control, the "Delegated" chip, accessible names, the
filter title. A stylesheet guard keeps rules free of shadows and capsule radii.

Prototype screenshots before pushing: Files, Vault, Agents, Apps with the quick
view, an app detail page, Home, Settings, Admin Users and Admin Spaces, in dark
and light.

## Rollout

Portal-only. No schema, API or docs-site structure change; the user guide
screenshots-free text is updated where it describes these pages.
