# Sign-up waiting room

Date: 2026-11-28

With `REQUIRE_SIGNUP_APPROVAL` on, a new account is created `pending`. Both SSO
callbacks used to redirect to `/login?error=account_pending`. They now redirect
to the portal `/waiting` page, which polls `GET /api/auth/waiting` and, on
approval, continues into a normal sign-in.

## Why a signed cookie and not a session

The pending person has no session, and must not get one: every guard in the
server treats a session as proof the account may be used. A short-lived
`awb_waiting` cookie carries `userId`, provider and a 7 day expiry, signed with
HMAC-SHA256 over `SESSION_SECRET`. It is httpOnly, SameSite=Lax and scoped to
`Path=/api/auth`, so it is never sent to `/mcp` or the rest of the API. It
authorizes exactly one read: the coarse state below. It cannot be exchanged for a
token. The pending cap case (no user row was created) has nothing to bind, so it
keeps the old `/login?error=account_pending` redirect.

## Why a silent SSO bounce

When the state turns `active`, the page starts the same SSO flow as the login
button (`fetchAuthUrl` or `fetchKeycloakAuthUrl` with a fresh login-ceremony
nonce, for the provider recorded in the cookie). The provider still has its own
session, so the person comes straight back with the usual `#token=` fragment and
the existing nonce check and return path (`awb_return_to`) apply unchanged. No
endpoint issues a session or token for a waiting person, so approval grants no new
way in.

## The state endpoint leaks nothing

`GET /api/auth/waiting` takes no bearer and answers `{ state, provider }` and
nothing else: `pending`, `declined`, `active` or `none`. A missing, malformed,
tampered or expired cookie, and a disabled or missing user, all answer `none`
with a null provider, so the endpoint cannot be used to probe for accounts. No
email, id or decision note is returned. Declined reuses the sign-in rule (latest
request rejected less than 24 hours ago, see `isRecentlyDeclined`) but only reads;
polling never opens a request. Responses are `Cache-Control: no-store` and a small
per-IP in-process limit (60 per minute, approximate across replicas) answers 429.

## Polling policy

The page polls immediately, again whenever the tab regains focus or becomes
visible (restarting the schedule), and on a timer that starts at 5 seconds and
doubles to a 60 second cap while visible. It pauses while hidden and stops on
`active`, `declined` or `none`. A network error keeps the last state and keeps
backing off, with nothing alarming on screen.
