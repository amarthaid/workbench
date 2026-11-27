# Maker-checker implementation plan

Spec: `docs/internal/superpowers/specs/2026-11-27-maker-checker-design.md`.
Rule for every task: test first, run the package tests, commit nothing until the
whole plan is green (the user asked for one PR). Portal tests need
`NODE_OPTIONS="--localstorage-file=<tmp>"` on Node 25. PR CI does not run portal
tests: run `npx turbo test` locally before the PR (see `styles.guard.test.ts`).

## Task 1: schema and user status (server)

- `db.ts`: `approval_requests` table + partial unique index + two indexes, in
  the SQLite block and the PostgreSQL block (INTEGER vs BIGINT). Idempotent
  ALTER `users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'` in both
  migration lists, then `UPDATE users SET status='disabled' WHERE disabled_at IS
  NOT NULL AND status='active'` (run every boot, harmless).
- `auth/user-status.ts`: `getUserStatus(id)` ('active'|'pending'|'disabled'|
  'missing'); `isUserDisabled` = row exists and `status !== 'active'` (missing
  row still not blocked). `setUserStatus(id, status)` sets `status` and keeps
  `disabled_at` in step (pending and disabled set it, active clears it).
  `setUserDisabled` delegates to it and keeps its "returns changed" contract.
- `spaces/delegation.ts`: owner check reads `status`.
- `admin/users.ts` + `admin/stats.ts`: return and count by `status`; listing
  gains `status`. Keep `disabled_at` in the payload (portal compatibility).
- Tests: `tests/user-status.test.ts` (backfill, pending blocked by
  `verifyApiKey`/`verifySession`, missing row not blocked, dual write),
  extend `tests/helpers` resets for `approval_requests`.

## Task 2: approval engine

- `approvals/store.ts`: insert, get, list by requester/kind/subject,
  conditional `decide` returning changes, cancel.
- `approvals/kinds.ts`: `Kind` interface and registry; `getKind`.
- `approvals/engine.ts`: `createRequest`, `decide`, `cancel`, `inboxFor(actor)`,
  `mineFor(userId)`, `autoRejectInvalid`. Rules from the spec: maker != checker,
  conditional update arbitrates, apply in one transaction (`db.transaction` if
  present, else the single conditional statement ordering documented), audit
  rows via `auditLogger` with `actor_user_id`, non-checker lookups return null.
  Notes and messages are length-capped and stripped of control chars.
- Tests: `tests/approvals/engine.test.ts` with a fake kind: self-approval
  refused, two concurrent approves apply once, non-checker gets null, cancel
  rules, invalid subject auto-rejects, unique pending index, audit row shape.

## Task 3: account.activate

- `config.ts`: `REQUIRE_SIGNUP_APPROVAL` boolean, default false, documented in
  `.env.example` and the site config page.
- `auth/google.ts` and `auth/keycloak.ts`: new-user creation uses
  `createUserForSignup(email)` in one place (`auth/signup.ts`): pending +
  request when the setting is on and the email is not an admin email, else
  active. Existing users never change state. After resolve, status `pending`
  throws `AccountPendingError` (carries whether a prior request was rejected
  and whether 24 h passed; a re-ask opens a new request). Disabled keeps the
  existing error.
- `api/routes.ts`: both callbacks map `AccountPendingError` to the same style
  of redirect as `accountDisabledUrl()` (`/#/account-pending?declined=0|1`).
  Make sure the OAuth `/authorize` SSO resume path also stops: the callback
  throws before `resumeAuthorize`.
- Kind `account.activate`: `canDecide` = `isAdminEmail(actor.email)`;
  `apply` = `setUserStatus(subject,'active')`; `validate` = user exists and is
  still pending (disabled by an admin meanwhile: auto-reject).
- `admin/users.ts` enable/disable also close the open request (approved by
  that admin / cancelled).
- Tests: `tests/approvals/account-activate.test.ts` end to end through the
  callback with the Google exchange mocked as the existing auth tests do;
  admin email bypass; setting off keeps today's behaviour; existing user not
  moved; rejected then 24 h; callback never issues a session or auth code.

