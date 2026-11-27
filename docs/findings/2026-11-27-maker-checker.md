# Maker-checker: one approval engine, and what the review changed

Two flows needed "someone asks, someone else decides": a new account
(admin decides) and access to a Space shared with specific people (owner
decides). Both run on one `approval_requests` table and a code registry of
kinds. An independent review of the design found problems that a straight
reading of the code would not have shown, and those are the part worth keeping.

## Pending users get no session

Every credential path already asks `isUserDisabled`, so "pending" became a
second reason to be blocked (`status <> 'active'`) rather than a new session
scope with a route gate. The cost is that a pending person has no session at
all: the SSO callbacks stop before a token or an OAuth authorize resume is
produced, and the login page explains the state through an error code, because
the URL hash is the session-token channel.

## Nested transactions are the trap

`db.transaction` exists on both backends but cannot be nested. On SQLite the
inner call queues behind the outer one that is waiting for it, so a decision
hangs and so does every later transaction in the process; on PostgreSQL the
inner call takes a second pooled connection and commits on its own, which breaks
the atomicity the engine exists for. So everything `apply` calls takes an
optional executor and never opens its own transaction when handed one.

## The decision is a conditional update

`UPDATE ... WHERE status = 'pending'` arbitrates two checkers, and a status
change is a single statement with a from-state guard. Without the guard, an
approve that validated before an admin disabled the user would write `active`
over the disable. SQLite serialises transactions, so a concurrency test there
proves nothing; the concurrent approve is tested on PostgreSQL.

## Rolling deploys fail closed

The new code reads `status`, an older worker still writes only `disabled_at`.
For this release blocked means `status <> 'active' OR disabled_at IS NOT NULL`,
and pending users also get `disabled_at`. An older worker's disable is honoured,
and an older worker's enable of a pending user does not unblock them. The setting
is turned on only after the rollout, because an older worker creates users active.

## Admins must never be held

A pending admin could never approve anything, so admin emails skip the gate at
creation, an admin who is pending on sign-in is activated, and the server refuses
to start with the setting on and no admins.

## Asking for access must not reveal Spaces

The request endpoint answers the same 202 whether the Space exists, is private,
is open to everyone, has no files or is already shared, and does the same limit
work for every outcome. A request stores the Space's creation time because names
are reused after a delete, and a recreated name must not inherit old requests.
Approving a Space that runs with the owner's access lends those connections, and
adding a share does not ask the owner to confirm again, so the approve row says so.

## Smaller things

The request message and decision note are capped, stripped of control and
direction characters, rendered as text and never put in an audit row. Keycloak
only refused `email_verified: false`; an absent claim could link into an existing
account by email, which would have bypassed the gate, so it now requires `true`.
