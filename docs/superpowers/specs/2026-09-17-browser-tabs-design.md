# Browser tabs: `session_id` names a tab, affinity comes from the bearer

**Date:** 2026-09-17
**Status:** approved in chat, awaiting spec review
**Ships as:** release candidate (touches auth path and proxy routing)

## Problem

One user, one Chromium, one page. `browser_start` returns
`session_id = HMAC(SESSION_SECRET, userId)`, the same value every time, and
every `browser_*` tool takes it back only so the MCP endpoint can copy it into
`X-Browser-Session` and let the mesh hash the request to the replica that owns
the Chromium process ([finding](../../findings/2026-09-10-browser-session-pod-affinity.md)).

Two things are wrong with that shape.

1. The routing key is redundant on the agent path. The MCP endpoint
   authenticates the bearer and knows `userId` before it forwards
   (`packages/server/src/index.ts`), then scans `executions[].args` for a
   `session_id` that is a pure function of that same `userId`. The agent is
   carrying a value the server could compute.
2. It leaves no room for a second tab. Two agents (or one agent with
   subagents) driving the same user share one page and step on each other.

## Decision

- **Affinity is derived server-side from the authenticated user.** The MCP
  and REST endpoints set `X-Browser-Session: mintSessionKey(userId)` on the
  forwarded hop whenever the call touches a `browser_*` tool. Agents never
  see or send the routing key.
- **`session_id` becomes a tab handle.** `browser_start` opens a new tab and
  returns its id. Every other `browser_*` tool resolves `session_id` to a tab
  inside the caller's own Chromium. The field name is unchanged so existing
  prompts and docs examples keep working; its meaning changes from "routing
  key" to "which tab".
- **One Chromium per user stays.** One process, one profile, one cookie jar,
  one download sink. Tabs are page targets inside it.

The routing key keeps its HMAC form rather than the raw `userId`: the portal
live view already hashes on it, and a user id does not belong in mesh headers
or proxy access logs.

## Affinity

### MCP (`POST /mcp`)

Replace the `executions[].args.session_id` scan in the forward hook with:

```
needsAffinity = body.method === "tools/call" &&
  executions.some(e => typeof e.tool === "string" && e.tool.startsWith("browser_"))
```

When `INTERNAL_MCP_URL` is set, the inbound request carries no
`X-Browser-Session`, and `needsAffinity` holds, forward with
`X-Browser-Session: mintSessionKey(userId)`. Everything else about the hop is
unchanged (auth pass-through, 30 s timeout, 202 on empty body, fall through to
local handling on network error).

A direct `tools/call` of `browser_start` (not wrapped in `execute_tools`) is
also a `browser_*` call and also forwards. Today it is handled locally because
it has no `session_id`; after this change it opens a tab, so it must land on
the owning replica.

### REST (`POST /rest/:integration`)

`rest-routes.ts` does not forward at all today, so under `CLUSTER_ENABLED` a
`POST /rest/browser` can spawn a second Chromium on the shared profile. Extract
the forward logic from `index.ts` into
`packages/server/src/auth/affinity-forward.ts`:

```ts
export async function forwardForBrowserAffinity(opts: {
  userId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  target: string;          // absolute URL on the internal service
  body: unknown;           // what to send, already parsed
}): Promise<boolean>;      // true = reply already sent
```

`index.ts` calls it with `config.INTERNAL_MCP_URL`; `rest-routes.ts` calls it
for `integration === "browser"` with the same origin and path `/rest/browser`
(derive: `new URL("/rest/browser", config.INTERNAL_MCP_URL).toString()`).
No new config variable.

### Receiving side

Unchanged: `X-Browser-Session` present → handle locally. The header is still
verified against the bearer's user by the CDP bridge routes. Tool handlers no
longer call `verifySessionKey`; `badSessionKey` and `BAD_SESSION_KEY` are
deleted.

### Portal live view

Unchanged. The portal's `/attach` still mints the key and the client sends
the header on `events`/`commands`/`detach`, because those requests meet the
proxy before any server code runs. Both paths hash on the same value, so the
view and the tools land on the same replica.

## Tabs

### Session shape

```ts
interface Tab {
  id: string;             // chromium targetId, opaque to the agent
  cdp: CdpClient;         // page-level client on this target's ws
  lastActivity: number;
  lastShotHash?: string;  // was on WarmSession; screenshots are per tab
  createdAt: number;
}

interface WarmSession {
  // as today, minus cdp / cdpPageWsUrl / lastShotHash, plus:
  tabs: Map<string, Tab>;
  defaultTabId: string;   // the page chromium opened at spawn
}
```

`WarmSession.lastActivity` becomes the max over tabs plus session-level
actions (downloads, cookie capture). `touch(userId)` keeps working; add
`touchTab(userId, tabId)`.

### Opening

`browser_start` (no args) → `ensureSession(userId)` → if
`tabs.size >= BROWSER_TAB_LIMIT` return `{ error: "BROWSER_TAB_LIMIT", limit }`
→ `Target.createTarget({ url: "about:blank" })` on the browser-level client →
look up `webSocketDebuggerUrl` for that `targetId` from
`http://127.0.0.1:<port>/json/list` → open a `CdpClient` on it → insert the
`Tab` → return `{ session_id: targetId }`.

The tab the spawn already opened is registered as `defaultTabId` at
`ensureSession` time but is **not** handed out by `browser_start`; it serves
compat and the live view (below). First `browser_start` on a fresh session
therefore opens a second page. That is one cheap `about:blank`; simpler than
"first call gets the default, later calls create".

