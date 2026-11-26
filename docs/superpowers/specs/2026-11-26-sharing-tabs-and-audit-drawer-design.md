# Sharing tabs and the audit detail drawer

## Problem

Two screens feel unfinished since delegated access shipped (v0.34).

1. **Sharing dialog.** "Delegate my access" sits at the bottom, under the
   audience choice and the people list. Turning it on opens a long warning with
   the full tool list, then a confirm step that shows the same list again. Once
   it is on, the dialog says nothing about it: no status, no reminder of what
   is lent. When an admin removes the permission, the owner still sees a switch
   they cannot use.
2. **Audit trail.** The personal Activity page and the admin Activity card show
   one flat table. Errors are cut to one line, there is no date range, no way
   to find delegated calls or one Space, and the admin table lacks the duration
   and delegation line the personal one has. Admin arguments and results open in
   a modal that hides the table.

Mocks for both were reviewed in a browser and approved
(`sharing-mock/c.html`, `sharing-mock/audit.html`, kept outside the repo).

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Where delegation lives in the dialog | Its own first tab, **Access**. Audience and people stay on a second tab, **People**. |
| 2 | Tab labels | Carry state: Access shows `On`, `Paused`, `Not saved`; People shows the count, `Only me` or `Everyone`. |
| 3 | Owner without the delegate permission | **No tabs at all**: the dialog is the People view only. The portal is told via `delegation_blocked`; calls are already refused server side. The stored setting is not rewritten by merely opening or saving people. Exceptions, both explicit: the owner turns it off, or widens the audience while blocked (see Server). |
| 4 | Admin allows it again | The stored setting applies again, as stored. The tool-change pause still applies on top of it. |
| 5 | Button text | `Review and delegate` whenever Save leads to the confirm step; `Save` otherwise. The confirm step itself is unchanged. |
| 6 | Audit additions | Filter bar and a detail drawer, in both views. |
| 7 | Admin email search | Autocomplete from one fetch of the user list, filtered in the browser. No request per keystroke. |
| 8 | Other person's origin | On the personal page, a call someone else made through your Space shows no IP address or browser. Withheld by the server, not only hidden by the page. |
| 9 | Space filter | A searchable combobox, not a dropdown, in both views. Admin gets a small new endpoint to search all Spaces (the list can be huge). |
| 10 | People on delegated rows | Personal table shows the other person inline, under the app and tool, in the same cell. No new column. Personal page also gets a Person filter. |
| 11 | Filters | Date range outside, everything else in a Filters popover; edits are a draft, Apply commits. |
| 12 | Date cap | 90 days, applied when the caller sends a range. Admin range queries need a `created_at` index, so this is an RC release. |

## Sharing dialog

### Behaviour

- Opens on **Access**. A tab badge is derived from the same fields the dialog
  reads today (`delegate_access`, `delegation_suspended`, `can_delegate`, the
  chosen audience), so no state is invented.
- **Off:** says whose access viewers use ("their own") and what turning it on
  would lend (tool and app count).
- **On, saved:** a status line and the lent tools, grouped by app. This is the
  status view that does not exist today.
- **Turning on / widening:** badge `Not saved`, the warning and tool list as
  today, primary button `Review and delegate`, then the existing confirm step.
- **Paused:** `Confirm tools` button inside the tab, as today.
- **Only me:** the switch is disabled with a link that jumps to People. Picking
  Only me while delegation is on still turns it off on save, as today.
- **No permission:** no tab strip. If the stored mode is owner, one muted line
  says delegation is off because an admin removed the permission, with a
  "Turn off" button so the owner can still clear the stored setting (kept from
  today).

### Server: tell the portal the permission is missing

`GET /api/spaces`, `GET /api/spaces/:name` and the PATCH response keep
`delegate_access` **as stored** (the MCP Space tools already define
`delegate_access` as stored and `delegation_active` as in effect, so one name
keeps one meaning). They add, for the owner's own Spaces only:

- `delegation_blocked: "no_permission"` when stored mode is owner and the owner
  lacks `spaces.delegate_access`; absent otherwise. Never sent to a viewer.
- Read the permission once per request, not once per Space (`can()` is
  uncached).

The portal hides the tabs on `delegation_blocked` and derives `wasOn`,
`widening` and the turn-off payload from stored `delegate_access` exactly as
today, so "turn it off" and the widening review keep working.

