# Browser audio pipeline: let an agent talk in a browser call

**Date:** 2026-10-07
**Status:** approved in chat, awaiting spec review
**Ships as:** release candidate (Docker image change, new streaming proxy path)

## Problem

The built-in browser lets an agent navigate, click, and type, but it is deaf
and mute. Headless Chromium has no audio devices, so an agent that opens a
browser-based call (Zoom web client, Slack huddle, Google Meet, anything that
runs in a tab) can join the meeting but cannot hear anyone or say anything.

The target agent is a full-duplex realtime voice model (GPT realtime class).
It does its own speech recognition, turn-taking, and barge-in. It needs a raw
audio pipe in both directions and an accurate answer to one question when it
is interrupted: how much of what it said was actually heard.

## Decision

- **Workbench is a pipe, not a speech stack.** Raw PCM in, raw PCM out. No
  transcription, no TTS, no voice activity detection.
- **Audio goes through OS-level virtual devices (PulseAudio), not an in-page
  JavaScript shim.** Every meeting app ends up "playing to the speaker" and
  "reading the mic". Hooking `getUserMedia`, `AudioContext`, WebRTC tracks,
  worklets, workers, and cross-origin iframes per app is brittle and
  detectable. A null sink and a pipe source per user are app-agnostic.
- **One call per user at a time.** Devices are per Chromium process, and
  there is one Chromium per user. Different users on the same pod run calls
  in parallel, each on their own device pair.
- **Audio binds to a tab.** `session_id` (a tab id since the
  [browser tabs change](2026-09-17-browser-tabs-design.md)) picks the tab the
  call runs in. Mic permission is granted to that tab's origin; closing that
  tab ends the audio session.
- **Duplex streaming, not request/response.** Audio out is an SSE stream.
  Audio in is one long-lived chunked `POST` held open for the whole call.
  Interruption is a separate `clear` call that returns how much has played.

Rejected:

- **In-page shim over CDP** (`addScriptToEvaluateOnNewDocument` +
  `Runtime.addBinding`). No image change, but per-app breakage, detectable
  monkeypatching, and base64 PCM on the CDP socket in both directions.
- **Chromium fake-device flags** (`--use-file-for-fake-audio-capture`). Mic
  only, loops a static file; streaming through a FIFO is unreliable.
- **Per-utterance synchronous `POST`** (response returns when the clip has
  played). Fits a turn-based TTS agent, not a duplex model that emits audio
  deltas every 50–100 ms. Can be added later as a separate mode if a
  turn-based agent needs it.
- **Per-tab devices.** PulseAudio routes per process; Chromium's audio
  service does not tag streams with a tab. Splitting by tab would need the
  in-page shim again.
- **Per-speaker streams.** Depends on how each app wires WebRTC (Zoom web
  mixes in WASM). One mixed stream, exactly what a speaker would play.

## Architecture

```
agent (realtime voice loop)
  │  MCP: browser_audio_start / browser_audio_stop  ──►  browser plugin
  │  GET  /api/browser/tabs/:session_id/audio/stream   (SSE, call audio out)
  │  POST /api/browser/tabs/:session_id/audio/stream   (chunked PCM in)
  │  POST /api/browser/tabs/:session_id/audio/clear
  ▼
server (pod owning the user's chromium)
  audio/routes.ts ── audio/session.ts ── audio/pulse.ts ── pulseaudio daemon
                           │                                ├─ wb_sink_<key8>  (null sink; .monitor = call audio)
                           │                                ├─ wb_mic_<key8>   (null sink; agent audio played here)
                           │                                └─ wb_src_<key8>   (remap of wb_mic.monitor = chromium mic)
                           └─ profile-chromium.ts: spawn env PULSE_SINK / PULSE_SOURCE,
                              --autoplay-policy=no-user-gesture-required
```

### Units

**`packages/server/src/audio/pulse.ts`**: the only code that talks to
PulseAudio. Shells out to `pactl`. No HTTP, no session state.

- `ensureDaemon(): Promise<void>` spawns
  `pulseaudio --daemonize=no --exit-idle-time=-1` as a supervised child if
  not running. On exit, it restarts and emits `daemon-exit`.
- `createDevices(key): Promise<{ sink, mic, source }>` loads
  `module-null-sink sink_name=wb_sink_<key8>` (what Chromium plays to),
  `module-null-sink sink_name=wb_mic_<key8>` (what the agent's audio is
  played into), and
  `module-remap-source source_name=wb_src_<key8> master=wb_mic_<key8>.monitor`
  (what Chromium records from). Idempotent.
