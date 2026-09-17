---
title: Vault
description: Per-user encrypted secrets an agent can use but never read — referenced as {{vault:NAME}} inside any tool call, or handed to a script through a one-time URL.
---

`vault` is where a password lives when there is no OAuth for it.

Workbench already keeps OAuth tokens, cookie jars and API keys encrypted and injects them into requests without the model seeing them. That stops at the integration boundary. A login for a site with no API, an SSH passphrase, a token for a service no plugin knows about — before the vault, the only way to give those to an agent was to paste them into chat, where they land in the transcript, the model provider's logs, and every later turn.

Like `browser` and `files`, it is an internal plugin: `auth: { type: "none" }`, always connected, no setup.

## The rule

> **The agent can use a secret. It cannot read one.**

There is no `vault_get`. `vault_list` returns names and descriptions. The portal is write-only too: once saved, a value is never displayed again — to rotate, replace it.

## Adding a secret

Portal → **Vault** → **Add secret**. Names are lowercase letters, digits, `_ . -`, up to 64 characters. Values up to 8 KB. Stored AES-256-GCM under the server's `ENCRYPTION_KEY`, same as OAuth tokens. Editing a secret without filling in a new description keeps the existing one; the portal only sends the field when it has a value.

## Using a secret inside a tool call

Write `{{vault:NAME}}` anywhere in another tool's arguments:

```json
{ "tool": "browser_type", "args": { "session_id": "…", "text": "{{vault:site_password}}" } }
{ "tool": "gitlab_trigger_pipeline", "args": { "project": "acme/demo-repo", "ref": "main", "variables": { "DEPLOY_TOKEN": "{{vault:deploy_token}}", "DATABASE_URL": "postgres://app:{{vault:db_password}}@db.example.com/app" } } }
```

Only tools that run through `executeSingle` interpolate — that is every
registry tool, over MCP, `execute_tools`, or the REST endpoint. `curl_session`
and the `/c/<integration>/<path>` proxy are meta-tools that sit outside it, so
a `{{vault:NAME}}` written into either is sent through as the literal text.

The server resolves the reference after the arguments leave the model and before the tool's own validation runs, so the value gets the tool's normal coercion. It works for every tool — plugins, `browser_*`, `files_*`, the REST endpoint — because it happens in the one place all of them execute.

An unknown name fails the call with `VAULT_SECRET_NOT_FOUND` before the tool runs.

### What comes back is scrubbed

Any occurrence of a value the call substituted is replaced with its reference in the result and in any error message before the model sees it. Scrubbing walks the result structurally — every string, and every number, boolean, or null leaf equal to a substituted value — plus keys, not just values, so `browser_evaluate` returning an input's `.value` after you typed a password into it shows `{{vault:site_password}}`, not the password. Validation errors go through the same scrub, so a malformed call can't leak a value in its `INVALID_ARGS` message either. If the result can't be serialized as JSON at all, the call fails closed with `{ "error": "VAULT_SCRUB_FAILED" }` instead of returning the unscrubbed result.

Scrubbing also reaches beyond the call that did the substituting: any value the agent has had substituted for it in the last 10 minutes is scrubbed from every later result too, not just the call that referenced it. So a `browser_read_text` right after a `browser_type` that typed a password is covered even though it never itself referenced `{{vault:site_password}}` — the same goes for `files_read` after a `files_write`. It's still worth navigating away after a login as good practice, but it's no longer required for the value to stay out of the model's context. A remembered value shorter than 8 characters is only scrubbed where a result equals it exactly, never as a substring inside a longer string — see the over-scrubbing limit below for why.

**The limits:**

