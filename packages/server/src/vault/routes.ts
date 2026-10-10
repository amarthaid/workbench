import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { resolveMcpUser } from "../auth/oauth-server/resolve";
import {
  deleteSecret,
  listSecrets,
  putSecret,
  readSecretValue,
  touchUsed,
  VaultError,
} from "./store";
import { consumeOtl, mintAdhocOtl, OTL_MAX_TTL_SECONDS, revokeFor } from "./otl";
import { authenticatePortal as authenticatePortalSession } from "../auth/portal-session";

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = await resolveMcpUser(request.headers as Record<string, string>);
  if (userId) return userId;
  const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  reply.header("WWW-Authenticate", `Bearer realm="a-workbench", resource_metadata="${prm}"`);
  reply.status(401).send({ error: "Unauthorized", resource_metadata: prm });
  return null;
}

// Writes are portal-only, deliberately narrower than `authenticate`: the
// vault's goal is that the agent can use a secret but never read or rewrite
// one. See ../auth/portal-session.ts.
const VAULT_FORBIDDEN = "Secrets are written and deleted from the portal only.";
const authenticatePortal = (request: FastifyRequest, reply: FastifyReply) =>
  authenticatePortalSession(request, reply, VAULT_FORBIDDEN);

// Portal-minted links default to 5 minutes: a human copies the URL into a chat
// by hand. The hard ceiling stays OTL_MAX_TTL_SECONDS.
export const OTL_PORTAL_DEFAULT_TTL_SECONDS = 300;

// What a browser (or a link unfurler) sees on GET. Says nothing about the
// token — not whether it is live, not whose it is — and runs no script, so a
// preview bot that renders it still spends nothing. `enctype="text/plain"`
// because Fastify parses that built in; the form has no fields, the body is
// empty either way.
//
// The og:/twitter: tags are the branded unfurl card chat apps show in place of
// a bare URL. The image is packages/brand's og-otl-1200x630.png, copied into
// the portal's public/ and served at the portal root, which is
// SERVER_PUBLIC_URL (built portal) or the dev server in front of it.
const OTL_TITLE = "workbench \u00b7 One-time secret";
const OTL_DESCRIPTION = "Open once, then it burns.";
const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect x="0" y="0" width="32" height="32" rx="7" fill="#853291"/><path d="M5 8 L10 24 L16 12 L22 24 L27 8" fill="none" stroke="#ffffff" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><g fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"><circle cx="5" cy="8" r="3" fill="#853291"/><rect x="24" y="5" width="6" height="6" rx="0.9" fill="#853291"/><polygon points="10,20.4 13.3,26.8 6.7,26.8" fill="#853291"/><polygon points="22,20.2 25.8,24 22,27.8 18.2,24" fill="#853291"/></g><circle cx="16" cy="12" r="3.7" fill="#ffffff"/></svg>';