- `destroyDevices(key): Promise<void>` unloads all three modules. Idempotent.
- `listDevices(): Promise<string[]>` lists `wb_*` module keys, for the reaper.

`<key8>` is the first 8 hex characters of the user's routing key
(`mintSessionKey(userId)`), never the raw user id.

**`packages/server/src/audio/session.ts`**: one `AudioSession` per user in a
module-level map, same pattern as `warmSessions`. Owns:

- the bound tab (`session_id`), sample rate, start time;
- the **capture reader**: `parec --device=wb_sink_<key8>.monitor --format=s16le --rate=<rate> --channels=1 --raw`,
  framed into 40 ms chunks, pushed to the current SSE subscriber;
- the **uplink writer**: an in-memory PCM queue drained at real time in 20 ms
  frames into `pacat --device=wb_mic_<key8> --format=s16le --rate=<rate> --channels=1 --raw --latency-msec=20`,
  padding silence when the queue is empty; it counts samples written to
  compute `played_ms`;
- the current SSE subscriber (at most one) and the current uplink (at most one).

Resampling is done by PulseAudio in both directions. `parec --rate` reads the
48 kHz monitor at the session rate; `pacat --rate` plays session-rate PCM
into the 48 kHz mic sink. The mic is a null sink plus a remap source rather
than a `module-pipe-source`, because a pipe source fixes its rate when it is
created (at Chromium spawn, before the session rate is known) and stalls
instead of producing silence on underrun. No DSP code in the repo.

The real-time pacing lives in the server, not in `pacat`. The writer hands
`pacat` one 20 ms frame per 20 ms tick (silence when the queue is empty),
with `--latency-msec=20` so `pacat` holds at most about one frame. That keeps
the queue, and therefore `clear`, in the server, where it can be emptied
instantly.

**`packages/server/src/audio/routes.ts`**: the three HTTP endpoints plus the
streaming affinity forward (below). Registered in its own Fastify scope.

**Browser plugin (`plugins/internal/browser.ts`)**: two new tools,
`browser_audio_start` and `browser_audio_stop`.

**`profile-chromium.ts`**: when `BROWSER_AUDIO_ENABLED`, creates the user's
devices before spawn and passes `PULSE_SINK`, `PULSE_SOURCE`, and
`--autoplay-policy=no-user-gesture-required`.

### Why devices exist from spawn

Chromium reads `PULSE_SINK`/`PULSE_SOURCE` once, at spawn. So devices are
created when the user's Chromium starts (if the feature is enabled), not when
audio starts. An idle null sink and pipe source cost close to nothing.
`browser_audio_start` only attaches the reader and writer.

A Chromium that is already running without devices (spawned before the
feature was enabled, or after a daemon crash) is restarted on the first
`browser_audio_start`. The profile and logins survive; open tabs do not. The
tool returns `BROWSER_RESTART_REQUIRED` with that explanation instead of
restarting silently, and the agent retries with `restart: true`.

## API

### MCP tools

`browser_audio_start`

```json
{ "session_id": "<tab id>", "sample_rate": 24000, "restart": false }
```

`sample_rate` is one of `16000 | 24000 | 48000`, default `24000` (what GPT
realtime models use natively). Returns:

```json
{
  "format": "pcm_s16le",
  "channels": 1,
  "sample_rate": 24000,
  "stream_url": "/api/browser/tabs/<tab id>/audio/stream",
  "clear_url": "/api/browser/tabs/<tab id>/audio/clear",
  "headers": { "X-Browser-Session": "<routing key>" }
}
```

Side effects: binds the user's audio session to the tab, starts the capture
reader, grants `audioCapture` to the tab's origin via
`Browser.grantPermissions`.

Errors:

- `TAB_NOT_FOUND`: `session_id` is not one of the caller's tabs.
- `AUDIO_BUSY`: another tab already has audio; the detail names its `session_id`.
- `BROWSER_RESTART_REQUIRED`: see above.
- `AUDIO_DISABLED`: `BROWSER_AUDIO_ENABLED` is off.

`browser_audio_stop { session_id }` → `{ played_ms, duration_ms }`. Ends the
session (see Lifecycle). Stopping a tab that has no audio is a no-op that
returns zeros.

### Routing

The `headers` returned by `browser_audio_start` are an optimization. The
agent should send them on all three requests, so the mesh (consistent hash on
`X-Browser-Session`, per the
[pod affinity finding](../../findings/2026-09-10-browser-session-pod-affinity.md))
lands them on the pod that owns the Chromium. Routing does **not** depend on
the agent getting this right.

