# CDP live view over SSE + REST

The portal's live browser view (cookie-auth capture and `browser_live_url`) used
to be a raw CDP WebSocket proxy: the browser opened a socket to
`/api/auth/cookie/:integration/cdp` or `/api/browser-session/cdp`, and the server
piped frames to chromium's own CDP socket. It is now three plain HTTP endpoints
per base path — `POST /attach`, `GET /events` (SSE), `POST /commands`, plus
`POST /detach` — implemented in `packages/server/src/auth/cdp-bridge.ts`.

Chromium has not changed and cannot: its CDP endpoint is only reachable over a
WebSocket. That hop is still `ws`, entirely server-side. What went away is the
socket **between the browser and us**.

## Why bother

**A WebSocket cannot send an `Authorization` header.** That single limitation
shaped the whole old design. Because the handshake could not carry the portal
bearer, the client had to send it as the first message —
`{"type":"auth", sessionId, cdpToken, bearer}` — and the server had to hold an
un-authorized socket open (with a 5s timeout and four custom close codes,
4400/4401/4403/4408) while it waited for that frame, then decide whether to dial
chromium. Auth-in-band is a shape you carry, not a feature: a credential arriving
as message content, on a connection that already exists, with a bespoke error
channel that no HTTP client understands.

With REST, `attach` is just a request. It carries the bearer in the header, it
answers 401/403/201 like everything else on the server, and no chromium socket
exists until it has succeeded.

**Nothing in the path has to forward an `Upgrade`.** The deploy docs used to tell
operators to configure WebSocket proxying for two specific paths. An SSE response
is a response; any proxy that can stream one is enough. What replaces that
instruction is narrower and more common: don't buffer or compress the stream
(`Cache-Control: no-transform` and `X-Accel-Buffering: no` are sent, which nginx
honours), and keep read timeouts above the 15s keepalive comment.

## The channel

`attach` mints a `channelId` and dials chromium. It is a **handle, not a
credential**: every follow-up re-proves the portal session and must match the
userId that opened it, so another user's `channelId` reads as 404. This is the
same rule the 2026-09-02 connect-link finding arrived at — a token that stands in
for a person is the bug.

One stream owns a channel. A second `GET /events` on the same channel is refused
(409) rather than splitting it, and when the stream drops the channel closes:
otherwise chromium keeps screencasting into nothing. Reconnecting is a fresh
`attach`, which is why the client does not try to resume a stream. A channel that
attaches but never streams (client died between the two requests) is reaped after
120s.

## Two things the transport change forced

**EventSource is not usable here.** It cannot set request headers, so an
`EventSource` client would have to put the credential back in the URL — the exact
thing the old in-band auth frame existed to avoid. The portal reads the SSE
stream through `fetch` + `body.getReader()` and parses frames itself. That costs
the browser's automatic reconnect, which we did not want anyway (a reconnect
needs a new channel, see above).

**One POST per input event would be absurd.** A socket made `mousemove` cheap.
The client now coalesces commands into one POST per ~12ms and drops a `mouseMoved`
that a newer one supersedes; `Page.screencastFrameAck` rides the same batch, so
frame pacing still works. The server caps a batch at 64 commands — an unbounded
array is free memory for a caller to burn.

## The header a same-origin GET does not send

Per Fetch, a browser omits `Origin` on a same-origin GET — it appends the header
only for cross-origin requests and for methods other than GET/HEAD. The old
proxy never met this, because a WebSocket handshake always carries `Origin`.
Ported verbatim, the origin allowlist made the event stream unreachable: `attach`
(a POST) passed, then `GET /events` 403'd for having no `Origin` at all.

So the stream accepts a missing `Origin` and only rejects a present-but-wrong
one, while every POST still requires the header. That is not a hole: a
cross-origin reader (`fetch`, `XHR`, `EventSource`) does send `Origin` and is
rejected, and a tag-based load that omits it cannot set `Authorization`, so it
401s before any channel lookup.

## Testing it

`cdp-bridge.test.ts` covers the transport's rules against a fake socket.
`cdp-bridge.chromium.test.ts` (opt-in via `TEST_CHROMIUM=1`) runs the bridge
against a real headless chromium and asserts real jpeg frames arrive on the SSE
stream and a `Runtime.evaluate` POST answers on it — the part no fake can tell
you, since only chromium knows whether it likes our `Origin` and our framing.

## Files

- `packages/server/src/auth/cdp-bridge.ts` — channels, SSE framing, routes
- `packages/server/src/auth/cdp-authz.ts` — unchanged rule, renamed to
  `authorizeCdpAttach` (it authorizes a request now, not a frame)
- `packages/portal/src/components/CdpScreencast.tsx` — fetch-based SSE client
- `packages/server/src/index.ts` — `@fastify/websocket` and both WS routes gone
