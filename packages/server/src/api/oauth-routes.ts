import crypto from "crypto";
import { FastifyInstance } from "fastify";
import { protectedResourceMetadata, authorizationServerMetadata } from "../auth/oauth-server/metadata";
import { registerClient, getClient } from "../auth/oauth-server/clients";
import { consumeCode } from "../auth/oauth-server/codes";
import { issueRefreshToken, rotateRefreshToken } from "../auth/oauth-server/refresh";
import { signAccessToken } from "../auth/oauth-server/tokens";
import { isUserDisabled } from "../auth/user-status";
import { config } from "../config";
import { db } from "../db";
import { resumeAuthorize } from "../auth/oauth-server/resume";
import { verifySession } from "../auth/session";

export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        try { done(null, Object.fromEntries(new URLSearchParams(body as string))); }
        catch (e) { done(e as Error); }
      }
    );
  }

  app.get("/.well-known/oauth-protected-resource", async () => protectedResourceMetadata());
  app.get("/.well-known/oauth-authorization-server", async () => authorizationServerMetadata());

  // Dynamic Client Registration (RFC 7591) — public clients only.
  app.post("/register", async (request, reply) => {
    const body = (request.body ?? {}) as { client_name?: string; redirect_uris?: string[] };
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      return reply.status(400).send({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
    }
    const client = await registerClient({ client_name: body.client_name, redirect_uris: body.redirect_uris });
    return reply.status(201).send({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get("/authorize", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const client = q.client_id ? await getClient(q.client_id) : undefined;
    if (!client) return reply.status(400).send({ error: "invalid_request", error_description: "unknown client_id" });
    if (q.response_type !== "code") return reply.status(400).send({ error: "unsupported_response_type" });
    if (!client.redirect_uris.includes(q.redirect_uri)) {
      return reply.status(400).send({ error: "invalid_request", error_description: "redirect_uri not registered" });
    }
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return reply.status(400).send({ error: "invalid_request", error_description: "PKCE S256 required" });
    }

    // Stash the validated request under a ticket; resume after the human picks
    // (or is silently carried through, if already signed in) a workbench SSO provider.
    const ticket = crypto.randomBytes(16).toString("hex");
    // Bind this flow to the initiating browser (prevents login CSRF).
    const binding = crypto.randomBytes(16).toString("hex");
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
      [
        ticket, "", "__oauth_authorize__", now + 600,
        JSON.stringify({
          clientId: client.client_id,
          redirectUri: q.redirect_uri,
          codeChallenge: q.code_challenge,
          scope: q.scope || "mcp",
          state: q.state || "",
          resource: q.resource || `${config.SERVER_PUBLIC_URL}/mcp`,
          binding,
        }),
      ]
    );

    // Bind this flow to the initiating browser. SameSite=Lax so it's still sent
    // on a top-level redirect back to our own origin (an SSO callback, or the
    // /authorize/resume form-post below) — but never on a cross-site fetch, which
    // is what makes it a login-CSRF defense rather than just a session id.
    // Secure on https origins.
    const secure = config.SERVER_PUBLIC_URL.startsWith("https://") ? "; Secure" : "";
    reply.header(
      "Set-Cookie",
      `awb_oauth_binding=${binding}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${secure}`
    );
    // Land on the portal's provider-choice page rather than jumping straight to
    // one SSO provider — the portal decides there whether to show a choice or
    // (if the human is already signed in) silently carry the flow through.
    // Deliberately NOT handing over our own origin as a query param here: the
    // resume form below posts a live session token, so its target must come
    // from the portal's own build-time config (VITE_SERVER_URL), never from
    // anything in this URL — a query param is exactly what an attacker's
    // crafted link controls, and a bearer token is exactly what must never
    // follow attacker-controlled input to an attacker-controlled destination.
    const choose = new URL("/authorize/choose", config.PORTAL_URL);
    choose.searchParams.set("ticket", ticket);
    return reply.redirect(choose.toString());
  });

  // Silently carries an /authorize flow through for a human who's already
  // signed in to the portal — the choice page auto-submits this as a real
  // top-level form POST (not a fetch) specifically so the browser attaches
  // awb_oauth_binding automatically; a cross-origin fetch never could, and
  // that's what makes this safe against login CSRF instead of just convenient.
  app.post("/authorize/resume", async (request, reply) => {
    const b = (request.body ?? {}) as { ticket?: string; token?: string };
    if (!b.ticket) {
      return reply.status(400).send({ error: "invalid_request", error_description: "ticket required" });
    }

    const backToChoice = (errorCode: string) => {
      const choose = new URL("/authorize/choose", config.PORTAL_URL);
      choose.searchParams.set("ticket", b.ticket!);
      choose.searchParams.set("error", errorCode);
      return reply.redirect(choose.toString());
    };

    let userId: string;
    try {
      if (!b.token) throw new Error("no token");
      userId = (await verifySession(b.token)).userId;
    } catch {
      return backToChoice("session_invalid");
    }

    const cookie = request.headers.cookie ?? "";
    const m = cookie.match(/(?:^|;\s*)awb_oauth_binding=([^;]+)/);
    const binding = m ? m[1] : undefined;

    const redirectUrl = await resumeAuthorize(b.ticket, userId, binding);
    // Clear the one-time binding cookie either way — resumeAuthorize already
    // consumed the pending row, so it can't be retried regardless.
    reply.header("Set-Cookie", "awb_oauth_binding=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
    if (!redirectUrl) return backToChoice("resume_failed");
    return reply.redirect(redirectUrl);
  });

  app.post("/token", async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, string>;
    const ttl = config.OAUTH_ACCESS_TOKEN_TTL_SECONDS;

    if (b.grant_type === "authorization_code") {
      const consumed = await consumeCode(b.code, {
        clientId: b.client_id, redirectUri: b.redirect_uri, codeVerifier: b.code_verifier,
      });
      if (!consumed) return reply.status(400).send({ error: "invalid_grant" });
      if (await isUserDisabled(consumed.userId)) return reply.status(400).send({ error: "invalid_grant" });
      const access_token = await signAccessToken({ userId: consumed.userId, scope: consumed.scope, clientId: b.client_id });
      const refresh_token = await issueRefreshToken({ clientId: b.client_id, userId: consumed.userId, scope: consumed.scope });
      return reply.send({ access_token, token_type: "Bearer", expires_in: ttl, refresh_token, scope: consumed.scope });
    }

    if (b.grant_type === "refresh_token") {
      const rot = await rotateRefreshToken(b.refresh_token, b.client_id);
      if (!rot) return reply.status(400).send({ error: "invalid_grant" });
      if (await isUserDisabled(rot.userId)) return reply.status(400).send({ error: "invalid_grant" });
      const access_token = await signAccessToken({ userId: rot.userId, scope: rot.scope, clientId: b.client_id });
      return reply.send({ access_token, token_type: "Bearer", expires_in: ttl, refresh_token: rot.newToken, scope: rot.scope });
    }

    return reply.status(400).send({ error: "unsupported_grant_type" });
  });
}
