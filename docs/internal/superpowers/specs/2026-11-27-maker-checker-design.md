# Maker-checker: one approval engine for account signup and Space access

**Date:** 2026-11-27

## Problem

Two flows want "someone asks, someone else decides":

1. A person signs in with Google for the first time. Today the user row is
   created active at once. Operators want an admin to approve new accounts.
2. A person follows a link to a Space that is shared with specific people and
   they are not on the list. Today they get a 404 and must chase the owner
   out of band.

More will follow (delegate access is already an admin toggle that could become
"owner asks, admin approves"). Each should cost one registry entry, not a new
table, endpoint and inbox.

## Decisions taken with the owner of this work

- Lifecycle stays on `users`: a `status` column (`pending | active | disabled`)
  replaces `disabled_at` as the authority. Fine-grained powers stay in
  `user_permissions`. They are two concepts and stay two.
- `account.activate` is decided by an admin only (`isAdminEmail`, the
  `ADMIN_EMAILS` list; there is no `users.is_admin` in use).
- `space.access` is decided by the Space owner only.
- In-app only. No email, no Slack.
- Signup approval is a setting, default off.

## Core: one table, a registry of kinds

```
approval_requests
  id TEXT PK
  kind TEXT            -- 'account.activate' | 'space.access'
  subject TEXT         -- user id | space name
  requester_id TEXT
  message TEXT         -- requester's note, <= 280 chars, may be ''
  status TEXT          -- pending | approved | rejected | cancelled
  decided_by TEXT, decided_at BIGINT, decision_note TEXT
  created_at BIGINT
unique (kind, subject, requester_id) WHERE status = 'pending'
index on (kind, subject, status), (requester_id, status)
```

`approvals/kinds.ts` is a code registry like `CAPABILITIES`. A kind defines:

- `canCreate(requester, subject)`: may this person open one (also resolves the
  subject and says "already done" when the request is a no-op).
- `checkers(request)`: who may decide. A predicate `canDecide(actor, request)`.
- `validate(request)`: still meaningful at decision time (subject exists, owner
  enabled). If not, the engine auto-rejects with a reason instead of applying.
- `apply(request, tx)`: the effect of approve.
- `describe(request)`: one line for lists and audit.

The engine (`approvals/engine.ts`) owns every rule that must not vary by kind:

- Maker cannot be checker (`actor.userId !== request.requester_id`), checked
  after `canDecide`.
- A decision is a conditional update:
  `UPDATE approval_requests SET status=?, ... WHERE id=? AND status='pending'`.
  Zero changes means someone else decided first: return the current state, do
  not run `apply`. `apply` and the status change run in one transaction.
- A non-checker asking about a request id gets 404, never 403.
- Every decision (and every create) writes an `audit_log` row: `user_id` is the
  maker, `actor_user_id` is the checker, same labelling as delegated calls.
- Cancel: only the requester, only while pending.

## Account activation

- `users.status` TEXT NOT NULL DEFAULT 'active'. Backfill: `disabled` where
  `disabled_at IS NOT NULL`. Idempotent ALTER in the migration list, both
  dialects.
- `isUserDisabled` (used by sessions, API keys, curl sessions, OAuth tokens,
  refresh, Keycloak, `/mcp`) becomes `status !== 'active'`. Every existing
  enforcement site is unchanged, and a pending user is blocked everywhere
  without a new session scope or route gate.
- Pending users get **no session**. The Google and Keycloak callbacks look at
  the status after resolving the user. `pending` redirects to a static portal
  page (`/#/account-pending`, like the existing account-disabled redirect), and
  `OAuth resumeAuthorize` is never reached for them. The page needs no
  authentication and shows no data, only a fixed message.
- Creation: a new Google or Keycloak user is created `pending` only when
  `REQUIRE_SIGNUP_APPROVAL` is on **and** the email is not in `ADMIN_EMAILS`
  (admins must always be able to sign in, or nobody can approve anything). An
  `account.activate` request is created in the same step. An existing user is
  never moved to pending by turning the setting on.
- Repeat sign-in while pending: no duplicate (the unique index), same page.
  After a rejection, a sign-in more than 24 hours later opens a fresh request;
  sooner shows the page with "declined" wording. The rejection note is not put
  in the URL.
- Approve: `status='active'`, clear `disabled_at`. Reject: stays `pending`
  (blocked) with the request `rejected`.
- Admin disable/enable (`admin/users.ts`) set `status` too. Enabling a pending
  user directly is allowed and closes any open request as approved by that
  admin. Disabling a pending user is allowed.
