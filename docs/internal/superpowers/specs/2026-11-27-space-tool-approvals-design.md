# Space tool approvals ("Always allow" / "Ask first")

Status: approved design, pending review, not yet implemented.

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
- An agent must not be able to grant itself silent calls. Agents write Spaces
  (`deploy_space`, `update_space`) and the Space page is agent-written code,
  so neither path may touch approval modes (see Portal only).

## Data model

New table, created with `CREATE TABLE IF NOT EXISTS` on both SQLite and
PostgreSQL, and added to `migrate/plan.ts`:

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

`auto_tools` is the set of non-read tools that ran without asking on the
screen the person approved. `NULL` (every existing row) means "the defaults
at that time", read as: the Space's tools whose effect is `write`. That is
exactly what existing viewers approved, so no existing consent is
invalidated by the upgrade.

## Effective mode

One function, used by the detail GET, the consent route and the call route:

```
approvalMode(space, viewer, tool):
  if effect(tool) == read           -> none (runs)
  if tool is missing or internal    -> ask (no control)
  source = (delegated for this viewer) ? space.ownerId : viewer.userId
  row    = space_tool_approvals[space, source, tool]
  return row?.mode ?? default(effect(tool))   // write -> auto, destructive -> ask
```

"Delegated for this viewer" means the same thing it means in the call route
today: delegation is in effect (`delegationFor(space).mode === "owner"`) and
the viewer is not the owner. If delegation is off for any reason (turned off,
tools changed, owner lost the permission), the viewer's own rows apply, as in
any ordinary Space.

The owner's rows are the owner's own settings in every case. When delegation
is on they are also the viewers' policy. There is one list, not two.

The effect used is the tool's current effect (`effectOf`). If a plugin update
reclassifies a tool, a saved row still applies (it was an explicit choice);
a tool with no row follows its new default.

## Consent

`consentHash` (stored, and checked on every call) is unchanged: tools, mode
and owner for a viewer; tools for the owner.

Two additions:

1. **What the screen showed.** The `consent_hash` the detail GET returns, and
   the consent POST must send back, also covers the screen's auto set
   (sorted names of the tools whose effective mode is `auto`). It is a
   separate value from the stored hash:
   `shownConsentHash = sha256([consentHash(space, viewer), autoSet])`.
   A policy change between loading the screen and clicking Approve gives the
   existing 409 `CONSENT_CHANGED`.
2. **Loosening re-asks, tightening does not.** On grant, `auto_tools` stores
   the auto set shown. `hasConsent` becomes:

   ```
   stored hash == consentHash(space, viewer)
   AND (not delegated for viewer
        OR currentAutoSet(space, viewer) is a subset of approvedAutoSet)
   ```

   where `approvedAutoSet` is `auto_tools`, or the Space's write tools when
   `auto_tools` is NULL.
   - Owner tightens a tool: the current set shrinks, it is still a subset,
     the change is in effect at once, nobody re-approves.
   - Owner loosens a tool: the current set has a tool the viewer never saw
     as auto, `hasConsent` is false, the call gets 403 `CONSENT_REQUIRED`
     and the portal shows the consent screen with the new badges.
   - A reclassification that makes a tool auto by default is a loosening
     and re-asks in the same way.

   For an ordinary Space the viewer changes their own modes, so the subset
   check is skipped; `auto_tools` is still written, for the record.

## API

All routes below are under the existing `/api/spaces` scope, whose preHandler
accepts only `Authorization: Bearer <portal session JWT>`.

**GET `/api/spaces/:name`** (detail): each tool gains

```ts
approval?: "auto" | "ask";   // absent for read tools
approvalEditable?: boolean;  // false for delegated viewers and missing tools
```

`consent_hash` becomes the shown hash above.

**PUT `/api/spaces/:name/tool-approvals`**

```ts
body: { tools: Record<string, "auto" | "ask"> }
200:  { tools: SpaceTool[] }   // the updated list, same shape as detail
```

- One tool, or every tool at once (Allow all), in one request, applied in one
  transaction.
- 400 `INVALID_APPROVAL`: a tool not declared by the Space, a read tool, a
  missing tool, or a mode other than `auto` / `ask`. Nothing is applied.
- 403 `APPROVAL_SET_BY_OWNER`: the caller is a viewer of a Space delegated
  for them.
- No consent needed: the consent screen sends the choices just before the
  consent POST.
- When the caller is the owner and the Space is delegated (stored
  `access_mode = owner`), the change is audited as a delegation change
  (`recordDelegationChange`-style row: which tools, old and new mode), so it
  shows in the owner's Activity.

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
first. The effect label in `ToolList` stays (Reads / Writes / Deletes or
changes), with the approval control or badge beside it.

## Bridge

- Asks when `tool.approval === "ask"` (missing tools carry `ask`), instead of
  when the tool is destructive.
- On a 428 from a stale view it still asks and retries once (unchanged).
- On 403 `CONSENT_REQUIRED` from a loosening, the shell refetches the detail
  and shows the consent screen (existing handling).

## Edge cases

- Tool list change: the existing re-consent and delegation suspend apply.
  Saved rows are kept; new tools start at their defaults.
- Delegation turned off, or the owner loses the permission: viewers get the
  ordinary rules, starting from their own rows or the defaults. Turning
  delegation back on returns to the owner's policy, with the subset check
  against the `auto_tools` each viewer approved.
- A viewer removed from the share list keeps rows that can no longer be
  reached, like consents today.
- The owner can set a destructive tool to Always allow for viewers of a
  delegated Space. That is the owner's call; the re-approval shows it to each
  viewer as "Runs without asking".

## Testing

Server (SQLite and PostgreSQL lanes):

- `approvalMode` matrix: owner / ordinary viewer / delegated viewer, against
  read / write / destructive / missing, with and without a row; delegation
  off falls back to the viewer's rows.
- Subset re-consent: loosen re-asks, tighten does not, NULL `auto_tools`
  counts as the write tools, reclassification to auto re-asks.
- Call route: 428 for a write set to Ask first; a destructive set to Always
  allow runs without `confirmed`; delegated 428 is audited.
- `CONSENT_CHANGED` when the owner changes a mode between GET and POST.
- PUT: validation (400 cases, nothing applied on partial failure), 403 for a
  delegated viewer, row deleted when set back to default, audit row for the
  owner of a delegated Space.
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
