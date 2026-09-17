# User vault

_2026-09-16_

## Problem

An agent that has to log into a website, sign a webhook, or hand a database
password to a script has exactly one way to get the value: a human pastes it
into the conversation. From that moment the secret is in the prompt, in the
session transcript on disk, in the model provider's request logs, and in every
later turn's context. It never leaves.

Workbench already keeps OAuth tokens, cookie jars and API keys encrypted at
rest and injects them into outbound requests without the agent ever seeing
them (`packages/server/src/plugins/context.ts`). That protection stops at the
integration boundary. A password for a site with no OAuth, an SSH passphrase, a
third-party API key that no plugin knows about — none of these has a place to
live, so they live in chat.

## Goal

A per-user store of named secrets that the agent can **use** but never
**read**.

- The human writes secrets in the portal. The agent cannot.
- The agent references a secret by name inside any tool's arguments, and the
  server substitutes the value after the arguments leave the model and before
  the handler runs.
- Anything a tool returns that contains a substituted value is scrubbed back
  to the reference before it re-enters the model's context.
- When the value is needed *outside* workbench — a local script, an `.env`
  file, a CI job — the agent mints a one-time URL and tells the host to fetch
  it straight to disk. The URL is spent on first read.

Threat model, stated plainly: the adversary is **accidental exposure to the
model and its transcripts**, not a hostile agent. The agent is the user's own,
running against the user's own vault, and is trusted to use any secret in any
tool. There is no per-secret ACL. What the design prevents is the value
appearing in text the model produces or consumes.

## Non-goals

- Agent-side writes (`vault_set`, `vault_generate`). Portal only.
- Per-secret tool allowlists, sharing between users, admin visibility.
- Encryption-key rotation. Nothing else in the server has it either; the vault
  reuses `auth/encryption.ts` and inherits whatever rotation story is built
  later.
- Reveal in the portal. The store is write-only from every surface. To rotate,
  overwrite.
- Secrets larger than a few KB. This is passwords and API keys, not
  certificates or files — the workspace already covers those.

## Design

### Storage

New table, both dialects in `packages/server/src/db.ts`, plus an entry in
`migrate/plan.ts` `TABLES` so the SQLite→Postgres mover copies it.

```sql
CREATE TABLE IF NOT EXISTS user_vaults (
  id           TEXT PRIMARY KEY,           -- uuid
  user_id      TEXT NOT NULL,              -- FK users(id) ON DELETE CASCADE
  name         TEXT NOT NULL,
  value_enc    BLOB NOT NULL,              -- BYTEA on Postgres
  description  TEXT,
  created_at   INTEGER DEFAULT (unixepoch()),
  updated_at   INTEGER DEFAULT (unixepoch()),
  last_used_at INTEGER,
  UNIQUE(user_id, name)
);
```

- `name` matches `^[a-z0-9][a-z0-9_.-]{0,63}$`. Lowercase, no spaces, so a
  reference never needs quoting or escaping. Validated on write and on
  reference.
- `value_enc` is `encrypt(value)` from `auth/encryption.ts`: AES-256-GCM,
  `iv | tag | ciphertext`, keyed by `ENCRYPTION_KEY`. Same envelope the token
  store uses.
- `value` is limited to 8 KB of UTF-8 (`VAULT_MAX_VALUE_BYTES`, not
  configurable in v1). Empty string rejected.
- `last_used_at` is bumped on every substitution and every one-time-URL
  redemption. It is what lets the portal show "used 3 minutes ago" without
  storing the value anywhere else.

Module: `packages/server/src/vault/store.ts` — `putSecret`, `deleteSecret`,
`listSecrets` (never returns the value), `readSecretValue(userId, name)` (the
only function that decrypts; called by the interpolator and the OTL redeemer,
nothing else). Errors are typed: `INVALID_NAME`, `NOT_FOUND`, `TOO_LARGE`.

### Portal

- Route `/vault`, page `packages/portal/src/pages/Vault.tsx`, modelled on
  `pages/Files.tsx` (same `PageHeader` / `DataTable` / `Modal` kit, React
  Query inline, no hooks file).
- Table columns: name, description, updated, last used. Row actions:
  overwrite, delete.
- "Add secret" modal: name, description, value (`<input type="password">`,
  with a show/hide toggle that only affects the field the human is typing
  into). Overwrite reuses the modal with name locked.
- No reveal, no copy button. The list endpoint physically cannot return the
  value.

REST. `GET` accepts any bearer — API key, OAuth access token, or portal
session — via the same `authenticate` helper the workspace routes use
(`workspace/routes.ts:46`), so the agent can call `list` over REST too.
`PUT` and `DELETE` require a **portal session**: `verifySession` on the bearer,
`403 PORTAL_SESSION_REQUIRED` otherwise. The agent's own credential must not be
able to rotate a secret to a value it chose (and then read that back) or wipe
the vault — that is the Goal read from the write side:

| Method   | Path                    | Body / result                                  |
|----------|-------------------------|------------------------------------------------|
| `GET`    | `/api/vault`            | `[{name, description, created_at, updated_at, last_used_at}]` |
| `PUT`    | `/api/vault/:name`      | `{value, description?}` → 201 create / 200 overwrite |
| `DELETE` | `/api/vault/:name`      | 204; also revokes outstanding one-time URLs for it |
| `GET`    | `/api/vault/otl/:token` | **unauthenticated**, see below                 |

`PUT` is the only route that carries a plaintext value, and it is only ever
called by the portal — now enforced, not just expected. The pino `req.body` is not logged today; the route adds
nothing that would change that.

### MCP tools

Internal plugin `vault` (`packages/server/src/plugins/internal/vault.ts`),
registered in `loader.ts` next to `files`, `auth.type: "none"`.

**`vault_list()`** → `{ secrets: [{ name, description, updated_at,
last_used_at }] }`. Description tells the agent how to reference a secret and
that it will never see a value.

**`vault_presign({ name, ttl_seconds? })`** → `{ url, expires_at }`.

- Default TTL 120 s, max 600 s.
- Mints a 32-hex opaque token, stored as a `pending_auth` row under sentinel
  `integration = '__vault_otl__'` with `session_data = {"name": …}`, exactly the
  shape `workspace/presign.ts` uses for uploads. Module
  `packages/server/src/vault/otl.ts`, mirroring that file: `mintOtl`,
  `consumeOtl`, `revokeFor(userId, name)`, `reapExpiredOtl`.
- **Single use is arbitrated by the `DELETE`** (`changes === 1`), not the
  `SELECT`. Two concurrent fetches: one gets the value, the other gets 404.
  Atomic on both backends, no transaction — the property the jot-upload
  finding established.
- Redeem: `GET /api/vault/otl/:token` responds `200 text/plain; charset=utf-8`
  with the raw value as the body, headers `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`. Spent,
  expired or unknown token → 404 with an empty body, indistinguishable from
  each other.
- The tool description is the guard rail: *fetch the URL from where the bytes
  are needed, write it straight to a file or a variable, never echo it. The
  URL works exactly once; if your fetch fails, mint another.* The description
  also gives the idiom:
  `curl -fsS "$URL" -o ./secret.txt` / `TOKEN=$(curl -fsS "$URL")`.

**`vault_*` tools are exempt from interpolation.** A reference inside their
own args is passed through literally (a name is not a value).

### Interpolation

Reference syntax: `{{vault:NAME}}`. Whole string may be the reference, or it
may be embedded (`Bearer {{vault:gh_token}}`), and one string may hold several.

Implementation: `packages/server/src/vault/interpolate.ts`, called at the top
of `executeSingle` in `mcp/meta-tools.ts` — **before** `safeParse`, so the
substituted value still goes through the tool's own zod coercion and
validation, and so every caller (MCP `execute_tools`, batch `executeMany`,
`POST /rest/:integration`) is covered by one line.

```
resolveVaultRefs(userId, rawArgs) → { args, substituted: Map<name, value> }
```

- Walks the args recursively: objects, arrays, strings. Numbers, booleans,
  null untouched. Only string *values* are scanned; keys are not.
- Regex `\{\{vault:([a-z0-9][a-z0-9_.-]{0,63})\}\}`. A `{{vault:…}}` that does
  not match the name grammar is left alone and will fail the tool's own
  schema or the upstream API, which is the right place for garbage to fail.
- Every referenced name is looked up once. Unknown name → `executeSingle`
  returns `{ error: "VAULT_SECRET_NOT_FOUND", message: "No secret named 'x'.
  Call vault_list." }` and audits `success:false, error:"VAULT_SECRET_NOT_FOUND"`.
  The handler does not run.
- Substitution happens on a deep copy; the caller's `rawArgs` is never
  mutated, so the original (reference-bearing) args are what any later log
  line or error path sees.
- `last_used_at` bumped for each distinct name, fire-and-forget after the
  handler starts.

### Scrubbing

Every substituted value is a needle; the tool result is the haystack.

```
scrubVaultValues(result, substituted) → result'
```

- Run in `executeSingle` on the success path *and* on the caught-error message
  before either reaches the audit log, the `console.log` line, or the return
  value.
- Result is JSON-stringified, each plaintext value replaced by its
  `{{vault:NAME}}` reference (longest value first, so a value that is a
  substring of another is handled), then parsed back. If the result is not
  JSON-serialisable it is left alone — that cannot happen for anything the MCP
  renderer can return anyway.
- Only values substituted **in this call** are scrubbed. The server does not
  scan every result for every secret the user owns: that would decrypt the
  whole vault on every tool call, and a value short enough to appear by
  coincidence (`1234`) would corrupt unrelated output. If a page echoes a
  password the agent typed in a *previous* call, that call is where it was
  typed, and that call scrubbed its own result. A later `browser_read_text`
  that finds the value still on screen is out of scope and is documented as
  such: after a login, navigate away before reading.
