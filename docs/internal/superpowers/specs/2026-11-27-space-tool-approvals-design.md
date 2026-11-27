# Space tool approvals ("Always allow" / "Ask first")

Status: approved design, revised after review, not yet implemented.

## Problem

Inside a Space, a tool call runs or asks depending only on the tool's effect:

| Effect | Badge today | At call time today |
|---|---|---|
| read | Reads | runs |
| write | Writes | runs, no prompt |
| destructive (or unclassified, or missing) | Asks first | confirm modal on every call; the server refuses without `confirmed: true` (428 `CONFIRMATION_REQUIRED`) |

People cannot change this. A viewer who wants a write to ask first, or who
wants a destructive tool they use all day to stop asking, has no control. The
model people expect is the one Claude's connector settings use: each tool is
set to "Always allow" or "Ask first".

## Summary

- Every non-read tool in a Space has an approval mode: **Always allow**
  (`auto`) or **Ask first** (`ask`). Defaults are today's behavior: write =
  `auto`, destructive = `ask`. Read tools have no mode and never ask.
- **Ordinary Space** (calls run with the viewer's access): each viewer sets
  the mode per tool, on the consent screen and later in View tools. There is
  an Allow all switch per integration and one for the whole list.
- **Delegated Space** (calls run with the owner's access): the owner's own
  settings are the policy for every viewer. Viewers only approve; they see the
  mode as a read-only badge.
- When the owner of a delegated Space **loosens** a tool (Ask first to Always
  allow), each viewer approves the Space again. **Tightening** applies at once
  with no re-approval.
- Approval modes are set **only in the portal**, by a person. No MCP tool,
  agent, API key or Space page can read-write them as a side effect or set
  them directly.
- The server enforces the effective mode on every call. The shell's modal is
  the way a person gives `confirmed: true`.

## Non-goals

- A third mode such as "Never" / blocked. A tool the owner does not want used
  is removed from the Space's tool list.
- Per-argument rules ("allow only for project X").
- Changing behavior outside Spaces (MCP clients, agent calls).
- Per-viewer overrides inside a delegated Space.

## Threat model

- The confirm modal is a guard against the **Space page** (code an agent
  wrote, running in a sandboxed iframe) making calls the person did not mean.
  It is not a guard against the viewer: a viewer with a portal session can
  POST `/api/spaces/:name/call` with `confirmed: true` directly. That is
  already true for destructive tools today and stays true. "Ask first" in a
  delegated Space therefore means "the shell asks the viewer", not "the
  viewer cannot run it without the owner"; the delegation threat model
  (every declared tool, any input) is unchanged. The owner's controls are
  which tools are declared and who can open the Space.
- "Always allow" removes the human click for that tool. A Space page can then
  call it in a loop. The bound is the existing rate limits (the viewer
  bucket, and for delegated calls the owner bucket of 300/min per owner and
  Space) plus the audit log. The 5-confirmations-in-10s pause only counts
  modals, so it does not apply to auto calls.
- A redeploy that changes only the page files does not change the tool
  list, so nobody re-consents. Today the destructive modal is the one guard
  that survives a page swap. Once a viewer sets a destructive tool to Always
  allow, new page code (written by the owner's agent) can call it in a loop
  with the viewer's own access, up to the viewer's rate limit. This is the
  accepted cost of Always allow; the consent-screen copy for Allow all says
  so ("Actions run without asking you, even after this Space's page
  changes").
- An agent must not be able to grant itself silent calls. Agents write Spaces
  (`deploy_space`, `update_space`) and the Space page is agent-written code,
  so neither path may touch approval modes (see Portal only).

## Data model

New table, created with `CREATE TABLE IF NOT EXISTS` on both SQLite and
PostgreSQL. `migrate/plan.ts` (SQLite to PostgreSQL copy) lists no Space
table today, so this one is not added there either; migrating Space tables is
a separate item.

```sql
CREATE TABLE IF NOT EXISTS space_tool_approvals (
  space_name TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  tool       TEXT NOT NULL,
  mode       TEXT NOT NULL,          -- 'auto' | 'ask'
  updated_at INTEGER NOT NULL,       -- BIGINT on PostgreSQL
  PRIMARY KEY (space_name, user_id, tool)
);
```

- A row exists only when the choice differs from the tool's default. Setting
  a tool back to its default deletes the row. Read tools never have a row.
- Rows are keyed by tool name, so they survive a tool being removed from the
  list and added back.
- Deleting a Space deletes its rows in the same transaction as its consents.

`space_consents` gets one column (guarded `ALTER` on SQLite, `ADD COLUMN IF
NOT EXISTS` on PostgreSQL):

```sql
ALTER TABLE space_consents ADD COLUMN auto_tools TEXT;  -- JSON array of tool names, or NULL
```

`auto_tools` is written only for a delegated viewer: the set of non-read
tools that ran without asking on the screen they approved. It is NULL for
the owner and for viewers of ordinary Spaces (they change their own modes,
and a switch of stored mode already changes the consent hash).

**Backfill.** Existing delegated consents approved today's defaults. After
`loadPlugins()` at startup (the registry is needed for effects), one
idempotent pass sets `auto_tools` to the names of the Space's current
`write` tools for every row where `auto_tools IS NULL`, the Space's stored
`access_mode = 'owner'` and `user_id` is not the owner. Every worker may run
it; the `WHERE auto_tools IS NULL` makes the writes identical and harmless.
A row still NULL when read (a Space delegated before the pass reached it) is
read the same way. From then on a reclassification is seen against concrete
names.

## Effective mode

One function, used by the detail GET, the consent route and the call route:

```
approvalMode(space, viewer, tool):
  if effect(tool) == read           -> none (runs)
  if tool is missing or internal    -> ask (no control)
  rows   = policyRows(space, viewer)          // read once per request
  return rows[tool] ?? default(effect(tool))  // write -> auto, destructive -> ask

policyRows(space, viewer):
  source = delegatedFor(space, viewer) ? space.ownerId : viewer.userId
  SELECT tool, mode FROM space_tool_approvals WHERE space_name = ? AND user_id = source

delegatedFor(space, viewer) = space.accessMode === "owner" && viewer.userId !== space.ownerId
```

"Delegated for this viewer" uses the **stored** mode, the same thing
`consentHash` and the consent POST use, not whether delegation is in effect
right now. While delegation is stored on but not in effect (paused by a tool
change, the owner lost the permission or was disabled), calls are refused
with `DELEGATION_OFF` exactly as today, and the viewer still follows the
owner's policy: they cannot set their own modes. Only an explicit turn-off
(stored mode becomes `viewer`, which already changes the consent hash and
re-asks) gives the viewer ordinary rules. This needs no `delegationFor`
reads.

`delegable: false` tools never run for a delegated viewer (refused with
`TOOL_NOT_DELEGABLE`), so they are left out of the delegated auto set and
carry no badge for them.

**One read per request.** A request reads `policyRows` once and uses the
result for every check in it: `hasConsent` and the ask check in the call
route, the hash check and the grant in the consent POST, the tool list in
the detail GET. A policy change between two steps of one request cannot
mix old and new.

The owner's rows are the owner's own settings in every case. When delegation
is on they are also the viewers' policy. There is one list, not two.

The effect used is the tool's current effect (`effectOf`). If a plugin update
reclassifies a tool, a saved row still applies (it was an explicit choice);
a tool with no row follows its new default.

## Consent

`consentHash` (stored, and checked on every call) is unchanged: tools, mode
and owner for a viewer; tools for the owner.

Two additions:

1. **What the screen showed (delegated viewers only).** For a delegated
   viewer, the `consent_hash` the detail GET returns, and the consent POST
   must send back, also covers the screen's auto set (sorted names of the
   delegable tools whose effective mode is `auto`):
   `shownConsentHash = sha256([consentHash(space, viewer), autoSet])`.
   A policy change between loading the screen and clicking Approve gives the
   existing 409 `CONSENT_CHANGED`. Delegated viewers never change modes, so
   the hash they were given is always the one to send. For the owner and
   ordinary viewers `consent_hash` is unchanged (`consentHash` alone): their
   modes are their own and can change a second later in View tools, so
   binding consent to them protects nothing, and the portal can save
   choices and approve without computing a hash.
2. **Loosening re-asks, tightening does not.** On grant, `auto_tools` stores
   the auto set shown. `hasConsent` becomes:

   ```
   stored hash == consentHash(space, viewer)
   AND (not delegated for viewer
        OR currentAutoSet(space, viewer) is a subset of approvedAutoSet)
   ```

   where `approvedAutoSet` is `auto_tools`, or the Space's current write
   tools when `auto_tools` is still NULL (see Backfill).

   **Grant stores what was checked.** The consent POST computes the auto set
   once from its single `policyRows` read, compares the shown hash against
   it, and passes that same set to `grantConsent`. It never reads the
   policy again at insert, so a loosening that lands between the check and
   the insert is not recorded as approved.
   - Owner tightens a tool: the current set shrinks, it is still a subset,
     the change is in effect at once, nobody re-approves.
   - Owner loosens a tool: the current set has a tool the viewer never saw
     as auto, `hasConsent` is false, the call gets 403 `CONSENT_REQUIRED`
     and the portal shows the consent screen with the new badges.
   - A reclassification that makes a tool auto by default is a loosening
     and re-asks in the same way.

   For an ordinary Space and for the owner the subset check is skipped and
   `auto_tools` stays NULL.

## API

All routes below are under the existing `/api/spaces` scope, whose preHandler
accepts only `Authorization: Bearer <portal session JWT>`.

**GET `/api/spaces/:name`** (detail): each tool gains

```ts
approval?: "auto" | "ask";   // absent for read tools
approvalEditable?: boolean;  // false for delegated viewers and missing tools
```

`consent_hash` becomes the shown hash above for delegated viewers, and is
unchanged for everyone else.

**PUT `/api/spaces/:name/tool-approvals`**

```ts
body: { tools: Record<string, "auto" | "ask"> }
200:  { tools: SpaceTool[] }   // the updated list, same shape as detail
```

- One tool, or every tool at once (Allow all), in one request, applied in one
  transaction.
- 400 `INVALID_APPROVAL`: a tool not declared by the Space, a read tool, a
  missing tool, or a mode other than `auto` / `ask`. Nothing is applied.
- 403 `APPROVAL_SET_BY_OWNER`: `delegatedFor(space, caller)` (stored mode
  `owner`, caller is not the owner), whether or not delegation is in effect.
- No consent needed: the consent screen sends the choices just before the
  consent POST.
- When the caller is the owner and the stored `access_mode = owner`, the
  change is audited with a new action `SPACE_APPROVAL_CHANGE` (added to the
  `AuditEvent.action` union in `packages/shared/src/types.ts`). One row per
  request, `user_id` = owner, `integration` = `spaces`, `tool` =
  `<space>:` followed by the changes that took effect, as
  `tool=auto|ask` pairs joined by commas (tools set to the mode they already
  had are left out; no row if nothing changed). A failed audit write is
  logged and the PUT still succeeds, as with `recordDelegationChange`. The
  Activity page gets a label ("Changed which actions ask first") and the
  action filter lists it.

**POST `/api/spaces/:name/call`**: step 7 becomes

```
if approvalMode(space, viewer, tool) == ask and body.confirmed !== true
  -> 428 CONFIRMATION_REQUIRED (audited for delegated calls, as today)
```

So a write set to Ask first gets the same refusal a destructive call gets
today. Nothing else in the call route changes.

## Portal only

- `deploy_space`, `update_space`, and every other Space MCP tool get no
  approval parameter, and their results do not change. A redeploy or update
  by an agent never writes, resets or deletes approval rows.
- The PUT route is reachable only with a portal session token. MCP tokens and
  API keys are not accepted by the `/api/spaces` preHandler.
- The bridge gets no approval message. A Space page's only channel stays
  `call` with integration, tool and args; any other message type is ignored.
  The shell builds the call body itself, so a Space-supplied `confirmed`
  never reaches the server (unchanged).

## Portal UI

**Consent screen, ordinary Space (and the owner's own consent)**

- Each write or destructive row gets a segmented control on the right:
  **Always allow | Ask first**, preset to the effective mode. Read rows keep
  the Reads badge and no control. Missing tools keep their current row.
- Each integration box header gets an **Allow all** switch: on sets every
  non-read tool in the box to Always allow; off restores each tool's default
  (not "all ask"). It shows on when every non-read tool in the box is auto.
- One **Allow all** above the list does the same for every box.
- The choices are local until Approve. Approve sends the PUT (only when
  something differs from what was loaded), then the consent POST with the
  shown hash computed for the new choices.

**Consent screen copy for Allow all** (ordinary Spaces): a hint under the
top switch, "Actions run without asking you, even after this Space's page
changes."

**Consent screen, delegated viewer**

- No controls. Each non-read row has a read-only badge, **Runs without
  asking** or **Asks first**, and one line above the list: "The owner decides
  which actions ask first."
- Connection state stays hidden (unchanged).

**Running Space, View tools**

- Same controls as the consent screen; each change saves at once (PUT) and
  updates the cached detail, so the bridge uses it on the next call.
- Delegated viewer: badges only.
- Owner of a delegated Space: a note above the list, "Viewers follow these
  settings. Changing an action to Always allow asks each viewer to approve
  again."

**Sharing modal** (when Delegate my access is on): one summary line, "N
actions run without asking for viewers. Change in View tools."

**Confirm modal**: unchanged; it now also appears for writes set to Ask
first.

**Effect label**: `effectLabel` in `ToolList.tsx` returns "Asks first" for
destructive tools today. It becomes a pure effect label (Reads / Writes /
Deletes or changes), and the approval control or badge sits beside it.
`isDestructive` stops driving behavior: the bridge and the tool list read
`tool.approval` instead.

**Re-consent copy**: `SpaceShell` currently explains re-consent as "this
Space's tools changed". When a delegated viewer is asked again because the
owner loosened a tool (tool list unchanged), the screen says "The owner
changed which actions run without asking." The detail GET tells the two
apart with `reconsent_reason: "tools" | "approvals"` when the viewer had a
consent row that no longer satisfies `hasConsent`.

## Bridge

- Asks when `tool.approval === "ask"` (missing tools carry `ask`), instead of
  when the tool is destructive.
- On a 428 from a stale view it still asks and retries once (unchanged).
- On 403 `CONSENT_REQUIRED` from a loosening, the shell refetches the detail
  and shows the consent screen (existing handling).

## Edge cases

- Tool list change: the existing re-consent and delegation suspend apply.
  Saved rows are kept; new tools start at their defaults.
- Delegation paused (tool change) or blocked (owner lost the permission,
  owner disabled): stored mode is still `owner`, so calls are refused with
  `DELEGATION_OFF` as today, the owner's policy still applies to viewers and
  the PUT still refuses them. When delegation comes back, consent is checked
  against the `auto_tools` each viewer approved, so nothing approved while
  paused can widen it.
- Delegation turned off explicitly (stored mode becomes `viewer`): the
  consent hash changes and every viewer approves again under ordinary rules,
  starting from their own rows or the defaults. Turning it back on changes
  the hash again and re-asks under the owner's policy.
- A viewer removed from the share list keeps rows that can no longer be
  reached, like consents today.
- Rows survive a tool being removed and re-added, so an agent that re-adds a
  tool the owner once set to auto brings it back as auto. The tool list
  change already makes the owner re-confirm and every viewer re-consent, and
  both screens show the mode, so this is acceptable.
- Writes set to Ask first count toward the 5-confirmations-in-10s pause, so a
  Space that writes in bursts pauses once a viewer chooses Ask first. That is
  the pause doing its job.
- Integration enable/disable reaches other workers with a lag, and missing
  tools read as `ask`, so a detail GET and consent POST on different workers
  can disagree and give `CONSENT_CHANGED`. The shell already refetches and
  shows the new screen.
- The owner can set a destructive tool to Always allow for viewers of a
  delegated Space. That is the owner's call; the re-approval shows it to each
  viewer as "Runs without asking".

## Testing

Server (SQLite and PostgreSQL lanes):

- `approvalMode` matrix: owner / ordinary viewer / delegated viewer, against
  read / write / destructive / missing / non-delegable, with and without a
  row; delegation stored on but paused or blocked still uses the owner's
  rows and refuses the viewer's PUT; explicit turn-off uses the viewer's rows.
- Subset re-consent: loosen re-asks, tighten does not, NULL `auto_tools`
  counts as the write tools, reclassification to auto re-asks after the
  backfill, a viewer cannot widen their approved set while delegation is
  paused.
- Backfill: fills only delegated viewer rows with NULL, is idempotent, leaves
  owner and ordinary rows NULL.
- Grant stores the set that was checked (a loosening committed after the
  hash check is not recorded as approved).
- `reconsent_reason` is `approvals` after a loosening and `tools` after a
  tool list change.
- Call route: 428 for a write set to Ask first; a destructive set to Always
  allow runs without `confirmed`; delegated 428 is audited.
- `CONSENT_CHANGED` when the owner changes a mode between GET and POST.
- PUT: validation (400 cases, nothing applied on partial failure), 403 for a
  delegated viewer, row deleted when set back to default, one
  `SPACE_APPROVAL_CHANGE` row per request listing only real changes, none
  when nothing changed.
- Portal only: PUT with an MCP-style token is 401; `update_space` and
  `deploy_space` leave approval rows unchanged.
- Space delete removes approval rows.

Portal:

- `ToolList` controls, per-box and top-level Allow all (on and off), badges
  only for delegated viewers.
- Approve sends the PUT then the consent with the matching hash.
- View tools saves on change and updates the cached detail.
- Bridge: modal on `ask`, none on `auto`, unknown message types such as
  `setApproval` ignored.
- Sharing modal summary line.

Prototype screenshots before finishing UI work: consent (ordinary,
delegated), View tools (viewer, owner of a delegated Space), the Sharing
modal summary.

## Rollout

- Additive schema, applied at startup by `initDb()` like the earlier Space
  tables. No manual step.
- No behavior change on upgrade: every tool keeps today's mode until someone
  changes it, and no existing consent is invalidated.