**Streaming affinity forward.** When a request arrives at a pod with no local
audio session for the caller, and its inbound `X-Browser-Session` does not
verify as this caller's key (`verifySessionKey`), and `INTERNAL_MCP_URL` is
set:

- the pod opens a streaming hop to the internal service origin, same path,
  with `X-Browser-Session: mintSessionKey(userId)` and the caller's auth
  headers (Bearer or `x-workbench-api-key`);
- for `GET …/stream`, it pipes the upstream SSE body back to the client;
- for `POST …/stream`, it pipes the client request body upstream and relays
  the final response;
- for `POST …/clear`, a normal buffered hop.

No timeout on the streaming hop beyond the session cap. Client disconnect
aborts the upstream request, and vice versa.

Loop guard, same as `forwardForBrowserAffinity`: an inbound header that
verifies for this user means "I am the owner", so handle locally. A failed
hop at the network layer falls through to local handling, which returns `404`.

This is a new forwarder next to the existing buffered one. The existing one
reads the whole body as JSON with a 30 s timeout and cannot carry a stream.

The routing key is a hint, not a credential. The bearer authorizes every
request.

### `GET /api/browser/tabs/:session_id/audio/stream`: call audio out (SSE)

Events:

| event | data | when |
|---|---|---|
| `audio` | `{ "seq": 412, "pcm": "<base64 s16le>" }` | every 40 ms of captured audio |
| `playback` | `{ "played_ms": 18240, "buffered_ms": 3100 }` | every 200 ms while uplink audio is queued, plus once on drain (`buffered_ms: 0`) |
| `ended` | `{ "reason": "stopped" }` | session over; stream closes after it |

`ended.reason` ∈ `stopped | tab_closed | browser_exit | replaced | max_duration | capture_failed | playback_failed | audio_daemon_exit`.

A `: ping` comment every 15 s keeps idle proxies from cutting the stream.

- **One reader per session.** A new `GET` replaces the old one. The old one
  receives `ended{replaced}` and is closed. This lets an agent reconnect after
  a network blip without stopping audio.
- **Slow reader:** frames are dropped, never buffered without limit. Gaps show
  up in `seq`.
- `404 audio_not_started` if the tab has no audio session.

### `POST /api/browser/tabs/:session_id/audio/stream`: agent audio in

- `Content-Type: audio/pcm`. Raw s16le mono at the session's `sample_rate`.
  Chunked transfer encoding. Held open for the call.
- The agent writes model audio deltas into the body as they arrive.
- Server side, bytes go into the session's queue. The writer feeds the source
  at real time; when the queue is empty it writes silence, so the mic never
  stalls and gaps between deltas sound like a pause.
- **Queue cap 120 s.** Realtime models emit audio faster than real time. Past
  the cap the server stops reading the request body; TCP backpressure slows
  the agent. Nothing is dropped.
- **One uplink at a time.** A second `POST` while one is open → `409 uplink_busy`.
- When the agent ends the body, the remaining queue plays out, then the
  response is `200 { "played_ms": … }`. If the session ends first, the
  response is sent immediately with what had played.
- `404 audio_not_started` if the tab has no audio session.

`played_ms` is cumulative since this uplink opened, measured as samples handed
to `pacat`. Accuracy is about ±40 ms (`pacat` buffer plus one tick).

### `POST /api/browser/tabs/:session_id/audio/clear`: interrupt

Empties the uplink queue immediately. Returns:

```json
{ "played_ms": 18240, "cleared_ms": 3100 }
```

The agent knows the byte offset at which each response item started, so
`audio_end_ms = played_ms − item_start_ms` goes straight into the realtime
API's `conversation.item.truncate`. Clearing with no uplink open is a no-op
returning zeros.

## Lifecycle

- **Daemon.** Started before the first Chromium spawn when
  `BROWSER_AUDIO_ENABLED`. On crash, restart. Every live audio session ends
  with `audio_daemon_exit`, and those users' Chromiums are marked
  `needsAudioRestart`, because Chromium does not reliably reattach to a new
  daemon. Their next `browser_audio_start` returns `BROWSER_RESTART_REQUIRED`.
- **Devices.** Created at Chromium spawn, destroyed on Chromium exit. The
  reaper also unloads `wb_*` modules with no live Chromium behind them (server
  restart, crash).
- **Keep-alive.** An open SSE stream or uplink counts as activity on the tab,
  so `BROWSER_SESSION_TTL_SECONDS` never reaps a Chromium mid-call.
- **Cap.** `BROWSER_AUDIO_MAX_MINUTES` (default 120) ends the session with
  `max_duration`.