- Scrubbing is best-effort against encodings. A value that comes back
  base64'd, URL-encoded or split across DOM nodes is not caught. This is a
  containment measure for the common case (form echoes, `browser_evaluate`
  returning an input's `.value`, an API reflecting a header), not a guarantee.

### Audit and logs

- `AuditEvent` gains nothing. Args are still never written. The `error` column
  is scrubbed before write.
- The existing `console.log` lines in `executeSingle` carry no args; they gain
  nothing.
- The OTL route is registered with `logLevel: "silent"` so its URL (which is
  the token) never reaches pino. Route-level silence is simpler than
  pattern-based `req.url` redaction and leaves the existing decision to log
  `req.url` everywhere else intact.

### Reaper

`reapExpiredOtl` runs on an in-process interval (`startVaultReaper`, started
from `index.ts` next to jots' `startUploadReaper`), not as a `npm run reap`
subcommand: the reap CLI must stay free of `../config` and `../db` so a
directory-sweeping CronJob never carries `ENCRYPTION_KEY`. These are database
rows, not a shared disk, so N pods sweeping concurrently is harmless. Every
read already filters on `expires_at`; the sweep is hygiene, not correctness.

### Config

None new. `ENCRYPTION_KEY` and `SERVER_PUBLIC_URL` are already required.

### Docs

- `docs/site/_content/integrations/vault.md` — what it is, the reference
  syntax, the OTL idiom, the scrubbing limits (the "navigate away after login"
  note lives here), and that it is write-only.
- Nav entry in `docs/site/nav.json` next to Files.
- `docs/releases/v0.29.0.md` under Features, RC first — new table.
- Finding: `docs/findings/2026-09-16-vault-scrub-limits.md` if implementation
  turns up anything non-obvious about the scrub (it probably will: the
  browser tools return text in several shapes).

## Data flow

```
human ──PUT /api/vault/site_pw──▶ encrypt ──▶ user_vaults

agent ──execute_tools browser_type({text:"{{vault:site_pw}}"})──▶ executeSingle
        │ resolveVaultRefs: decrypt site_pw, substitute            (before zod)
        │ safeParse → handler(ctx, {text:"hunter2"})
        │ scrubVaultValues(result, {site_pw:"hunter2"})
        ▼
     { result: … "{{vault:site_pw}}" … }        ← what the model sees

agent ──vault_presign({name:"db_url"})──▶ pending_auth row (__vault_otl__, 120s)
      ◀── { url: ".../api/vault/otl/9f3c…", expires_at }
host  ──curl -fsS $URL -o .env──▶ consumeOtl: SELECT, DELETE changes===1 → 200 text/plain
host  ──curl again──▶ 404
```

## Errors

| Where | Code | Meaning |
|---|---|---|
| store / PUT | `INVALID_NAME` 400 | name fails grammar |
| store / PUT | `TOO_LARGE` 413 | value > 8 KB |
| store / PUT | `EMPTY_VALUE` 400 | value is `""` |
| DELETE, presign | `NOT_FOUND` 404 | no such secret |
| executeSingle | `VAULT_SECRET_NOT_FOUND` | reference to unknown name; handler skipped |
| OTL redeem | 404 empty | spent, expired, unknown — deliberately identical |

## Testing

Server (`packages/server/tests/vault*.test.ts`, existing per-process temp DB
harness, both dialects where the harness runs both):

- store: round-trip encrypt/decrypt, name grammar, size cap, overwrite keeps
  `created_at` and bumps `updated_at`, delete cascades OTL rows, list never
  includes the value.
- interpolate: top-level, nested object, array element, embedded in string,
  multiple in one string, same name twice, unknown name → error and handler
  not called, `vault_*` tools exempt, non-string values untouched, input not
  mutated, runs before zod (a `z.number()` arg receiving `"{{vault:port}}"`
  where the secret is `"5432"` coerces if the schema coerces).
- scrub: result string, nested, error message, value-is-substring-of-another,
  non-JSON result passthrough, unsubstituted secrets not scanned.
- OTL: mint → redeem 200 with exact body and headers, second redeem 404, two
  parallel redeems → exactly one 200, expired → 404 (clock seam like
  `presign._setNowForTest`), redeem reads the value of the row's own
  `user_id`/`name` and nothing off the request, delete secret → outstanding
  token 404,
  `reapExpiredOtl` scoped to the sentinel only (a `__file_ul__` row survives).
- routes: PUT/GET/DELETE auth required, OTL route unauthenticated, OTL route
  not logged.
- meta-tools integration: `execute_tools` with a reference into a fake plugin
  tool whose handler echoes its args → result shows the reference, audit row
  has no plaintext.

Portal (`Vault.test.tsx`): renders list, add flow posts value once and clears
the field, no element in the DOM ever contains the value after submit.

## Rollout

Schema change → `v0.29.0-rc.1` first, promote after soak. Release notes under
`docs/releases/v0.29.0.md`. Upgrade note: none required (additive table, no
config).
