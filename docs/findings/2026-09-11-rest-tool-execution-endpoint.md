# REST tool execution, and Fastify's exact-match parser precedence

## What we wanted

A non-agent caller — `curl`, a cron job, a Lambda, any language without an MCP SDK —
had no way to run a plugin tool without speaking JSON-RPC, and no way to get a result
larger than 60,000 characters.

## What made it cheap

The 60,000-character cap is **not part of execution**. `capResultText` lives in
`packages/server/src/mcp/server.ts`, applied while rendering a `tools/call` response
into MCP content blocks. Everything below it — connection check, Zod validation and
defaults, audit row, Prometheus counters, the bounded worker pool — is envelope-blind.

So the REST endpoint is genuinely the same code path, not a parallel one:

- `executeSingle` and `executeMany` moved to exported functions in
  `packages/server/src/mcp/meta-tools.ts`. `execute_tools` now calls `executeMany`
  rather than owning the worker pool inline.
- `packages/server/src/api/rest-routes.ts` is envelope plus HTTP-status mapping, and
  nothing else. Auth is `resolveMcpUser`, the same resolver `/mcp` uses, so all three
  credentials work unchanged.

A REST call and an MCP call therefore produce **identical audit rows** — the portal's
Activity view cannot tell them apart, which is deliberate: the credential and the
user are what matter, not the framing.

The only REST-layer decisions are the status codes (`NOT_CONNECTED` → 409,
`Invalid arguments for …` → 400, a handler throw → 502) and integration scoping: the
path's integration is authoritative, so `POST /rest/github` with `jira_search_issues`
is a 404, never an execution.

## The non-obvious part: exact-match parsers beat regex parsers

A tool with no arguments should be callable as a bare `curl -X POST`. But an empty
body with `Content-Type: application/json` fails with `FST_ERR_CTP_EMPTY_JSON_BODY`
(the same class of failure as
[2026-06-10](2026-06-10-empty-json-body-bodyless-post.md), from the server side this
time).

Registering a catch-all regex parser in the route's encapsulated scope does **not**
fix it:

```ts
scope.addContentTypeParser(/^.*$/, { parseAs: "string" }, tolerantJson); // never sees JSON
```

Fastify resolves a content type against **exact string matches first**, and both
`application/json` and `text/plain` are built in as exact matches. The regex parser
only ever sees content types nothing else claimed — form-encoded, octet-stream — so
JSON bodies still went to the strict built-in, and `text/plain` bodies arrived at the
handler as raw strings.

Measured behaviour with a regex-only parser registered in the scope:

| Content-Type | Body | Result |
|---|---|---|
| `application/json` | empty | 400 `FST_ERR_CTP_EMPTY_JSON_BODY` (built-in) |
| `text/plain` | `hello` | 200, `request.body === "hello"` (built-in) |
| `application/x-www-form-urlencoded` | `a=1` | reached the regex parser |

The fix is to remove the built-ins **inside the scope** before registering
replacements:

```ts
scope.removeContentTypeParser(["application/json", "text/plain"]);
scope.addContentTypeParser("application/json", { parseAs: "string" }, /* empty → {} */);
scope.addContentTypeParser(/^.*$/, { parseAs: "string" }, /* → 415 */);
```

`removeContentTypeParser` is encapsulated like everything else in a Fastify plugin
scope — verified: a POST to a route registered on the parent app still fails an empty
JSON body with `FST_ERR_CTP_EMPTY_JSON_BODY`. Nothing outside `/rest` loosens.

Two smaller notes from the same pass:

- A regex parser written as `/.*/ ` triggers `FSTSEC001` ("may be vulnerable to CORS
  attack"). Anchoring it (`/^.*$/`) silences the warning and is what the advice asks
  for.
- `GET /rest/<anything>/<extra>` matched no route and fell through to the portal's
  SPA fallback, answering HTML. `/rest` had to join `/api`, `/mcp` and
  `/.well-known` in the not-found handler's exclusion list so REST 404s stay JSON.

## Shape

```
POST /rest/:integration     { tool, args }  |  { tool, ...args }  |  { executions: [...] }
GET  /rest                  integrations + connection status
GET  /rest/:integration     that integration's tools + JSON Schemas
```

Full contract: [REST endpoint](../reference/rest-endpoint.md).
