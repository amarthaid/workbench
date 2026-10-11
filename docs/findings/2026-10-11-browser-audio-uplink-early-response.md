# Browser audio: the uplink must answer before the call ends

**Date:** 2026-10-11

## What we saw

Voice calls through the public workbench ended as `audio_lost` after about two
minutes. The voice client logged the uplink settling with status 524, no
`ended` event, after 136 s, with a Cloudflare error page as the body. The same
calls against an in-cluster workbench, with no proxy in the path, did not drop.

## Why

The uplink is one chunked POST held open for the whole call. Workbench sent its
response (`200 {played_ms}`) only when the request body ended or the session
ended, because that is when the result is known. Cloudflare's proxy gives up on
an origin that has not sent response headers within 100 s and answers 524 to
the client, which closes the uplink. Any call longer than that died, whatever
the audio was doing. The SSE downlink was never affected: its headers go out at
once and a ping follows every 15 s.

Clear, reader drops, reloads and the server's own timeouts were ruled out
first: Fastify sets `requestTimeout` and the socket timeout to 0, and an
in-process probe of 50 clears, a silent gap and a reader reconnect left the
uplink open.

## What changed

The uplink now answers `200` with `Content-Type: application/json` as soon as
it is accepted, writes a newline every 20 s (`UPLINK_HEARTBEAT_MS`), and ends
with `{"played_ms"}` exactly as before. Leading whitespace is valid JSON, so a
client that parses the body as one document still works; a client that treats
the response *ending* as the end of the uplink also works. Refusals (409, 404,
415) are still decided before any header goes out.

When the session ends mid-upload, the response is ended and the socket is
destroyed. A `Connection: close` header can no longer be chosen at that point,
since the headers are already sent, and keep-alive would otherwise read the
rest of an endless body. The socket has to be captured from the request:
`res.socket` is already detached by the time `end`'s callback runs.

## Limits

- Cloudflare also caps request bodies by plan (100 MB on Free and Pro). One
  uplink per call at 24 kHz reaches that after about 35 minutes. Longer calls
  need the audio routes on a DNS-only hostname, or a client that rotates its
  uplink.
- A proxy that buffers the whole request body would still break the uplink.
  The smoke test heard agent audio in real time through Cloudflare, so its
  proxy streams it.
