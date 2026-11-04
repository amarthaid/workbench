# Audit log: capturing tool-call arguments and results

**Date:** 2026-11-04

`AUDIT_PAYLOAD=args|full` records what a tool call was given and returned.
Off by default. Every event also carries `user_email` now.

## Decisions

- **Arguments are recorded as the agent sent them,** before `{{vault:NAME}}`
  resolution (`rawArgs` in `executeSingle`), so a vault secret stays a
  placeholder. The vault's own tools (`vault_*`) never record arguments.
  Results are the vault-scrubbed value the agent was given.
- **Sanitising happens in the logger, not at call sites**
  (`src/audit/payload.ts`): call sites pass live values, and one place decides
  the mode, redaction, binary stripping and caps. Credential-named keys are
  matched on *words* of the key (camelCase / snake / kebab split), because a
  substring regex redacted `footprint` (`otp`) and `spinner` (`pin`).
- **Base64 detection** ignores line breaks only and needs mixed case: stripping
  all whitespace made long prose look like base64, and a run of one letter
  (`xxxx…`) matched the alphabet.
- **Oversized values are cut, not dropped.** Each value has its own cap
  (`AUDIT_PAYLOAD_ARGS_MAX_BYTES`, `AUDIT_PAYLOAD_RESULT_MAX_BYTES`, UTF-8
  bytes), cut on a character boundary, flagged `*_truncated`, with the full
  size in `*_bytes`. The event is always written. Caps max out at 256 KiB so an
  event with both stays under Kafka's default 1 MB `message.max.bytes`.
- **Separate `audit_payload` table** keyed by `audit_log.id`, so the Activity
  and Overview scans never read the wide columns. The audit row is inserted
  with `RETURNING id` (SQLite ≥ 3.35 and PostgreSQL both support it); a failed
  payload insert is logged and does not fail the tool call.
- **Admins read payloads one event at a time** (`GET
  /api/admin/overview/activity/:id/payload`), and each read writes an
  `ADMIN_AUDIT_PAYLOAD_VIEW` event, because a result can hold another user's
  email, documents or messages.
- **Email** is looked up per event from `users`, cached 5 minutes per user, and
  stored on the row; the admin view shows the current email and falls back to
  the stored one when the user row is gone.

## Request origin

Every event written during a request also records `source_ip`, `user_agent`,
`auth_method` (`api_key` / `oauth` / `session` / `curl_token`), and the OAuth
`client_id` + registered `client_name`.

- An `onRoute` hook at the app root (`installAuditContext`, registered before
  any route) wraps every handler in an AsyncLocalStorage store built from its
  request, so no route can be missed and no audit call site changed. The
  credential checks (`resolveMcpUser`, `authenticatePortal`, the curl proxy)
  call `noteAuth()` when they succeed. The admin gate runs in a `preHandler`,
  *before* the handler's store exists, so it records on a request-keyed
  WeakMap that the store reads when it is created.
- `source_ip` is `request.ip`: behind a load balancer it is the balancer unless
  `TRUST_PROXY` trusts it. Trusting `X-Forwarded-For` by default would let any
  client write its own address into the audit log. Fastify's types take no
  hop count, so a number becomes `(addr, i) => i < n`. The browser-affinity
  forward between replicas now passes `User-Agent` and `X-Forwarded-For`, which
  the owning replica believes only if `TRUST_PROXY` includes the pod range.
- `CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) is read only when the *socket*
  peer is trusted by `TRUST_PROXY` (checked with `node:net` `BlockList`, which
  also needs proxy-addr's named ranges `loopback`/`linklocal`/`uniquelocal`
  expanded, since Fastify accepts them) and the value is one valid IP;
  otherwise `request.ip` stands. A header any client can send is otherwise a
  free way to forge the audit log's address.
- `client_name` is what the client sent at dynamic registration: self-declared.
  MCP `initialize` `clientInfo` is not recorded because `/mcp` is stateless.

## Not done

- Retention: nothing prunes `audit_log` or `audit_payload` (out of scope).
- A secret typed by the agent into an ordinary field (e.g. `browser_type`
  text) is recorded as sent.
- Curl proxy bodies stay out on purpose.