`BROWSER_TAB_LIMIT`: config, integer, default 8.

### Resolving

Every `browser_*` tool except `browser_start` and `browser_live_url` takes
`session_id` and resolves it:

```
resolveTab(userId, session_id):
  s = warmSessions.get(userId)
  if s && s.tabs.has(session_id) → that tab
  if verifySessionKey(session_id, userId) → ensureSession(userId), default tab   (compat, one release)
  else → { error: "BROWSER_TAB_NOT_FOUND", detail: "call browser_start and pass the session_id it returns" }
```

The compat branch means an agent holding a pre-upgrade routing key keeps
driving the default tab. Remove it in the release after this one.

A tab id from another user's Chromium can never resolve: lookup is scoped to
the caller's `WarmSession`, and target ids are not guessable in a useful way
(the attacker would need a live target in the victim's process, which they
cannot reach). No HMAC on the tab id.

### Per-tab tools

`navigate`, `screenshot`, `click`, `type`, `key`, `scroll`, `read_text`,
`evaluate`, `upload_file` operate on `tab.cdp`. Their bodies in
`browser-session.ts` change signature from `(s: WarmSession, …)` to
`(tab: Tab, …)`. `lastShotHash` moves with `screenshot`.

`expect_download` / `await_download` are browser-level (the sink is the
user's workspace, `Browser.download*` events are not per page) and only
resolve `session_id` for validation; they keep running on `browserCdp`.

`browser_close` closes **the tab**: `Target.closeTarget`, close its client,
delete from the map. Closing the last non-default tab leaves the session
warm for the idle reaper. Closing the default tab is allowed; the session
then has no default until the next `ensureSession` re-registers one from
`/json/list` (first live page, else create one).

`browser_live_url` is unchanged: no `session_id`, it is per user.

### New tool

`browser_tabs` (no args) → `{ tabs: [{ session_id, url, title, active }] }`
from `Target.getTargets` filtered to `type === "page"` and joined with the
map (targets not in the map, e.g. popups, are listed with `active: false`
and cannot be driven). Lets an agent recover after losing a handle.

### Lifecycle

- A tab whose ws closes (`onGone`) is dropped from the map; the session
  stays up.
- `closeBrowserSession` closes every tab client before killing the process.
- `proc.on("exit")` clears the map.
- No per-tab idle reaper. `BROWSER_SESSION_TTL_SECONDS` (default 300 s idle)
  already bounds an abandoned session, and the cap bounds an abandoned tab
  set. Revisit if the cap is hit in practice.
- Concurrency: calls on different tabs run concurrently; calls on one tab
  interleave exactly as they do today (CdpClient multiplexes by id).

### Live view

Follows `defaultTabId`. The bridge's `ensureUpstream` dials the default tab's
ws (today: `cdpPageWsUrl`). A tab picker in the portal is a separate change;
this spec only guarantees the view keeps working.

## Errors

| Code | When |
|---|---|
| `BROWSER_TAB_NOT_FOUND` | `session_id` is neither a live tab of this user nor the compat routing key |
| `BROWSER_TAB_LIMIT` | `browser_start` with `BROWSER_TAB_LIMIT` tabs already open; `limit` in payload |
| `BROWSER_SESSION_BUSY` | unchanged |

`BAD_SESSION_KEY` is removed.

## Testing

Server, `packages/server/tests`:

- `mcp-browser-proxy.test.ts`: rewrite. Forward header equals
  `mintSessionKey(userId)` for a wrapped `browser_*` call **with no
  `session_id` in args**; no forward for a non-browser call even if an arg
  named `session_id` is present; direct `browser_start` `tools/call`
  forwards; inbound header short-circuits.
- new `rest-browser-proxy.test.ts`: `POST /rest/browser` forwards with the
  same header under `INTERNAL_MCP_URL`; `POST /rest/github` does not.
- `browser-session.test.ts`: `ensureSession` registers the default tab;
  `openTab` creates a target, registers it, returns the id; limit refused at
  8; `closeTab` removes it and leaves the session; tab ws `onGone` removes
  only that tab; `closeBrowserSession` closes all tab clients.
- `browser-actions.test.ts` / `browser-file-transfer.test.ts`: handlers
  resolve `session_id` to a tab; unknown id → `BROWSER_TAB_NOT_FOUND`;
  compat key → default tab; two tabs, `navigate` on A does not change B's
  url; screenshot hash is per tab.
- `browser-meta-tools.test.ts`: `browser_start` returns a fresh id per call;
  `browser_tabs` lists them; `browser_close` closes one tab.
- Tests that stub `spawnProfileChromium` need a fake `/json/list` and
  `Target.createTarget`; extend the existing CDP fake in
  `cdp-bridge.chromium.test.ts` helpers rather than adding a new one.

Portal: no change.

## Docs

- `docs/site/_content/integrations/browser.md`: rewrite "One user, one
  browser, one page" to "One user, one browser, many tabs"; `session_id` is a
  tab; `browser_tabs`; cap; live view follows the default tab; affinity is
  invisible to the agent.
- `docs/findings/2026-09-17-browser-affinity-from-bearer.md`: why the agent
  never needed to carry the routing key, and the REST path that was never
  forwarded.
- `docs/releases/v0.30.0.md` (new minor, RC first): feature bullet +
  compat note on the one-release grace for old `session_id` values.

## Out of scope

- Portal live-view tab picker.
- Per-tab idle reaping.
- Removing the compat branch (next release).
- Any change to cookie capture, downloads, or the workspace.