- **Ending a session** (stop tool, bound tab closed, Chromium exit, daemon
  exit, cap, capture or playback process death) does all of:
  kill `parec`/writer; send `ended{reason}` and close the SSE; finish the
  uplink response with `200 { played_ms }`; revoke the mic permission
  (`Browser.resetPermissions` for the origin); drop the map entry. The devices
  stay as long as Chromium does.

## Failure handling

| failure | behaviour |
|---|---|
| capture process dies | `ended{capture_failed}`. No silent half-duplex. |
| writer process dies | `ended{playback_failed}` |
| SSE reader too slow | drop frames, `seq` gaps |
| uplink queue at 120 s | stop reading body (backpressure) |
| streaming forward hop fails at network layer | handle locally → `404 audio_not_started` |
| daemon dies | `ended{audio_daemon_exit}` for all, Chromiums flagged for restart |
| pod rollout remaps the user's key | Chromium dies with its pod → `ended{browser_exit}`; rejoining is up to the agent |

## Security

- Every request authenticates via Bearer or API key. Tab lookup is scoped to
  the caller's own session (as `resolveTab` does), so another user's tab id
  never resolves. The routing header grants nothing.
- Mic permission is granted only to the bound tab's origin, and revoked when
  the session ends.
- Audio content is never logged. The `browser_audio_start`/`stop` tool calls
  write `audit_log` rows as every tool call does; frames and HTTP stream
  requests do not.
- The uplink route lives in its own Fastify scope with
  `removeAllContentTypeParsers()` and a single raw-stream parser for
  `audio/pcm`. A child scope inherits every app-level parser
  ([finding](../../findings/2026-09-15-workspace-inherited-form-parser.md)),
  so the test runs on an app carrying the real boot's parsers.
- The docs page tells operators that an agent joining calls should identify
  itself to participants. Recording and consent law is the operator's
  responsibility; workbench does not enforce it.

## Configuration

| env | default | meaning |
|---|---|---|
| `BROWSER_AUDIO_ENABLED` | `false` | start the daemon, create devices at Chromium spawn, register tools and routes |
| `BROWSER_AUDIO_MAX_MINUTES` | `120` | hard cap per audio session |

With the flag off, the image still contains PulseAudio but nothing starts it,
and the tools return `AUDIO_DISABLED`.

## Testing

- **`pulse.ts`**: unit tests with a faked `pactl`/process spawner. Covers
  device create, idempotency, destroy, `wb_*` listing, daemon restart emitting
  `daemon-exit`.
- **`session.ts`**: fake capture stream and fake `pacat` sink. Covers 40 ms
  framing and `seq`, the `played_ms` clock, silence padding, `clear` math,
  backpressure at the cap, reader replacement (`ended{replaced}`), `409
  uplink_busy`, `AUDIO_BUSY`, every end path sending `ended` and closing the
  uplink.
- **Routes**: Fastify `inject` / real listener for SSE framing and the
  404/409 paths. Raw-body parser tested on an app carrying the real boot's
  parsers. Streaming forward tested across two app instances: wrong-pod GET
  and POST are piped through; a verifying inbound header is handled locally;
  a dead upstream falls through to `404`.
- **Browser plugin**: `browser_audio_start` grants permission to the tab's
  origin, `BROWSER_RESTART_REQUIRED` when Chromium lacks devices,
  `TAB_NOT_FOUND` for another user's tab.
- **Integration (opt-in, `AUDIO_E2E=1`, runs in the Docker image)**: real
  PulseAudio and Chromium on a local test page. The page plays a 440 Hz tone
  via WebAudio; the test asserts 440 Hz dominates the SSE PCM. The test then
  writes 880 Hz into the uplink; the page records `getUserMedia` and reports
  the dominant frequency back; the test asserts 880 Hz.

## Release

- Dockerfile installs `pulseaudio` and `pulseaudio-utils`. Image change plus
  a new proxy path means this ships as `vX.Y.Z-rc.N` first.
- Release notes in `docs/releases/vX.Y.Z.md`.
- Finding: `docs/findings/2026-10-xx-browser-audio-pipeline.md` covering what
  the integration test teaches (daemon-as-child in a container, remap-source
  of a monitor as Chromium's default mic, measured `played_ms` accuracy).
- Docs page in `docs/site/_content/` covering the agent-side loop: realtime
  model ↔ SSE and uplink, interruption via `clear` → `conversation.item.truncate`,
  the routing header, and the one-call-per-user limit. Linked from `nav.json`.

## Out of scope

Transcripts, VAD, TTS/STT adapters, per-speaker streams, more than one call
per user, a synchronous per-utterance `POST` mode, muting other tabs of the
same user (audio from another tab of the same user leaks into the stream;
documented, not engineered around).
