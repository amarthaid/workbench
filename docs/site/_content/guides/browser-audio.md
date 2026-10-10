---
title: Browser audio
description: Let an agent join a browser-based call and talk in it, with raw PCM in both directions.
---

Let an agent join a browser-based call (Zoom web client, Slack huddle, Google
Meet, anything that runs in a tab) and talk in it. Workbench is the pipe: raw
PCM out of the call, raw PCM into the call's microphone. Speech recognition,
turn-taking and voice come from your agent (a full-duplex realtime voice model
works best).

## Enable it

```bash
BROWSER_AUDIO_ENABLED=true
BROWSER_AUDIO_MAX_MINUTES=180   # hard cap per call
```

The Docker image ships PulseAudio; nothing runs until the flag is on. With the
flag off the tools answer `AUDIO_DISABLED`. A browser that was already open
before you enabled it must restart: `browser_audio_start` returns
`BROWSER_RESTART_REQUIRED`, and you call it again with `restart: true`. Open tabs
close, logins survive (same profile), and the page reopens in a new tab whose
`session_id` is returned.

## Flow

1. `browser_start` gives a `session_id`; `browser_navigate` to the meeting link.
2. `browser_audio_start { session_id, sample_rate: 24000 }` returns
   `{ stream_url, clear_url, sample_rate, format, channels, session_id, restarted, headers }`.
   The URLs are absolute, on the server's own origin, and are capability URLs:
   the secret in the path is the only credential they take (see
   [Capability URLs](#capability-urls)). Repeating `browser_audio_start` with
   the same tab and rate is idempotent and returns the same URLs; a different
   rate returns `AUDIO_BUSY`, so stop first, then start again.
3. Open the downlink: `GET stream_url` with `headers` (SSE).
4. Open the uplink: `POST stream_url` with `headers`,
   `Content-Type: audio/pcm`, chunked, and keep it open.
5. Click through the meeting's join flow (`browser_click`, `browser_screenshot`);
   choose "computer audio" when asked.
6. Pipe: every SSE `audio` frame goes to your model's input; every model audio
   delta is written into the uplink body.
7. When your model is interrupted: `POST clear_url`, which returns
   `{ played_ms, cleared_ms }`. `audio_end_ms = played_ms - <ms of audio you had
   sent before this response started>` is what a realtime API's truncate call
   needs.
8. Leave the meeting, then `browser_audio_stop { session_id }`, which returns
   `{ played_ms, duration_ms }` for the call.

## Wire format

PCM signed 16-bit little-endian, mono, at `sample_rate` (16000, 24000 or
48000; default 24000) in both directions.

SSE events:

| event | data |
|---|---|
| `audio` | `{ "seq": 412, "pcm": "<base64>" }`, 40 ms each; a `seq` gap means frames were dropped because you read too slowly |
| `playback` | `{ "played_ms", "buffered_ms" }` every 200 ms while your audio is queued, and once when it drains or when `clear` drops buffered audio |
| `ended` | `{ "reason" }`: `stopped`, `tab_closed`, `browser_exit`, `idle`, `max_duration`, `capture_failed`, `playback_failed`, `audio_daemon_exit` |

One reader and one uplink at a time: a second concurrent `GET` gets
`409 stream_busy` and a second concurrent `POST` gets `409 uplink_busy`. Once a
reader has disconnected, a new `GET` is accepted, so reconnecting after a
network blip is safe. The uplink accepts
audio faster than real time and queues up to 120 s; past that it stops reading
your body until audio plays. Closing the body plays out the queue, then the
response is `200 { "played_ms" }`. Cancelling the request, even after the body
is fully sent, drops the queued audio and frees the slot.

Other HTTP responses: `404 audio_not_found` for an unknown, revoked or ended
capability (never a redirect), `415` unless `Content-Type` is `audio/pcm`.

## Capability URLs

The client that holds the call open is often not the agent that called
`browser_audio_start`, and carries no workbench token. So the audio routes take
no OAuth: `browser_audio_start` mints 128 random bits per audio session and puts
them in the path (`/api/browser/audio/<capability>/stream` and `/clear`). Any
`Authorization` header is ignored.

- The capability lives exactly as long as the audio session: `browser_audio_stop`,
  the `ended` event, closing the tab, a browser restart, `max_duration`, and
  60 s with neither a reader nor an uplink connected (`ended{idle}`) all revoke
  it. The next `browser_audio_start` mints a new one.
- Treat the URLs as secrets. The server masks the capability in its request
  logs and records no trace spans for these paths; mask it in your proxy's
  access logs too (see [Reverse proxy settings](#reverse-proxy-settings)).
- `headers` carries only `X-Browser-Session`, a routing key, not a credential.
- The URLs are built from `SERVER_PUBLIC_URL`. A client that pins the
  workbench origin (refusing redirects and other hosts) needs that origin to
  match its own configured workbench URL exactly: scheme, host and port.

## Errors from the tools

| code | meaning |
|---|---|
| `AUDIO_DISABLED` | `BROWSER_AUDIO_ENABLED` is off |
| `BROWSER_TAB_NOT_FOUND` | that `session_id` is not one of your open tabs |
| `AUDIO_BUSY` | another tab already holds your call, or this tab is running at a different `sample_rate`; the error carries the holding `session_id`. Call `browser_audio_stop` on it first |
| `BROWSER_RESTART_REQUIRED` | the browser predates audio; call again with `restart: true` |
| `BROWSER_RESTART_FAILED` | the restart did not come back |
| `AUDIO_ENDED` | audio ended while starting; the detail names the reason |

## Routing in a cluster

Send the returned `headers` (`X-Browser-Session`) on all three requests so the
mesh routes them to the pod running your browser. If a request lands elsewhere
the server pipes it to the right pod itself (it needs `INTERNAL_MCP_URL` and
the `X-Browser-Session` header, since the capability names no user), at the
cost of an extra hop. Operator rules, as for every browser request: hash
consistently on `X-Browser-Session`, hash to pod endpoints rather than a
ClusterIP (which would re-round-robin), and keep `CLUSTER_ENABLED` off, since no
proxy can route inside a worker pool. Details in
[Docker: multiple replicas](../deploy/docker.md#multiple-replicas) and
[browser session pod affinity](../field-notes/2026-09-10-browser-session-pod-affinity.md).

## Reverse proxy settings

The uplink is a long request body and the downlink a long response, so a proxy
tuned for short requests cuts calls off. In front of the audio endpoints
(`/api/browser/audio/*`) set:

```nginx
client_max_body_size 0;        # default 1m cuts the uplink after ~22 s at 24 kHz
proxy_request_buffering off;   # stream the body through
proxy_buffering off;           # SSE downlink
proxy_http_version 1.1;
proxy_read_timeout 7200s;      # at least the longest call
proxy_send_timeout 7200s;
access_log off;                # the path is a credential (or log without $request_uri)
```

ingress-nginx equivalents: `nginx.ingress.kubernetes.io/proxy-body-size: "0"`,
`proxy-request-buffering: "off"`, `proxy-buffering: "off"`,
`proxy-read-timeout: "7200"`, `proxy-send-timeout: "7200"`. Also see
[Docker: reverse proxy](../deploy/docker.md#behind-a-reverse-proxy).

## Isolation

Each user gets their own PulseAudio daemon, so a page in your browser can only
enumerate your own devices, never another user's call audio or microphone. The
microphone permission is granted to one origin at a time and follows the tab's
main-frame navigation. See the
[field note](../field-notes/2026-10-07-browser-audio-pipeline.md).

## Limits

- One call per user at a time (`AUDIO_BUSY` names the tab that has it).
- Audio from your other tabs is mixed into the stream.
- A pod restart drops the connection with no `ended` event, and the old tab is gone with the browser. Call `browser_start` (or `browser_tabs`) for a new `session_id`, navigate or rejoin the call, then call `browser_audio_start` again. `ended{browser_exit}` means chromium itself exited.
- Tell the people in the call they are talking to an agent. Recording and
  consent rules where you operate are yours to follow.
