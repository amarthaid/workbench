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
BROWSER_AUDIO_MAX_MINUTES=120   # hard cap per call
```

The Docker image ships PulseAudio; nothing runs until the flag is on. With the
flag off the tools answer `AUDIO_DISABLED`. A browser that was already open
before you enabled it must restart: `browser_audio_start` returns
`BROWSER_RESTART_REQUIRED`, and you call it again with `restart: true`. Open tabs
close, logins survive (same profile), and the page reopens in a new tab whose
`session_id` is returned.

## Flow

1. `browser_start` gives a `session_id`; `browser_navigate` to the meeting link.
2. `browser_audio_start { session_id, sample_rate: 24000 }` returns `stream_url`,
   `clear_url` (both absolute), `sample_rate`, `format` and `headers`.
   Repeating `browser_audio_start` with the same tab and rate is idempotent; a
   different rate returns `AUDIO_BUSY`, so stop first, then start again.
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
| `ended` | `{ "reason" }`: `stopped`, `tab_closed`, `browser_exit`, `replaced`, `max_duration`, `capture_failed`, `playback_failed`, `audio_daemon_exit` |

Opening a second `GET` replaces the first (`ended{replaced}`), so reconnecting
is safe. A second concurrent `POST` gets `409 uplink_busy`. The uplink accepts
audio faster than real time and queues up to 120 s; past that it stops reading
your body until audio plays. Closing the body plays out the queue, then the
response is `200 { "played_ms" }`. Cancelling the request, even after the body
is fully sent, drops the queued audio and frees the slot.

Other HTTP responses: `401` without valid credentials, `404 audio_not_started`
(no audio on that `session_id`, or your audio runs on a different tab, which the
detail names; nothing is forwarded in that case), `415` unless `Content-Type` is `audio/pcm`.

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
the server pipes it to the right pod itself (it needs `INTERNAL_MCP_URL`), at
the cost of an extra hop. Operator rules, as for every browser request: hash
consistently on `X-Browser-Session`, hash to pod endpoints rather than a
ClusterIP (which would re-round-robin), and keep `CLUSTER_ENABLED` off, since no
proxy can route inside a worker pool. Details in
[Docker: multiple replicas](../deploy/docker.md#multiple-replicas) and
[browser session pod affinity](../field-notes/2026-09-10-browser-session-pod-affinity.md).

## Isolation

Each user gets their own PulseAudio daemon, so a page in your browser can only
enumerate your own devices, never another user's call audio or microphone. The
microphone permission is granted to one origin at a time and follows the tab's
main-frame navigation. See the
[field note](../field-notes/2026-10-07-browser-audio-pipeline.md).

## Limits

- One call per user at a time (`AUDIO_BUSY` names the tab that has it).
- Audio from your other tabs is mixed into the stream.
- A pod restart drops the connection with no `ended` event; reconnect and call `browser_audio_start` again. `ended{browser_exit}` means chromium itself exited.
- Tell the people in the call they are talking to an agent. Recording and
  consent rules where you operate are yours to follow.