- Rolling deploy: while the old version runs on some workers it only reads
  `disabled_at`. Pending users therefore also get `disabled_at = now` (dual
  write). `disabled_at` stays for one release, a later change drops it. Admin
  list and stats read `status`.
- `spaces/delegation.ts` owner check reads `status`, not `disabled_at`.

## Space access

- Only for `visibility = 'users'`. `org` Spaces are already open to everyone
  signed in. `private` Spaces keep answering 404 and offer no request path, so
  existence does not leak.
- The shell route that answers 404 today does not change for strangers. A
  signed-in person who is not on the list calls
  `POST /api/approvals {kind:'space.access', subject:name, message?}`. The
  server answers 404 for a Space that does not exist or is private, and for a
  `users` Space creates the request. This means the existence of a `users`
  Space is learnable by a signed-in person who guesses the name; that is the
  accepted cost of a request button, and the name rules already make names
  public in links. Rate limit: 5 open requests per requester, 1 per Space.
- Portal: the SpaceShell "not found" state gets a "Ask the owner for access"
  action (the portal cannot tell not-found from not-shared, and does not need
  to: the POST answers).
- Approve: add the requester's email to `space_shares` through the existing
  `changeShares` path (not a second writer), so share-list rules, audit and
  delegation suspension stay in one place. Idempotent.
- Auto-reject (`validate` fails): Space deleted, visibility no longer `users`
  (becoming `org` makes it moot, `private` closes it), owner disabled/deleted,
  requester already on the list (reported as approved-no-op "you already have
  access", never as an error).
- `deleteSpace` closes open requests for that Space.
- Checker: the owner only. Admins have no path (decided).

## API

All portal-session only; agent credentials cannot call these (same guard as the
Space owner endpoints).

- `GET /api/approvals?scope=mine|inbox`. `inbox` is requests I may decide:
  `account.activate` for admins, `space.access` for Spaces I own. Includes
  `status`, `kind`, `subject_label`, `requester_email`, `message`, `created_at`.
- `POST /api/approvals` (create; `account.activate` is server-created, a client
  asking for it gets 400).
- `POST /api/approvals/:id/approve`, `/reject` `{note?}`, `DELETE /api/approvals/:id`.
- The gallery list item for an owned Space gains `pending_requests` (count).
- `GET /api/admin/approvals/count` is not needed: `inbox` carries the count.

## Portal

- Pending page (static route, no auth): fixed text, sign-out not needed.
- Admin page: "Approvals" section with count badge, Approve/Reject rows.
- Spaces gallery: "Requests (n)" chip for owners, list with Approve/Reject;
  SharingModal shows open requests for that Space.
- SpaceShell not-found: "Ask the owner for access" with optional message.
- Requester sees state ("Requested, waiting") when they revisit the link.
- Styles obey `styles.guard.test.ts` (no `--radius-full`, no `box-shadow`).

## Not in v1

Delegate-access as a kind, expiry of stale requests (except the owner-gone
auto-reject), a capability for non-admin checkers, outbound notification,
admin fallback for a missing owner.

## Rollout

RC tag (schema change). `REQUIRE_SIGNUP_APPROVAL` off by default, so behaviour
does not change until an admin turns it on. Docs: a finding, the Spaces page,
the admin guide, `docs/releases/v0.35.0.md` (or the next stable) operator note
with the new env var and the `disabled_at` dual write.

## Amendments after Fable review (these supersede the text above)

Blockers
- **Transactions.** `db.transaction` exists on both dialects but nesting is not
  safe: on SQLite an inner transaction queues behind the outer one and hangs; on
  PostgreSQL it takes a second pooled connection and commits on its own. So
  every function `apply` calls takes an optional `executor: DbExecutor = db`
  (pattern: `auth/oauth-server/refresh.ts`) and never opens its own transaction
  when handed one. `changeShares` and the status setter get that parameter.
  Audit rows are written after commit. `changeShares` only does the owner check,
  insert and non-empty rule: email validation and delegation checks live in the
  route, so the kind writes its own audit row.
- **Guarded transitions.** Status changes are single statements with a
  from-state guard: approve is
  `UPDATE users SET status='active', disabled_at=NULL WHERE id=? AND status='pending'`;
  zero changes means the request is closed as auto-rejected and nothing is
  applied (an admin disabled the user between validate and apply).
- **Fail closed during the dual-write release.** Blocked means
  `status <> 'active' OR disabled_at IS NOT NULL`, in `isUserDisabled` and in
  the delegation owner check. An old worker's disable (writes `disabled_at`
  only) is therefore still honoured. An old worker's enable of a pending or
  disabled user stays blocked (fail closed). Operator note:
  `REQUIRE_SIGNUP_APPROVAL` is turned on only after the rollout completes.
  Drop the second clause in the release that drops `disabled_at`.