Server rule that closes the gap the review found: a PATCH that widens the
audience (private to people or org, people to org) while `access_mode` is owner
and the owner lacks the permission **turns the stored mode off** and records it
as a delegation change with the reason "audience widened without permission".
Otherwise an admin re-allow would lend the owner's access to the wider audience
unreviewed. A PATCH that only edits people without widening changes nothing
stored, so a re-allow still restores delegation as stored (decision 4).

Enabling stays refused without the permission (`mayEnableDelegation`).

### Deferred: confirmed date and "New" tool marker

The mocks show "Confirmed 12 Nov" and a `New` badge on a changed tool. Neither
exists in storage: `spaces` keeps only `delegated_tools_hash`. Both need a new
column (confirmed-at, confirmed tool names), which makes this an RC release by
the rule in `CLAUDE.md`. **Out of this change.** The Active and Paused views
ship without them.

## Audit trail

### Filter bar and Filters popover (both views)

The head of the table keeps only what changes most: **All / Errors**, the
**date range** (24 h, 7 days, 30 days, custom) and one **Filters** button with a
count badge of active filters. Everything else is in a popover opened from that
button (`role="dialog"`, anchored right, 360 px):

- Fields: App, Space, Person (personal page) or User (admin page), Credential,
  and Delegated calls only.
- **Apply to commit.** Edits are a draft; one Apply sends one request. Reset
  clears the draft; Esc or a click outside closes without applying. Picking a
  person in the draft turns Delegated only on.
- The date range and All / Errors apply at once, as today.
- A "Showing:" line of chips sits under the bar. Each chip clears one filter,
  Clear all appears when any filter is active.
- Person and Space names inside a row are links that apply that filter at
  once, without opening the popover.

Filters and query parameters:

| Filter | Query parameter | Matches |
|---|---|---|
| Date range: 24 h, 7 days, 30 days, custom | `since`, `until` (unix seconds) | `created_at` |
| Delegated only | `delegated=1` | `actor_user_id IS NOT NULL` |
| Space | `space=<name>` | `client_name = 'space:<name>'` (a name self-declared at OAuth registration can mimic this prefix; true today, noted) |
| Person (personal page only) | `person=<email>` | the other party on a delegated row |
| Credential | `auth=api_key\|oauth\|session\|curl_token\|space` | `auth_method`; `space` is the `space:` client prefix and the other values exclude it |

The UI sends `since` for the last 7 days by default. When a caller sends
`since` (and optionally `until`, default now), the server **caps the range at 90
days** and returns 400 beyond that. A caller that sends no `since` keeps
today's behaviour (newest first, limited, keyset paged): the home cards, agents
and existing tests do this. Unknown values for `space`, `auth`, `status` or
`delegated` are refused with 400 on both endpoints. Changing any filter resets
paging, as the integration filter does.

Applies to `listAuditEvents` (personal: `user_id = ? OR actor_user_id = ?`) and
`listAllAuditEvents` (admin). The credential list is fixed (named OAuth clients
are not a v1 filter). The Space filter is a combobox (see below).

### People on delegated rows (personal page)

- A delegated row shows the other person at once, as a second muted line in the
  Tool cell, under the tool name: Delegated badge, "Used by dev@example.com"
  when someone ran a call on your access, "On access of dev@example.com" when
  you used someone else's, then the Space name. Person and Space are links that
  filter. No new column.
- A call made through a Space on the caller's own access shows only
  "via Space <name>" (link), no badge.
- Admin view: the User column stays whose access ran the call; a delegated row
  adds "Run by <email> · <Space>" under the tool, email links to the User
  filter.
- The drawer repeats it in its Delegated access block.

### Person filter (personal page)

- Filters delegated rows by the other person's email: `person=<email>`, exact,
  case-insensitive. Server match uses the same `COALESCE(users.email, recorded
  email)` the rows display (`query.ts` list and admin filter), so an email
  change does not strand a suggestion: `(actor_user_id = me AND <owner email> = ?)`
  or `(user_id = me AND <actor email> = ?)`. Always inside your own rows, so it never
  reaches another person's data.
- Suggestions come from a small `GET /api/activity/people` for the current date
  range: distinct other parties on your delegated rows, max 50, with counts.
  Fetched once per date range, cached, filtered in the browser. **Zero requests
  while typing**, same as the admin email box. Same combobox behaviour.
- Picking one sets `person`; combines with Space and Delegated only. Picking
  a person implies Delegated only, so the toggle turns on.
- Admin view keeps its email box (the user whose access ran the calls), now in
  the popover.

### Space search (both views)

One `SpaceCombobox` component, two sources:

