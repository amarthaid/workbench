---
title: Custom apps
description: Adding your own remote MCP server as an app, authenticated with OAuth or with static request headers.
---

A custom app is a remote MCP server (streamable HTTP) that you add yourself, from
the Apps page in the portal. Its tools appear next to the built-in ones in
`search_tools` and run through `execute_tools`, namespaced as `appName__tool`.
Each app belongs to the user who added it. An administrator can limit who may add
custom apps (see [Administration](../deploy/admin.md)).

There are two ways to authenticate to the server: OAuth 2.1 (the default, with
dynamic client registration), and static request headers.

## Header auth

Use header auth for a server that is protected by a fixed key rather than OAuth,
for example `X-Api-Key: <key>` or `Authorization: Bearer <token>`.

In the Add app dialog choose **Headers**, enter the URL, then add one or more
header name and value rows. There is no OAuth redirect: the app is created
directly and shows as connected.

### The key is checked when you add the app

Before anything is saved, workbench opens a real MCP session against the URL with
your headers. If the server rejects them, the add fails with an inline message
such as "Server rejected the headers (HTTP 401)" and no app is created. The
message carries the HTTP status only, never the server's response text, because
upstream errors can echo request details back.

The same check runs when you edit the headers of an existing app.

### Values are write-only

Header values are encrypted at rest and never returned by any endpoint, shown in
the portal, or listed in the admin view. Only the header names are visible.

To change a key, open the app and edit its headers. Leaving a value blank keeps the
stored value for that name. A name you remove from the list is deleted. Saving new
values replaces the live session, so the next call uses them.

### Limits

| Rule | Value |
|------|-------|
| Header count | at most 10 |
| Name | an RFC 7230 token (letters, digits and ``!#$%&'*+-.^_`|~``) |
| Value | non-empty, printable Latin-1, at most 4096 bytes |

Values are limited to printable Latin-1 (tab and `0x20`-`0x7E`, `0x80`-`0xFF`)
because the HTTP client rejects anything else, and trims surrounding whitespace.
A whitespace-only value is rejected.

These names are reserved because workbench sets them itself or because they
control the connection, and are refused (case-insensitive):

`host`, `content-length`, `content-type`, `accept`, `mcp-session-id`,
`x-workbench-via`, `connection`, `transfer-encoding`, `upgrade`, `keep-alive`,
`te`, `trailer`, `proxy-authorization`, `proxy-connection`.

### Differences from OAuth apps

- There is nothing to connect or disconnect. A headers app is connected as long as
  it has headers; the portal hides Connect, Reconnect and Disconnect for it.
  Delete removes the app and its stored headers.
- If the key is later revoked upstream, calls fail with an authentication hint.
  Edit the headers to supply a new key.
- The same URL rules apply as for OAuth apps: private and loopback addresses are
  blocked, and workbench's own `/mcp` is refused.

For provider-defined, per-integration API keys (New Relic), see
[API-key connections](api-key-connections.md).
