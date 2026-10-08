# Browser audio pipeline: one PulseAudio daemon per user chromium

**Date:** 2026-10-07

## What we needed

An agent running a full-duplex voice model has to hear and speak in a browser
call (Zoom web, Slack huddle, Meet) driven through the built-in browser.
Headless chromium has no audio devices.

## What we found

- Hooking audio inside the page (getUserMedia override, AudioContext taps,
  WebRTC track listeners) breaks per app: Zoom web mixes in WASM/worklets,
  huddles run in iframes, and a patched getUserMedia is detectable. OS-level
  virtual devices are the only app-agnostic layer.
- Chromium reads `PULSE_SINK`/`PULSE_SOURCE` once at spawn, so devices must
  exist before chromium starts; an already-running chromium needs a restart
  (`BROWSER_RESTART_REQUIRED`, then `restart: true`).
- **The daemon must be per user, not per process.** With one shared daemon,
  chromium's `enumerateDevices()` lists every user's `wb_sink_*.monitor` and
  sinks, so a page in user A's browser could `getUserMedia({deviceId})` user B's
  call audio, or `setSinkId` into B's microphone. Each user gets their own
  daemon in a `mkdtemp` runtime dir (unpredictable, `0700`) with an
  anonymous-auth unix socket; helper processes get a minimal environment (no
  `SESSION_SECRET`). The device key is 16 hex characters of an HMAC of the user
  id. Measured: chromium enumerates only its own daemon's devices.
- A `module-pipe-source` fixes its rate at load time and stalls rather than
  producing silence on underrun. The mic is instead a null sink `wb_mic_*` with
  a `module-remap-source` over its monitor, so `pacat --rate` resamples and the
  mic stays live between turns.
- Pacing agent audio in the server (one 20 ms frame per tick into `pacat
  --latency-msec=20`, monotonic clock, at most 5 ticks of catch-up) keeps the
  queue in-process, so `clear` is instant and `played_ms` is accurate to about
  ±40 ms in steady state (catch-up after an event-loop stall can briefly exceed
  that), which is what `conversation.item.truncate` needs. Frames are written
  as **whole samples only**: after an underrun a chunk boundary that split a
  16-bit sample would shift every later sample by a byte and turn the rest of
  the call into noise. `played_ms` counts agent audio only.
- The mic permission is granted to at most one origin at a time. It follows
  main-frame navigation (revoke the old origin, grant the new one) and is
  revoked on end, with a `Browser.resetPermissions` fallback if a revoke fails.
- The buffered affinity forward cannot carry an SSE stream or an uplink held
  open for a call. A `node:http` pipe can; fetch cannot (undici's 300 s
  `headersTimeout` fires before an uplink's response headers arrive).
- The forward target must be the internal origin plus the request's path and
  query only. `new URL(request.url, internal)` lets an absolute-form request
  target (`POST http://evil.example/...`) override the origin, sending the
  caller's bearer or API key to another host. Found by automated security
  review; regression-tested with a raw request line.
- Real end-to-end run (Docker on macOS arm64 under colima, PulseAudio as the
  image's user, no extra flags beyond the documented spawn env): downlink tone
  440 Hz measured 440 to 442.5 Hz, uplink tone 880 Hz measured 877.5 Hz.
  Start-up was 0.4 to 2.75 s typical (one 9.9 s outlier). Dropouts after first
  audio were 0 to 0.2 of 40 ms blocks (one run at 0.33). The downlink
  measurement is retried once in the test. **Native Linux has not been measured;
  that is a release gate.**
- Operational lessons from getting that run: macOS has no `timeout` binary (an
  unbounded `docker exec` hung an agent for an hour; use a perl `alarm` shim). A
  CPU-starved colima VM (load around 155 from unrelated containers) made `npm
  ci`, chromium spawn and image builds fail in confusing ways. A chromium
  leaked by a 20-day-old vitest run (`workbench-vitest-*/browser-profiles`,
  ppid 1) burned about two host cores and caused unrelated test timeouts.

## What changed

PulseAudio daemon per user (`audio/pulse.ts`), `AudioSession`
(`audio/session.ts`), per-user manager with mic permission that follows
main-frame navigation (`audio/manager.ts`), routes keyed by tab
(`audio/routes.ts`), streaming forward (`audio/stream-forward.ts`),
`browser_audio_start`/`browser_audio_stop`. Behind `BROWSER_AUDIO_ENABLED`.

## Limits

One call per user. Audio from the user's other tabs leaks into the stream. A
pod rollout ends live calls. Recording/consent is the operator's
responsibility.
