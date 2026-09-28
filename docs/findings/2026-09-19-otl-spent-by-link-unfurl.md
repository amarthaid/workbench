# One-time vault links were spent by chat link previews

**Date:** 2026-09-19

## Symptom

A one-time link (`/api/vault/otl/:token`, from the portal's **One-time link**
or from `vault_presign`) pasted into Slack was already gone, a `404`, by the
time the human or agent it was meant for fetched it.

## Cause

The redeem was a `GET`, and the `GET` spent the token. Slack fetches every link
pasted into a message to build its unfurl preview (`Slackbot-LinkExpanding`),
and so do Teams, Discord, iMessage, and many mail link scanners. The preview
fetch was the first `GET`, so it received the value and destroyed the link. No
one saw the value, since unfurlers don't render `text/plain` attachments, but
the link was spent all the same.

Matching unfurlers by `User-Agent` does not fix it. The list has no end, some
scanners send a browser UA, and a security check that trusts a header the
caller chooses is backwards.

## Fix

Only `POST` spends the token (`packages/server/src/vault/routes.ts`):

- `POST /api/vault/otl/:token` redeems once. Same body, headers and single-use
  `DELETE` arbitration as before.
- `GET` never redeems. With `Accept: text/html` it returns a static page with a
  **Download secret** button: a form `POST` with no script, a
  `default-src 'none'` CSP, and nothing about the token (not even whether it is
  live). Any other `GET` returns `405` with `Allow: POST` and a hint naming the
  `POST`. That way a script still running the old bare `curl "$URL"` fails
  under `-f` instead of writing an HTML page into its `.env`.
- Unfurlers only `GET`, and a rendered preview runs no script and submits no
  form, so the link survives.

The form uses `enctype="text/plain"` because Fastify parses that type by
default. A urlencoded parser exists in the real boot only because jots and
OAuth register one, and this route should not depend on that.

**Breaking for callers:** `curl -fsS "$URL"` becomes `curl -fsS -X POST "$URL"`.
The `vault_presign` tool description and `docs/site/_content/integrations/vault.md`
say so. An agent that still sends a `GET` gets a `405` that names the fix, and
the value is not lost.

## Unfurl card

Since the `GET` page is what a chat app previews anyway, it carries `og:` and
`twitter:` tags. With these, a pasted link unfurls as a branded card ("One-time
secret" on the workbench accent) instead of a bare URL. The image is
`og-otl-1200x630.png`, which the brand package renders (`packages/brand/build.mjs`,
committed copy in `docs/assets/brand`). The portal's `copy-brand.mjs` copies it
into `public/`, and it is served from the portal root at `SERVER_PUBLIC_URL`.
Slack only fetches the image from a public origin, so a `localhost` link
unfurls without the picture.

## Follow-up (2026-09-28): the card never rendered in Slack

The page served its `og:` tags only when `Accept` contained `text/html`. Slack
does not send that. A capture through a logging proxy on a tunnelled local
instance showed:

```
GET /api/vault/otl/<token>
User-Agent: Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)
Accept: */*
Range: bytes=0-32768
```

So Slack got the plain-text 405 and showed no card. The test sent Slackbot an
invented `Accept: text/html,*/*;q=0.8`, which is why it passed.

The fix matches link-preview bots by `User-Agent` (Slackbot-LinkExpanding,
Twitterbot, facebookexternalhit, Discordbot, TelegramBot, WhatsApp,
LinkedInBot, SkypeUriPreview, …) and serves them the page. This does not
contradict the rejection above. There, the `User-Agent` would have decided
whether to *spend* the token, so one missing bot burned a secret. Here, it
only picks the page or the 405, and no `GET` spends. A missing bot costs its
card and nothing else. `curl "$URL"` still gets the 405.

After the fix, the same capture showed Slack fetching the page (200), then
the image as `Slackbot 1.0` and again as `Slack-ImgProxy`, then the favicon.

Two testing notes:

- Slack seemed to skip an URL on a host whose earlier fetch had failed:
  a fresh token on the same tunnel host produced no request at all, and the
  next one did. When re-testing, mint a new link and paste it on its own.
- The route logs nothing (`logLevel: "silent"`: the token is in the path).
  To see what an unfurler sends, put a header-logging proxy in front.