- **Personal page:** the Spaces the user already has from `fetchSpaces` (owned
  and shared with them), filtered in the browser. Zero extra requests.
- **Admin:** new `GET /api/admin/spaces?q=<text>&limit=20`, admin permission
  only. Returns `{ spaces: [{ name, title, owner_email }], has_more }`,
  sorted by name. The list can be huge, so it is **not** loaded whole.

Admin search rules, to keep the database quiet:

- No request until at least 2 characters, and 250 ms after the last keystroke.
- A newer keystroke aborts the request still in flight.
- Results are cached per query string (React Query, long `staleTime`), so
  backspacing or reopening costs nothing.
- Server: `limit` max 20, `q` max 64 characters. Name prefix is a range
  (`name >= q AND name < q || high`, on the unique index, case-folded the same
  on both backends); title is `LOWER(title) LIKE ? ESCAPE '\\'` with `%` and
  `_` escaped, read from the small `spaces` table under `LIMIT`. Prefix hits
  sort first. No `total_matches` (a count would scan); `has_more` instead.
- Empty box on open shows nothing to fetch; an empty-state hint says "Type 2 or
  more characters".
- Picking a result sets the draft; the activity query changes only on Apply.
  Typing never touches the audit table.

Same keyboard and ARIA behaviour as the email combobox (`role="combobox"`,
`aria-activedescendant`, Up/Down/Enter/Esc).

### Detail drawer

Row click opens a right drawer; Esc, the scrim and Close dismiss it; arrow keys
and Newer / Older move between rows already loaded.

- **Call:** when, app, tool, duration, status, full error text.
- **Delegated access** (delegated rows): whose access, who ran it, Space.
- **Origin:** credential type, client name, IP address, user agent.
- **Admin only: arguments and result.** Shown after an explicit "Show" click
  because every read of captured payload is audited today; the drawer replaces
  the modal and keeps that behaviour and the existing endpoint.

The personal endpoint adds `auth_method`, `client_name`, `source_ip`,
`user_agent` per event, **except** on a delegated row where the reader is the
owner (`for_me`): those four are returned as null (decision 8).

### Admin email autocomplete

- One `GET /api/admin/users` (already capped at 500, returns `total`) through
  React Query with a long `staleTime`. Opening the box uses the cache;
  typing filters in memory. **Zero requests while typing.**
- The activity query changes only when a suggestion is picked or a full address
  is submitted with Enter. The existing 300 ms debounce on the draft email goes
  away with the free-text path.
- Suggestions show the email, last activity, and a Disabled badge.
- If `total > 500`, or nothing matches, the box says so and accepts a full
  address with Enter. The server's exact, case-insensitive email match is
  unchanged, which also reaches users who were since deleted.
- Combobox semantics (`role="combobox"`, `aria-activedescendant`), Up/Down/
  Enter/Esc. Keys in the box must not trigger the drawer shortcuts.

### Database load

- **Personal:** the `user_id = ? OR actor_user_id = ?` scope uses
  `idx_audit_user` and `idx_audit_actor_nn`; date bounds and the new filters
  apply inside it (checked with `EXPLAIN QUERY PLAN` on SQLite; run the same on
  PostgreSQL before release).
- **Admin:** no index leads on `created_at` today, so a `since`/`until` query
  scans the table and sorts. Add `idx_audit_created ON audit_log (created_at, id)`.
  That is a schema change, so this ships as a release candidate (`CLAUDE.md`).
  `space` and `auth` then filter inside the date window.
- The email autocomplete adds no queries per keystroke.
- The admin Space search adds at most one small, limited query per typing
  pause, over the `spaces` table only.

## Out of scope

Non-tool events in the trail, summary strip and CSV export (not chosen),
multi-user email filter, named OAuth client filter, confirmed date and `New`
marker (above), changing the confirm step.

## Open questions

None. Resolved: 90-day cap confirmed; admin Space search endpoint plus combobox (decision 9).

## Testing

Existing suites extend: `SharingModal.test.tsx`, `Activity.test.tsx`,
`ActivityCard.test.tsx`, `spaces-api.test.ts`, server audit and spaces API
tests. Specific cases: no tabs without permission; stored mode untouched after a
People-only save, turned off when widening while blocked; a for_me row returns null origin fields; range over 90 days
rejected; no request fires while typing in the email box.

## Release

One new index (`idx_audit_created`), so a release candidate: `vX.Y.Z-rc.N`, soak, then
promote. Notes live under the stable name in `docs/releases/`. Synthetic data only (`example.com`).