- **The window.** Only values substituted in the last 10 minutes, and only up to the most recent 32 per user, are remembered. Older or evicted values are not scrubbed from later results. The ring lives in the process's memory, not the database — a restart clears it, and a reaper sweeps expired entries out of it in the background so an abandoned session's values don't sit in memory indefinitely.
- **One worker's ring, under `CLUSTER_ENABLED`.** The browser_* tools already route every request for a given user to one worker ([finding](../field-notes/2026-09-10-browser-session-pod-affinity.md)), so the common login-then-read case stays on the same ring. A result served by a different worker is only scrubbed against that worker's own ring — best-effort, like the encoding limits below.
- **Over-scrubbing.** A value substituted or remembered from the last 10 minutes is replaced wherever it appears for the rest of the window — including in output that has nothing to do with the tool call that used it. A short secret can therefore rewrite unrelated text it merely happens to match. Values the agent used recently (not merely stored) are the ones scrubbed this way, which bounds the risk; a value the ring is remembering *because* it's short (under 8 characters) is additionally restricted to matching a whole result, never mid-sentence, for exactly this reason.
- **The ring is a confirmation oracle.** Because a recently-used value is scrubbed wherever it reappears, a tool that echoes text back tells the model whether a guessed value equals one it used recently — the placeholder appears if the guess was right, plain text if it wasn't. This is accepted under workbench's threat model (the model is trusted to *use* values, not to be prevented from confirming ones it can already ask a tool to echo) and is disclosed here rather than hidden.
- **Canonicalisation.** Matching compares the value as the tool rendered it. A numeric-looking secret that the tool's schema coerces comes back re-rendered and is not caught: `"5432.0"` through `z.coerce.number()` is the number `5432`, which is not the stored string.
- **Encodings.** Values that come back base64'd, URL-escaped, or split across DOM nodes are not caught.

This is containment for the common case, not a guarantee. See [the finding on why scrubbing walks the structure rather than the JSON text](../field-notes/2026-09-16-vault-scrub-json-text.md).

## Handing a value to something outside workbench

When the value is needed by a script, an `.env` file, a CI job — anything that is not a workbench tool — the agent mints a one-time URL:

```json
{ "tool": "vault_presign", "args": { "name": "db_url" } }
→ { "url": "https://wb.example.com/api/vault/otl/9f3c…", "expires_at": "…" }
```

The agent then has the *host* fetch it, straight to where it is needed:

```bash
curl -fsS "$URL" -o ./.env.secret     # to a file
DB_URL=$(curl -fsS "$URL")            # to a variable
```

The URL works exactly once — the first `GET` spends it; a second returns 404 — and expires after `ttl_seconds` (default 120, max 600). If a fetch fails, mint another. The token is opaque, unauthenticated by design (it *is* the authorization), and the route is excluded from the request log.

The tool's description tells the agent not to fetch the URL itself and not to print the response. That is a behavioural guard rail, not a technical one: an agent that `curl`s the URL and echoes the output has put the value in its context. Pipe to a file.

## Tools

| Tool | Does |
|---|---|
| `vault_list` | Names, descriptions, timestamps, and each secret's `{{vault:…}}` reference. Never values. |
| `vault_presign` | One-time URL for a value. `{ name, ttl_seconds? }` → `{ url, expires_at }`. |

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/vault` | list (any bearer: API key, OAuth token, or portal session) |
| `PUT` | `/api/vault/:name` | `{ value, description? }` → 201 created / 200 replaced (portal session) |
| `DELETE` | `/api/vault/:name` | 204; revokes outstanding one-time URLs (portal session) |
| `GET` | `/api/vault/otl/:token` | redeem once → `text/plain` body; 404 otherwise. No auth. |

Listing is readable with any bearer, including the agent's own API key or OAuth
token. Writing and deleting are not: they need the portal-session token a
signed-in human holds, and anything else gets `403 PORTAL_SESSION_REQUIRED`.
The agent may use a secret; it may not read one, and it may not rotate one to a
value it chose and then read that instead.

## Threat model

The adversary is accidental exposure: the value ending up in the model's context, the session transcript, or a provider's request log. The agent is the user's own, working against the user's own vault, and is trusted to use any secret in any tool — there is no per-secret allowlist. A hostile or prompt-injected agent can still send a value somewhere via a tool that makes outbound requests. Scope what you put in the vault accordingly.