## Task 4: space.access

- Kind `space.access`: `canCreate` (space exists, visibility `users`,
  requester signed in, not owner, not already viewable, limits 5 open / 1 per
  Space), `canDecide` = actor is the Space owner, `validate` (see spec),
  `apply` = add email through the `changeShares` path used by the Sharing
  endpoint (read it first, reuse, do not write `space_shares` directly).
- `spaces/store.ts` `deleteSpace`: close that Space's open requests.
- `spaces/api.ts` list: owner items gain `pending_requests`.
- Tests: `tests/approvals/space-access.test.ts` including: private and
  missing Space look the same to the requester, org Space is a no-op answer,
  approval makes `canView` true, owner disabled auto-rejects, rate limits,
  stranger cannot decide, delegation interplay (adding a share to a delegated
  Space follows existing `changeShares` rules).

## Task 5: HTTP API

- `approvals/routes.ts`, registered where Spaces routes are, portal-session
  guard identical to the Space owner endpoints. Endpoints from the spec.
  Responses never include other people's emails beyond what the checker needs
  (requester email to the checker only). 404 for non-checkers.
- Tests: `tests/approvals/api.test.ts`, agent credential refused.

## Task 6: portal

- `portal/src/approvals-api.ts` (+ test), hooks.
- `pages/AccountPending.tsx` static route (no auth), `?declined=1` wording.
- Admin page: Approvals section with count badge.
- Spaces gallery: "Requests (n)" chip + list; SharingModal open requests.
- SpaceShell not-found state: "Ask the owner for access" with message box;
  after request shows waiting state.
- Component tests, run the full portal suite including `styles.guard.test.ts`.

## Task 7: docs and release prep

- Finding `docs/findings/2026-11-27-maker-checker.md` (the non-obvious
  decisions: pending users get no session, admin bypass, dual write, 404 vs
  request existence leak, conditional update arbitration), index line in
  `CLAUDE.md`.
- `docs/site/_content` Spaces page section and admin guide page; build docs
  site locally (`node docs/site/build.mjs`) to check links.
- `docs/releases/v0.35.0.md` operator notes (env var, new table, `status`
  column, dual write, rolling deploy note).

## Task 8: verify and release

- Full `npx turbo test` and `npx turbo build` locally; PostgreSQL integration
  with `TEST_POSTGRES_URL` (Docker postgres:16) for the new table, partial
  unique index, and the conditional update.
- Screenshots of the new UI states (user rule: prototype first), then PR,
  squash-merge when CI is green, cut `v0.35.0-rc.3` (bump package versions as
  `scripts` / `release-prep` skill says), confirm release workflow green.

## Amendments after Fable review

The spec's "Amendments after Fable review" section is binding and overrides the
tasks above. Task deltas:
- Task 1: guarded single-statement transitions; blocked = `status <> 'active'
  OR disabled_at IS NOT NULL`; `executor` parameter on the status setter; stats
  count pending separately.
- Task 2: engine passes `tx` to `apply`; no fallback wording (`db.transaction`
  exists); `Kind` interface per spec; audit after commit; Postgres
  `Promise.all` concurrency test; text sanitising helper.
- Task 3: boot guard for empty `ADMIN_EMAILS`; admin sign-in activates a
  pending admin; Keycloak `email_verified === true`; atomic user+request with
  ON CONFLICT DO NOTHING; pending cap 200; redirects `/login?error=account_
  pending|account_declined`; decide/list under `/api/admin/approvals/*`.
- Task 4: `changeShares` gets `executor`; kind writes own audit row; request
  stores Space `created_at`; fixed 202 create; rate limits per spec; delegated
  warning flag in inbox rows; `deleteSpace` closes on its tx.
- Task 5: two route groups (admin scope, portal session).
- Task 6: no AccountPending page (Login.tsx error codes); UsersTab,
  UserEmailCombobox, api.ts move to `status`; "Approve" labelling.
- Tests per the spec's list (pending coverage across every verifier).