function revealPage(): string {
  const image = `${config.SERVER_PUBLIC_URL}/og-otl-1200x630.png`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#853291">
<title>${OTL_TITLE}</title>
<meta name="description" content="${OTL_DESCRIPTION}">
<meta property="og:site_name" content="workbench">
<meta property="og:type" content="website">
<meta property="og:title" content="One-time secret">
<meta property="og:description" content="${OTL_DESCRIPTION}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="workbench one-time secret">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="One-time secret">
<meta name="twitter:description" content="${OTL_DESCRIPTION}">
<meta name="twitter:image" content="${image}">
<style>
:root{--accent:#853291;--bg:#fff;--card:#fff;--line:#e5b8ef;--text:#111928;--muted:#555;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--accent:#c98ad2;--bg:#111;--card:#1a1a1d;--line:#3a2a3d;--text:#e8eaed;--muted:#aaa;--on-accent:#111}}
body{font:15px/1.5 Inter,-apple-system,system-ui,sans-serif;margin:0;background:var(--bg);color:var(--text)}
main{max-width:32rem;margin:12vh auto;padding:0 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;letter-spacing:-.01em;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--accent);border-radius:10px;padding:24px}
h1{font-size:22px;margin:0 0 8px}
p{color:var(--muted);margin:0 0 20px}
button{font:inherit;font-weight:600;padding:.55rem 1.1rem;border-radius:6px;border:0;background:var(--accent);color:var(--on-accent);cursor:pointer}
</style></head>
<body><main>
<div class="brand">${MARK_SVG}<span>workbench</span></div>
<div class="card"><h1>One-time secret</h1>
<p>This link works once. Downloading the secret spends it, and it cannot be fetched again.</p>
<form method="post" enctype="text/plain"><button type="submit">Download secret</button></form></div>
</main></body></html>
`;
}

function statusFor(code: VaultError["code"]): number {
  switch (code) {
    case "INVALID_NAME":
    case "EMPTY_VALUE":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "TOO_LARGE":
      return 413;
  }
}

export async function registerVaultRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vault", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (!userId) return reply;
    return reply.send({ secrets: await listSecrets(userId) });
  });

  // The only route that ever carries a plaintext value, and only the portal
  // calls it. Fastify does not log bodies.
  app.put<{ Params: { name: string }; Body: unknown }>("/api/vault/:name", async (request, reply) => {
    const userId = await authenticatePortal(request, reply);
    if (!userId) return reply;
    const body = (request.body ?? {}) as { value?: unknown; description?: unknown };
    if (typeof body.value !== "string") return reply.code(400).send({ error: "INVALID_VALUE" });
    if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
      return reply.code(400).send({ error: "INVALID_DESCRIPTION" });
    }
    try {
      // Pass description through unchanged: undefined = leave the existing
      // description alone (store's UPDATE branch), null = clear it, string =
      // set it. Collapsing undefined to null here would wipe the description
      // on every value-only overwrite.
      const description = body.description as string | null | undefined;
      const { created } = await putSecret(userId, request.params.name, body.value, description);
      return reply.code(created ? 201 : 200).send({ ok: true, created });
    } catch (e) {
      if (e instanceof VaultError) return reply.code(statusFor(e.code)).send({ error: e.code });
      throw e;
    }
  });

  app.delete<{ Params: { name: string } }>("/api/vault/:name", async (request, reply) => {
    const userId = await authenticatePortal(request, reply);
    if (!userId) return reply;
    const gone = await deleteSecret(userId, request.params.name);
    if (!gone) return reply.code(404).send({ error: "NOT_FOUND" });
    await revokeFor(userId, request.params.name);
    return reply.code(204).send();
  });

  // Mint a one-time link for a value that is never stored in the vault. The
  // second route that carries a plaintext value in its body, portal-only for
  // the same reason PUT is: an agent credential must not be able to launder a
  // value through a link it can then fetch. Not exposed as an MCP tool.
  app.post<{ Body: unknown }>("/api/vault/otl", async (request, reply) => {
    const userId = await authenticatePortal(request, reply);
    if (!userId) return reply;
    const body = (request.body ?? {}) as { value?: unknown; ttl_seconds?: unknown };
    if (typeof body.value !== "string") return reply.code(400).send({ error: "INVALID_VALUE" });
    let ttl = OTL_PORTAL_DEFAULT_TTL_SECONDS;
    if (body.ttl_seconds !== undefined) {
      if (typeof body.ttl_seconds !== "number" || !Number.isFinite(body.ttl_seconds) || body.ttl_seconds < 1) {
        return reply.code(400).send({ error: "INVALID_TTL" });
      }
      ttl = Math.min(body.ttl_seconds, OTL_MAX_TTL_SECONDS);
    }
    try {
      const minted = await mintAdhocOtl(userId, body.value, ttl);
      return reply.code(201).send({ url: minted.url, expires_at: Math.ceil(minted.expiresAt / 1000) });
    } catch (e) {
      if (e instanceof VaultError) return reply.code(statusFor(e.code)).send({ error: e.code });
      throw e;
    }
  });

  // One-time redeem. No bearer: the token is the authorization, single-use,
  // minutes of TTL. The user whose value is read comes from the row. Silent in
  // the request log because the token is the URL.
  //
  // Link-preview fetchers, by User-Agent. They send `Accept: */*` (Slack's,
  // captured 2026-09-28: `Slackbot-LinkExpanding 1.0`, `Accept: */*`,
  // `Range: bytes=0-32768`), so without this they got the 405 and chat showed
  // no card. Matching here only picks page vs 405 — no GET spends the token —
  // so a bot missing from the list costs its card, never the secret.
  const UNFURL_BOT =
    /Slackbot-LinkExpanding|Slack-ImgProxy|Twitterbot|facebookexternalhit|Facebot|Discordbot|TelegramBot|WhatsApp|LinkedInBot|SkypeUriPreview|Iframely|Embedly|redditbot|Mastodon|Applebot/i;

  // Only POST spends the token. A GET never does: chat apps unfurl every link
  // they see (Slackbot, Teams, Discord, iMessage previews), so a link pasted
  // into Slack used to be spent by the preview fetch before the human or agent
  // it was meant for ever got to it. A browser GET gets a page with a button
  // that POSTs; any other GET is a 405 naming the POST, so a script still
  // running the old `curl "$URL"` fails loudly instead of writing a page of
  // HTML into its .env.
  app.get<{ Params: { token: string } }>(
    "/api/vault/otl/:token",
    { logLevel: "silent" },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-robots-tag", "noindex, nofollow");
      reply.header("referrer-policy", "no-referrer");
      const accept = String(request.headers.accept ?? "");
      const unfurler = UNFURL_BOT.test(String(request.headers["user-agent"] ?? ""));
      if (!accept.includes("text/html") && !unfurler) {
        reply.header("allow", "POST");
        return reply
          .code(405)
          .type("text/plain; charset=utf-8")
          .send("This one-time link is redeemed with POST, e.g. curl -fsS -X POST \"$URL\". A GET never spends it.\n");
      }
      reply.header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
      );
      return reply.type("text/html; charset=utf-8").send(revealPage());
    }
  );

  app.post<{ Params: { token: string } }>(
    "/api/vault/otl/:token",
    { logLevel: "silent" },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      reply.header("referrer-policy", "no-referrer");
      reply.header("content-disposition", 'attachment; filename="secret.txt"');
      const grant = await consumeOtl(request.params.token);
      if (!grant) return reply.code(404).send();
      // Ad hoc: the value came out of the row itself; nothing to stamp.
      if (grant.value !== undefined) return reply.type("text/plain; charset=utf-8").send(grant.value);
      const value = await readSecretValue(grant.userId, grant.name);
      if (value === null) return reply.code(404).send();
      // Awaited, not fire-and-forget: the last_used_at test relies on the
      // stamp landing before the redeem response is observed. The value is
      // already decrypted, so awaiting here trades no secrecy for the
      // ordering guarantee. A failed stamp must never turn a 200 into a 500.
      try {
        await touchUsed(grant.userId, [grant.name]);
      } catch {
        // ignore
      }
      return reply.type("text/plain; charset=utf-8").send(value);
    }
  );
}
