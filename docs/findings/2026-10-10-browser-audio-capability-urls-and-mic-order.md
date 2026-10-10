# Browser audio: capability URLs, and the mic grant must land before the page loads

**Date:** 2026-10-10

## What we needed

A voice client (slaude voice mode) joined a Jitsi call through workbench's
browser audio. Three things went wrong in its smoke test: every audio request
answered 401, the agent's microphone stayed muted on Jitsi's prejoin page, and
the bot's tab ended on `https://meet.jit.si/static/close3.html`.

## What we found

- **The client that carries a call is not the agent that started it.** The
  voice client holds the SSE stream and the uplink for the whole call and has no
  workbench token, so bearer auth on the audio routes could never work. The
  routes now take a capability URL (128 random bits per audio session,
  `/api/browser/audio/<cap>/stream|clear`) and nothing else. The registry is
  keyed by SHA-256 of the capability, so a Map lookup leaks no timing about the
  secret. The capability dies with the session, including an idle timeout, because
  a URL credential that outlives its call is a standing grant to someone's
  meeting audio.
- **One reader at a time needs a half-open guard.** "Last reader wins" lets
  anyone holding the URL take a call away from its client, so a second concurrent
  reader now gets 409. But a peer gone without a FIN would then hold the slot
  until TCP gives up (minutes), and every reconnect would get a 409. Audio at
  ~32 KB/s fills the kernel buffers within seconds, so a reader whose socket has
  not drained for 10 s is dropped. A test shows it: a paused client is detected
  and a reconnect then gets 200.
- **An unauthenticated forward must not parse the request target.** The
  cross-replica forward built its upstream path from the raw URL. `new URL()`
  resolves `%2e%2e` as a dot segment, so `/api/browser/audio/%2e%2e/stream`
  reached the internal service as `/api/browser/stream`. With bearer auth that
  was contained; with no auth it is a relay. Fix: reject any capability that is
  not the minted shape before lookup, and build the forward path from the
  validated capability and a fixed leaf.
- **A credential in a path leaks through the 404 handler and metrics.** Masking
  `req.url` in the request serializer is not enough. Fastify's default not-found
  handler logs `Route GET:<raw url> not found` as the *message*, and the metrics
  hook used the raw URL as the route label for unmatched requests, which
  `/metrics` serves. A catch-all route under the prefix answers every other path,
  and unmatched requests get the label `unmatched`.
- **The mic grant has to land before the meeting page loads.** Measured in a
  container against meet.jit.si with workbench's chromium flags and PulseAudio
  env. Jitsi calls `getUserMedia` while the page loads. Headless chromium denies
  a request whose permission is still `prompt`, and the page never asks again,
  so the mic shows muted. Granted before load, Jitsi takes the virtual mic and
  an 880 Hz tone into it is heard at 877 Hz. The tool text used to say "call it
  after opening the meeting page", which is exactly the losing order. The
  `restart: true` path had the same race, because it reopened the page before
  granting.
- **The camera is a red herring.** "You need to enable microphone and camera
  access" shows for any device warning, including "no camera". The joint
  audio+video request fails `NotFoundError`, Jitsi retries audio alone, and the
  mic works. Granting camera changes nothing.
  `--use-fake-device-for-media-stream` would add a camera but also replaces the
  PulseAudio mic with a fake one, and chromium has no video-only variant.
- **A revoked mic does not come back.** Ending the audio session revokes the
  grant, and Jitsi's track goes `ended`. Toggling mute in the page cannot revive
  it; the page has to reload or rejoin. That is why "toggling did nothing".
- **`close3.html` is Jitsi's own post-hangup page.** meet.jit.si sets
  `enableClosePage`, so every hangup goes there: the Leave button, leaving the
  lobby, a kick, the meeting ending for everyone, or cancelling the
  lobby/password/wait-for-host prompts. Nothing in workbench navigates there. A
  background tab sitting alone in the lobby for 6 minutes did not navigate. A
  fresh meet.jit.si room holds a guest in "waiting for moderator" until a
  signed-in host arrives.

## What changed

- `audio/capability.ts`, capability routes, single-reader 409 with a stall drop,
  path-pinned forward, log/metrics/span hygiene.
- `browser_audio_start` is documented to be called on the blank tab before
  navigating. `restart: true` grants before reopening.
- A fresh session waits `BROWSER_AUDIO_FIRST_ATTACH_SECONDS` (default 600) for
  its first reader or uplink, because the client may be waiting on a human to
  approve the call. After that, 60 s with nothing attached still ends it.
- Landing on a known post-call page (`isPostCallPage` in `audio/manager.ts`,
  today Jitsi's `/static/close*.html`) ends the session with `page_left`, so a
  client with no browser access learns the call is over. A plain origin change is
  deliberately not a signal: join flows hop origins (landing page, web client,
  SSO).

## Limits

- Only Jitsi's post-call page is recognised. Zoom, Meet and Slack leave pages
  were not observed, so they are not guessed; add them from a real run.
- The banner about the camera remains on Jitsi; `#config.startWithVideoMuted=true`
  on the meeting URL hides it.
