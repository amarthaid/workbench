# CDP client dropped every event, and downloads live on the other target

_2026-09-15_

## What we found

The browser integration could command Chromium but could never observe it, and
the reason was one line in `CdpClient` (`auth/browser-session.ts`):

```ts
if (typeof msg.id !== "number") return;
```

CDP multiplexes two kinds of frame on one socket: command replies, which carry
the `id` you sent, and events, which carry a `method` and no `id`. The client
dispatched the first and discarded the second. Every event the browser has ever
emitted — `Browser.downloadProgress`, `Page.loadEventFired`,
`Network.responseReceived` — died there.

Nothing had noticed because every existing tool was request/response:
navigate, click, type, screenshot, read text. The gap only becomes visible the
moment you need to know that *something happened* rather than ask what is true
now — which is exactly what capturing a download requires.

## The second half: downloads are not on the page target

Adding an event subscription is not enough on its own.
`Browser.setDownloadBehavior` and the `Browser.download*` events live on the
**browser** target. The warm session's `cdp` is attached to the **page** target
(`browser-session.ts`), and the page-level equivalents
(`Page.setDownloadBehavior`, `Page.downloadWillBegin`) are deprecated.

`WarmSession` already carried `cdpBrowserWsUrl`, and `cdpCall` already used it
for `Storage.getCookies` — but `cdpCall` is one-shot, so it can issue a command
and cannot carry a subscription. The session needs a *second*, longer-lived
client on the browser target.

## What we changed

- `CdpClient.on(method, fn)` returning an unsubscribe. Each listener runs inside
  a `try/catch`: a throwing handler must not take the socket down for the
  session.
- `handleGone` clears listeners as well as draining pending commands. This is
  easy to miss and matters: an event waiter has **no command in flight**, so
  `drainPending` cannot reach it and the 10-second command timeout does not
  apply to it. Without the clear, a socket that dies mid-download leaves its
  waiter hanging on nothing.
- A lazily-created `browserCdp` on the session for the `Browser.*` domain,
  closed with the session.

## The one that bit during the build

Configuring download routing at session creation is right — one Chromium and one
profile per user means the directory is known before any page opens, and a
download nobody armed a wait for still lands somewhere useful.

But **awaiting** it there is wrong. `ensureSession` started blocking on a second
WebSocket handshake, which added a failure mode to every session start: a
browser endpoint that accepts the connection and then stalls would hang session
creation indefinitely, because a hang is not an error and nothing timed it out.
The existing `browser-session` suite caught it immediately — eight tests went
from passing to a five-second timeout apiece.

The fix is a memoized promise on the session: creation kicks routing off in the
background and never waits, and the one caller that genuinely needs routing to
be live (arming a download) awaits the same promise. A failure clears the memo
so a later attempt can retry rather than caching the failure forever.

The general shape is worth remembering: *setup that must happen early* and
*setup that must be finished before a specific operation* are different
requirements, and conflating them turns an optional dependency into a mandatory
one on the hot path.