- **Admin bootstrap.** On every sign-in, an admin email that is `pending` is
  activated and its request closed (covers "added to ADMIN_EMAILS later").
  `REQUIRE_SIGNUP_APPROVAL=true` with empty `ADMIN_EMAILS` is refused at boot
  (config validation error), not silently stranding every signup.

Important
- **Redirect.** The pending/declined message reuses the login page:
  `/login?error=account_pending` or `account_declined` on `PORTAL_URL`, like
  `account_disabled` (the URL hash is the session-token channel, so no
  `/#/account-pending`). No new unauthenticated route or page.
- **Keycloak** must require `email_verified === true` (it only rejected
  `false`), else an absent claim links by email into an existing account.
- **Atomic creation.** New user + `account.activate` request in one
  transaction; request insert uses `ON CONFLICT (kind, subject, requester_id)
  WHERE status='pending' DO NOTHING`. Every pending sign-in ensures a request
  exists (self-heals a missing one) instead of assuming creation made it.
- **Spam.** `space.access`: max 3 requests per (requester, Space) per 24 h
  counting rejected and cancelled, 20 per requester per 24 h, 5 open. Signup:
  cap pending `account.activate` at 200 (beyond it the user sees the pending
  message and nothing is created); inbox is paginated; the admin Users list
  defaults to non-pending. Admin UI states that Disable is the permanent no.
- **Decisions stay inside the admin gate.** `account.activate` list and
  decide live under `/api/admin/approvals/*` in `adminScope` (email read from
  the DB, session only, an admin's API key or OAuth token gets 401).
  `/api/approvals/*` serves `space.access` and "mine" only and refuses
  `account.activate` rows.
- **Space name reuse.** The request stores the Space `created_at` in
  `payload`; `validate` and the owner inbox compare it, so a recreated name
  never inherits old requests. `deleteSpace` closes requests inside its own
  transaction (executor param). Inboxes list pending only.
- **Existence parity.** `POST /api/approvals` for `space.access` always answers
  202 with one fixed body (`{accepted:true}`) whether the Space exists, is
  private, is `org`, has no files, or is already shared, and does the same
  rate-limit work in the same order for every outcome (429 may be returned
  because limits are per requester, independent of the Space). A real request
  is created only for an existing `users` Space with files where the requester
  is not owner and not on the list. The earlier "accepted leak" is removed.
  The portal shows "If this Space exists and was shared by link, the owner has
  been asked" and tracks waiting state locally.
- **Kind interface** is therefore: `clientCreatable`, `canCreate`, `inboxFor
  (actor)` (listable filter), `canDecide`, `validate -> ok | moot | invalid
  (reason)` (moot = already satisfied, reported as approved no-op), `apply
  (request, tx)`, `describe`, `subjectLabel`. "One registry entry per new kind"
  means that entry plus its domain hooks and portal row.
- **Delegated Spaces.** Approving an owner-mode (delegated) Space lends the
  owner's connections to the requester without a re-confirm (only audience
  widening is checked today). The approve row says so when `accessMode ===
  'owner'`.
- **Portal readers of `disabled_at`/`account_disabled`**
  (`components/admin/UsersTab.tsx`, `UserEmailCombobox.tsx`, `src/api.ts`,
  `pages/Login.tsx`) move to `status`; pending users get a distinct badge and
  the action is labelled "Approve", not "Enable".
- **Stats**: pending counted separately from disabled.

Nits taken
- Cut the auto-reject sweep: validate at decide only; requester may cancel;
  requests on dead Spaces do not count toward the open cap.
- `message` and `decision_note`: capped, control and bidi/format characters
  stripped, rendered as text only, never placed in the audit `tool` string or
  `describe()`.
- Setting is the env var `REQUIRE_SIGNUP_APPROVAL` only (instance settings lag
  across workers). Timestamps are seconds (as `users`, `user_permissions`),
  read through `Number()`.
- Maker != checker stays as a one-line check (vacuous for v1 kinds).

Tests added by the review
- Concurrent approve with `Promise.all` in the PostgreSQL integration suite,
  asserting `apply` ran once; real `space.access` approve on SQLite (catches
  the nested transaction hang) and a PostgreSQL rollback test when `apply`
  throws.
- Pending coverage: `verifyApiKey`, `verifySession`, access-token verifier,
  curl-session verifier, both `/token` grants (code issued before pending),
  `/authorize/resume`, and a callback with `.ticket` issues no code and
  consumes no ticket. Row with `disabled_at` set and `status='active'` is
  blocked. Keycloak absent `email_verified` refused. Admin API key gets 401 on
  `/api/admin/approvals/*`.
