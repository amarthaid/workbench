# Browser file transfer

_2026-09-15_

## Problem

The browser integration can drive a page but cannot move a file in either
direction.

**Out.** A page-triggered download lands in the browser process's own temp
directory. No tool can read it, so "click Download CSV and send it to Slack"
has no expressible form — the agent gets as far as the click and stops.

**In.** There is no way to put a file into an `<input type="file">`. Any flow
that ends in an upload form is a dead end.

Both block on the same thing. `CdpClient` discards every CDP event
(`auth/browser-session.ts:35`):

```ts
if (typeof msg.id !== "number") return;
```

Only command replies are dispatched; there is no subscription mechanism at all.
`Browser.downloadWillBegin`, `Browser.downloadProgress` and every
`Network.*` event land on that line and are dropped. Nothing downstream can be
built until events exist.

## Where it lives in the code

- `auth/browser-session.ts` — `CdpClient` (`:12-82`), `WarmSession` (`:85-95`),
  the tool-facing verbs (`navigate`, `screenshot`, `click`, … `:204-323`)
- `plugins/internal/browser.ts` — the nine tools; internal, not under
  `PLUGINS_DIR`, so a third-party plugin can never drive the logged-in browser
- `auth/profile-chromium.ts:244-245` — the session already holds **both**
  `cdpBrowserWsUrl` and `cdpPageWsUrl`; `cdpCall` one-shots against the former
  (used by `captureLiveCookies`, `browser-session.ts:167`)

Depends on the workspace from
`2026-09-15-agent-file-workspace-design.md`. Downloads land there; uploads are
read from there.

## Scope

In: CDP event subscription, download capture to the workspace, upload from the
workspace into a file input.

Out, deferred to a later spec: network observation (`Network.*` — the in-band
replacement for "open DevTools and copy as cURL") and selector-addressed
interaction. Both build on the event layer landed here; neither is needed for
file transfer.

## Design

### 1. Events in `CdpClient`

Keep the id-keyed `pending` map for commands; add a listener map for
everything else.

```ts
on(method: string, fn: (params: Record<string, unknown>) => void): () => void;
```

Returns an unsubscribe so a download watcher cleans up after itself and a long
session does not accumulate handlers. In `message`, a frame with no `id` is an
event: look up `msg.method`, call each listener inside a `try/catch` so one
throwing listener cannot take down the socket.

`handleGone` must clear listeners alongside `drainPending` — a socket that
closes mid-download has to reject the waiter, not leave it hanging until the
10 s command timeout that does not apply to it.

### 2. A browser-level client

`Browser.setDownloadBehavior` and the `Browser.download*` events live on the
**browser** target. The session's `cdp` is attached to the *page* target
(`:121`). The page-level `Page.downloadWillBegin` equivalents are deprecated
and should not be used.

`cdpCall` cannot carry events — it is one-shot. So `WarmSession` gains a
lazily-created second `CdpClient` on `cdpBrowserWsUrl`, created on first
download-capable call and closed with the session. Lazy, because a session that
never downloads should not pay for a second socket.

### 3. Download capture

On first use, against the browser client:

```ts
Browser.setDownloadBehavior({
  behavior: "allowAndName",
  downloadPath: <user workspace dir>,
  eventsEnabled: true,
})
```

`allowAndName` — not `allow` — names each file on disk by its download GUID.
Two reasons, and the second matters more than the first:

1. **No collisions.** Downloading `statement.csv` twice does not produce
   `statement (1).csv` or clobber.
2. **`suggestedFilename` is attacker-controlled.** It comes from the remote
   server's `Content-Disposition`. Under `allow`, chromium writes to a path
   derived from it. Under `allowAndName`, the on-disk name is a GUID we
   generated and the suggested name is just a string we sanitize on our own
   terms.

Flow:

- `Browser.downloadWillBegin` → `{ guid, url, suggestedFilename }`; record it
- `Browser.downloadProgress` → `{ guid, state, receivedBytes, totalBytes }`;
  resolve on `"completed"`, reject on `"canceled"`
- on completion, rename `<workspace>/<guid>` → `<workspace>/<safe name>`,
  where the safe name is `suggestedFilename` through `safeRelPath` plus
  basename-only and a collision suffix. Same-directory rename, so atomic.
- enforce `WORKSPACE_MAX_FILE_BYTES` from `totalBytes` when the server sends
  it, and again on the completed file when it does not

### 4. Tool shape

A download is a side effect of a *click*, not a callable verb — the agent
cannot call `browser_download(url)` because the URL is what it does not know.
So arm first, then act:

- `browser_expect_download({ timeoutMs })` — subscribe, return a handle
- the agent clicks
- `browser_await_download({ handle })` — resolve to
  `{ name, bytes, workspacePath }`

The alternative — having `browser_click` implicitly wait — makes every click
pay a timeout for a download that usually is not coming. Explicit arming keeps
the cost where the intent is.

A captured file inherits the workspace retention contract: deleted 24 hours
after it lands, with no grace for anything still using it. `browser_await_download`
returns the expiry alongside the name, and the tool description says so, so an
agent that needs the file to outlive the window knows to hand it to Drive or
Slack in the same run.

Idle-session reaping (`reapIdleSessions`, `BROWSER_SESSION_TTL_SECONDS = 300`)
must not close a session with a download in flight: `touch()` on each
`downloadProgress`, so a long transfer keeps its own session alive.

### 5. Upload

`DOM.setFileInputFiles` takes **absolute, server-side paths** and works only
because chromium runs on the same host as the server. That is the whole reason
this is simple, and it is worth stating in a comment — it is the assumption
that breaks first if the browser is ever moved to its own pod.

Rather than `DOM.enable` + `getDocument` + `querySelector` (which introduces
nodeId staleness across navigations), go through the already-enabled `Runtime`
domain:

- `Runtime.evaluate({ expression: "document.querySelector(<sel>)" })` →
  `objectId`
- `DOM.setFileInputFiles({ objectId, files: [<absolute workspace path>] })`

Tool: `browser_upload_file({ selector, name })`. `name` is a workspace-relative
name resolved server-side against the calling user's root — the agent never
supplies a path, and the resolved absolute path never leaves the server. An
arbitrary absolute path here would be an arbitrary-file-read primitive
(chromium would happily upload `/etc/passwd` to a remote form), which is
precisely why the workspace spec keeps resolution server-side.

Verify the node is an `<input type="file">` before the call and return a clear
error if not; CDP's own message for the wrong node type is unhelpful.

## Testing

- `CdpClient`: event dispatch by method, unsubscribe stops delivery, a throwing
  listener does not kill the socket, `handleGone` clears listeners and rejects
  in-flight waiters
- download: GUID file renamed to the sanitized suggested name; a
  `suggestedFilename` of `../../escape.csv` stays inside the workspace; two
  downloads of the same name both survive; `canceled` rejects; oversize rejects
  and leaves no partial
- idle reaper does not close a session mid-download
- upload: non-file-input selector errors clearly; a `name` containing `..` or
  an absolute path is refused before any CDP call
- end to end against a local fixture page: click → download → file in
  workspace → `files_list` shows it

## Notes

The thread that prompted this asked for DevTools to be enabled in the remote
chromium so a human could copy a request as cURL. That is worth *not* doing:
it still requires a person at the live view, so it does not reach automation.
Download capture removes the need for it in this flow, and the deferred
network-observation work removes it in general.
