# Admin users and config

- "Disabled" is enforced inside the credential verifiers (`verifyApiKey`,
  `verifySession`, `verifyAccessToken`, `verifyCurlToken`) rather than at each of
  their call sites, because every call site goes through one of them: a new
  consumer cannot forget the check. Credential issuance is checked separately,
  because it does not pass through a verifier: both SSO callbacks and both OAuth
  `/token` grants refuse a disabled user. Disabling also deletes the user's
  refresh tokens, so a token they already hold cannot mint a new access token.
- A user with no row is not "disabled": `isUserDisabled` is true only for a row
  with `disabled_at` set, so tokens signed for ids the table has never seen keep
  working as before.
- `disabled_at` is a nullable timestamp, not a BOOLEAN, so it avoids the
  PostgreSQL 1/0 trap, and it records when the account was disabled.
- An admin cannot disable themselves or any email on `ADMIN_EMAILS`. Admins come
  from the env var, so this also prevents locking every admin out.
- `Registry` takes an injected `isDisabled` predicate and filters `getTool`,
  `getIntegration`, `listTools`, `listIntegrations`, `listToolsByIntegration` and
  `searchTools`. About 25 call sites read those, so filtering there beats
  patching each. The maps are private, so nothing can bypass it.
  `listAllIntegrations` is the one unfiltered view, for the admin Config tab.
- Instance settings are read from an in-memory snapshot (the registry and the
  request path are synchronous), replaced whole on every write and by a poll
  (`INSTANCE_SETTINGS_POLL_SECONDS`, default 5). Other workers and pods lag by at
  most that interval. A corrupt stored value falls back to the default for its
  key; it never throws and never disables anything.
- `disabled_integrations` is one JSON list updated read-modify-write, so two
  admins toggling different integrations within the poll interval through
  different workers can lose one update (last write wins). Admin config changes
  are rare and human-driven; per-integration rows would remove the race if it
  ever matters.
- The custom-app policy check runs before the cached index lookup in
  `ensureIndex`, so a policy change does not wait for the cache to expire, and
  `POST /api/custom-apps` refuses before it does any network discovery.
- A bodyless `POST` from the portal must not send `Content-Type: application/json`
  (the 2026-06-10 finding), so the disable, enable and revoke calls use the
  auth-only header helper.
- In a vitest `beforeEach`, `() => mock.mockReset()` returns the mock and vitest
  runs it as a teardown call; use a block body (the 2026-09-28 note).
