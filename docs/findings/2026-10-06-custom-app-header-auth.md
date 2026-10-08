# Custom apps can authenticate with static headers

**Why.** Custom apps only spoke OAuth 2.1. Many remote MCP servers are guarded by
a fixed key (`X-Api-Key`, `Authorization: Bearer`). Header auth adds that, with
up to 10 user-supplied headers per app.

**Credentials live on the `custom_apps` row, not `connections`.** They are an
encrypted `headers_enc` column (BLOB on SQLite, BYTEA on PostgreSQL). A headers
app has no token, so everything that derived "connected" from a `connections`
row would have said "not connected" and the admin "needs reconnect" view (expired
and no refresh token) would have been wrong too. The only change needed was one
helper, `isCustomAppConnected`, used by `/api/connections` and `list_integrations`.
The admin derivation needed nothing. A corrupt ciphertext degrades to no headers
instead of throwing, and such an app reports not connected.

**Sessions are keyed on a header fingerprint.** The pooled MCP client used to be
keyed on URL and user. The key now includes a SHA-256 fingerprint of the header
record, so rotating a key makes the next call build a fresh session instead of
reusing one authenticated with the old key. The verify during an update connects
with the new headers, which replaces the cached session and closes the old one
immediately, so nothing ages out. A failed create or update verify evicts, so a
rejected key does not linger.

**Verify errors are status-only.** Add and edit open a real session first. The
failure message is `Server rejected the headers (HTTP <status>)` and never the
upstream body, because servers echo request details (including the header that was
sent) in error text. The bad-URL error does not echo the URL either. Verify is
bounded to 15 seconds (the SDK default is 60s per request); a timeout evicts the
session and reports the same generic "Could not connect" message.

**Call-time errors are redacted.** A non-401/403 failure while executing a headers
app's tool carries the SDK's message, which includes the response body and may echo
a request header. `redactHeaderValues` replaces every stored header value with
`[redacted]` before the text reaches the agent result, the audit log or a log line
(the `isError` result text too). `scrubString` only knows vault secrets, so it
could not do this.

**Blank value on update keeps the stored value.** Values are write-only, so the
portal cannot pre-fill them. An update row with a name and `""` keeps the stored
value for that name; a name that is omitted is removed; a blank value for a name
that has no stored value is a 400.

**Values are printable Latin-1 only.** `fetch` throws on a non-ByteString header
value and trims surrounding whitespace, so a euro sign would fail at call time
and `"  "` would be sent as empty. Both are refused at validation (tab,
`0x20-0x7E`, `0x80-0xFF`, at most 4096 bytes). Names must be RFC 7230 tokens and
a deny-list covers headers workbench sets itself or that control the connection
(`host`, `content-length`, `content-type`, `accept`, `mcp-session-id`,
`x-workbench-via`, `connection`, `transfer-encoding`, `upgrade`, `keep-alive`,
`te`, `trailer`, `proxy-authorization`, `proxy-connection`, `mcp-protocol-version`,
`last-event-id` — the SDK sets the last two, and a differently-cased user header
would be merged into a bad value). Names are capped at 256 characters.

**Racing duplicate names map to 409.** Verify takes a network round trip between
the name-exists check and the insert, which widens the TOCTOU window. Two creates
with the same name can both pass the check; the loser hits the UNIQUE constraint
(SQLite message, PostgreSQL `23505`), which is mapped to 409 instead of a 500.

**Three routes had to learn about headers apps.** The plan only covered create,
update and list. In practice the detail route (`GET /api/integrations/:integration`)
reported the wrong `authType` and no header names; `GET /api/auth/custom:<id>`
would have started an OAuth flow against a server that has none; and
`DELETE /api/connections/custom:<id>` would have tried to disconnect a token that
does not exist. The detail route now reports `apikey` with `headerNames`, and the
other two return 400 for headers apps. The portal hides Connect, Reconnect and
Disconnect for them.

**`PUT /api/custom-apps/:id` is policy-gated like POST.** Both go through
`customAppsAllowedFor`; otherwise a user excluded by the admin setting could still
point an existing app at new credentials.

**Names are listed, values never are.** List and detail responses carry
`headerNames` only; tests assert the secret is absent from the body.
