import crypto from "crypto";
import fs from "fs";
import path from "path";
import { FastifyInstance } from "fastify";
import { Integration } from "@a-workbench/shared";
import { registry } from "../plugins/registry";
import { createAuthState } from "../auth/oauth";
import { buildPluginAuthUrl, handlePluginCallback, getPluginOAuthCreds } from "../auth/plugin-oauth";
import { verifyApiKey, getUserById, setApiKey, clearApiKey, hasApiKey, getApiKey } from "../auth/users";
import { buildAuthUrl, handleCallback } from "../auth/google";
import { buildAuthUrl as buildKeycloakAuthUrl, handleCallback as handleKeycloakCallback, isKeycloakConfigured } from "../auth/keycloak";
import { signSession, verifySession } from "../auth/session";
import { config } from "../config";
import { getToken, deleteToken, storeToken } from "../auth/tokens";
import {
  storeCookies,
  getCookies,
  hasValidCookies,
  deleteCookies,
  resetBrowserProfile,
  CookieData,
} from "../auth/cookie";
import { verifyConnectToken } from "../auth/connect-token";
import { signConnectToken } from "../auth/connect-token";
import {
  createCustomApp,
  getCustomApp,
  getCustomAppById,
  getCustomAppByName,
  listCustomApps,
  deleteCustomApp,
  integrationKey,
  idFromIntegrationKey,
} from "../custom-apps/store";
import {
  discoverMetadata,
  registerClient,
  buildCustomAppAuthUrl,
  handleCustomAppCallback,
} from "../custom-apps/oauth";
import { normalizeBaseUrl } from "../custom-apps/ssrf";
import { invalidateIndex, ensureIndex } from "../custom-apps/index";
import { markConnected, startReaper, redeemPending, getPending, createPending } from "../auth/connections";
import { resumeAuthorize } from "../auth/oauth-server/resume";
import { listAgents, revokeAgent } from "../auth/oauth-server/agents";
import { ensureSession, navigate, captureLiveCookies } from "../auth/browser-session";
import {
  auditStored,
  encodeCursor,
  decodeCursor,
  listAuditEvents,
  summarizeAudit,
} from "../audit/query";

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

// Fastify parses a repeated query key (`?x=a&x=b`) into an array. Every
// caller here expects a single string, so take the first value when one
// arrives as an array rather than passing it through to the SQL binder.
function firstQueryValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Whether an integration can actually be connected right now: built-ins
// (auth "none") and cookie auth are always ready; oauth2 needs client creds
// present in env; anything else (manual) is not connectable from the UI.
function isConfigured(i: Integration): boolean {
  if (i.auth.type === "none") return true;
  if (i.auth.type === "cookie") return true;
  // API-key integrations need no server-side creds — the user supplies the key
  // at connect time, so they're always ready to connect.
  if (i.auth.type === "apikey") return true;
  if (i.auth.type === "oauth2") return getPluginOAuthCreds(i.name) !== null;
  return false;
}

// A bundled logo filename becomes a server URL; a full URL passes through.
function resolveLogo(i: Integration): string | undefined {
  if (!i.logo) return undefined;
  return isUrl(i.logo) ? i.logo : `/api/integrations/${i.name}/logo`;
}

function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

async function authenticate(request: {
  headers: { authorization?: string; "x-workbench-api-key"?: string };
}): Promise<{ userId: string } | null> {
  // API key auth: a dedicated header (not Authorization), so it never collides
  // with the portal's session JWT.
  const apiKey = request.headers["x-workbench-api-key"];
  if (apiKey) {
    const userId = await verifyApiKey(apiKey);
    if (userId) return { userId };
  }

  // Session JWT (portal) via Authorization: Bearer.
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      const session = await verifySession(auth.slice(7));
      return { userId: session.userId };
    } catch {
      /* invalid session token */
    }
  }
  return null;
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  startReaper();

  // --- Auth routes ---
  app.get("/api/auth/providers", async () => {
    const providers: string[] = [];
    if (config.GOOGLE_CLIENT_ID) providers.push("google");
    if (isKeycloakConfigured()) providers.push("keycloak");
    return { providers };
  });

  app.get("/api/auth/google", async (request, reply) => {
    if (!config.GOOGLE_CLIENT_ID) {
      return reply.status(503).send({ error: "Google SSO not configured" });
    }
    // The choice page passes the /authorize ticket through here so the SSO
    // callback knows which pending agent-auth flow to resume.
    const { ticket } = request.query as { ticket?: string };
    const url = await buildAuthUrl(ticket);
    return { url };
  });

  app.get("/api/auth/keycloak", async (request, reply) => {
    if (!isKeycloakConfigured()) {
      return reply.status(503).send({ error: "Keycloak SSO not configured" });
    }
    const { ticket } = request.query as { ticket?: string };
    const url = await buildKeycloakAuthUrl(ticket);
    return { url };
  });

  app.get("/api/auth/keycloak/callback", async (request, reply) => {
    const { code, state, error } = request.query as Record<string, string>;
    if (error) return reply.status(400).send({ error: `Keycloak auth error: ${error}` });
    if (!code) return reply.status(400).send({ error: "Missing code" });
    try {
      const { userId, email } = await handleKeycloakCallback(code, state);

      // If SSO was started by an OAuth /authorize, state carries ".<ticket>".
      const dot = state.indexOf(".");
      const oauthTicket = dot === -1 ? null : state.slice(dot + 1);
      if (oauthTicket) {
        const cookie = request.headers.cookie ?? "";
        const m = cookie.match(/(?:^|;\s*)awb_oauth_binding=([^;]+)/);
        const binding = m ? m[1] : undefined;
        const redirectUrl = await resumeAuthorize(oauthTicket, userId, binding);
        // Clear the one-time binding cookie.
        reply.header("Set-Cookie", "awb_oauth_binding=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
        if (redirectUrl) return reply.redirect(redirectUrl);
        // binding/ticket invalid -> fall through to portal login
      }

      const token = await signSession({ userId, email });
      const redirect = new URL(config.PORTAL_URL);
      redirect.hash = `token=${token}`;
      return reply.redirect(redirect.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Auth failed";
      return reply.status(400).send({ error: message });
    }
  });

  app.get("/api/auth/google/callback", async (request, reply) => {
    const { code, state, error } = request.query as Record<string, string>;
    if (error) {
      return reply.status(400).send({ error: `Google auth error: ${error}` });
    }
    if (!code) {
      return reply.status(400).send({ error: "Missing code" });
    }

    try {
      const { userId, email } = await handleCallback(code, state);

      // If SSO was started by an OAuth /authorize, state carries ".<ticket>".
      const dot = state.indexOf(".");
      const oauthTicket = dot === -1 ? null : state.slice(dot + 1);
      if (oauthTicket) {
        const cookie = request.headers.cookie ?? "";
        const m = cookie.match(/(?:^|;\s*)awb_oauth_binding=([^;]+)/);
        const binding = m ? m[1] : undefined;
        const redirectUrl = await resumeAuthorize(oauthTicket, userId, binding);
        // Clear the one-time binding cookie.
        reply.header("Set-Cookie", "awb_oauth_binding=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
        if (redirectUrl) return reply.redirect(redirectUrl);
        // binding/ticket invalid -> fall through to portal login
      }

      const token = await signSession({ userId, email });
      // Redirect back to portal with token in hash fragment (safer than query)
      const redirect = new URL(config.PORTAL_URL);
      redirect.hash = `token=${token}`;
      return reply.redirect(redirect.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Auth failed";
      return reply.status(400).send({ error: message });
    }
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const profile = await getUserById(user.userId);
    if (!profile) {
      return reply.status(404).send({ error: "User not found" });
    }
    return { id: profile.id, email: profile.email };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    // Stateless JWT -- client discards token. Server-side revoke optional.
    return { success: true };
  });

  // --- MCP API key management (session-authenticated) ---
  // Mint/rotate a long-lived API key for use as the /mcp Bearer. The plaintext
  // is returned here and also kept encrypted so the owner can reveal it again.
  app.post("/api/keys", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    return await setApiKey(user.userId);
  });

  // Whether the user currently has a key.
  app.get("/api/keys", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    return { hasKey: await hasApiKey(user.userId) };
  });

  // Reveal the existing plaintext key (decrypted). Session-auth only.
  app.get("/api/keys/reveal", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const apiKey = await getApiKey(user.userId);
    if (!apiKey) {
      return reply.status(404).send({ error: "No key set." });
    }
    return { apiKey };
  });

  app.delete("/api/keys", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    await clearApiKey(user.userId);
    return { success: true };
  });

  // --- Protected API routes ---
  app.get("/api/integrations", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    // Custom apps (per-user external MCP servers) sit beside native apps in
    // the same list — distinguished by `custom: true`. Their tool count comes
    // from the cached per-user index (live discovery, single-flighted).
    const customApps = await listCustomApps(user.userId);
    const customIndex = await ensureIndex(user.userId);
    return {
      integrations: [
        ...registry.listIntegrations().map((i) => ({
          name: i.name,
          version: i.version,
          displayName: i.displayName,
          description: i.description,
          categories: i.categories,
          logo: resolveLogo(i),
          authType: i.auth.type,
          instance: i.auth.type === "oauth2" ? i.auth.instance : undefined,
          apikeyFields: i.auth.type === "apikey" ? i.auth.fields : undefined,
          toolCount: registry.listToolsByIntegration(i.name).length,
          configured: isConfigured(i),
        })),
        ...customApps.map((c) => ({
          name: integrationKey(c.id),
          version: "MCP",
          displayName: c.name,
          description: `Custom MCP server at ${c.baseUrl}`,
          authType: "oauth2" as const,
          custom: true,
          toolCount: customIndex.filter((t) => t.appId === c.id).length,
          configured: true,
        })),
      ],
    };
  });

  // Integration detail: metadata + the tools it exposes.
  app.get<{ Params: { integration: string } }>(
    "/api/integrations/:integration",
    async (request, reply) => {
      const user = await authenticate(request);
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const integration = request.params.integration;
      const customId = idFromIntegrationKey(integration);
      if (customId) {
        const app = await getCustomApp(user.userId, customId);
        if (!app) return reply.status(404).send({ error: "Integration not found" });
        const tools = (await ensureIndex(user.userId)).filter((t) => t.appId === customId);
        return {
          name: integrationKey(app.id),
          version: "MCP",
          displayName: app.name,
          description: `Custom MCP server at ${app.baseUrl}`,
          authType: "oauth2",
          custom: true,
          tools: tools.map((t) => ({ name: t.name, description: t.description })),
        };
      }
      const integ = registry.getIntegration(integration);
      if (!integ) {
        return reply.status(404).send({ error: "Integration not found" });
      }
      return {
        name: integ.name,
        version: integ.version,
        displayName: integ.displayName,
        description: integ.description,
        categories: integ.categories,
        logo: resolveLogo(integ),
        authType: integ.auth.type,
        instance: integ.auth.type === "oauth2" ? integ.auth.instance : undefined,
        apikeyFields: integ.auth.type === "apikey" ? integ.auth.fields : undefined,
        tools: registry.listToolsByIntegration(integration).map((t) => ({
          name: t.name,
          description: t.description,
        })),
      };
    }
  );

  // Serve a plugin's bundled logo file. Public (no auth) so an <img src> works
  // without an Authorization header; logos aren't sensitive.
  app.get<{ Params: { integration: string } }>(
    "/api/integrations/:integration/logo",
    async (request, reply) => {
      const integration = request.params.integration;
      const integ = registry.getIntegration(integration);
      const dir = registry.getPluginDir(integration);
      if (!integ?.logo || isUrl(integ.logo) || !dir) {
        return reply.status(404).send({ error: "No logo" });
      }
      // basename() defuses any path traversal in the manifest's logo field.
      const file = path.join(dir, path.basename(integ.logo));
      if (!fs.existsSync(file)) {
        return reply.status(404).send({ error: "No logo" });
      }
      reply.header("Content-Type", contentType(file));
      reply.header("Cache-Control", "public, max-age=86400");
      return reply.send(fs.readFileSync(file));
    }
  );

  app.get("/api/auth/:integration", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const { integration } = request.params as { integration: string };

    // Custom apps connect through the same /api/auth/:integration endpoint as
    // native apps — the integration name is the `custom:<id>` key.
    const customId = idFromIntegrationKey(integration);
    if (customId) {
      const app = await getCustomApp(user.userId, customId);
      if (!app) return reply.status(404).send({ error: "Integration not found" });
      try {
        const url = await buildCustomAppAuthUrl(user.userId, app);
        return { type: "oauth2", url };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: message });
      }
    }

    const integ = registry.getIntegration(integration);
    if (!integ) {
      return reply.status(404).send({ error: "Integration not found" });
    }

    if (integ.auth.type === "none") {
      return { type: "none", connected: true };
    }

    if (integ.auth.type === "cookie") {
      const session = await ensureSession(user.userId);
      await navigate(session, integ.auth.loginUrl);
      return {
        type: "cookie",
        status: "login_required",
        cdpProxyUrl: `/api/auth/cookie/${integration}/cdp`,
        loginUrl: integ.auth.loginUrl,
      };
    }

    if (integ.auth.type === "oauth2") {
      try {
        const { instanceUrl } = request.query as { instanceUrl?: string };
        const url = await buildPluginAuthUrl(user.userId, integration, instanceUrl);
        return { type: "oauth2", url };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: message });
      }
    }

    if (integ.auth.type === "apikey") {
      // Hand the portal the field spec so it can render the connect form; the
      // user POSTs the values back to /api/auth/apikey/:integration.
      return { type: "apikey", fields: integ.auth.fields };
    }

    const state = await createAuthState(user.userId, integration);
    return { state };
  });

  // API-key connect: store the user-supplied credential + config fields. The
  // field flagged `secret` becomes the encrypted access token; the rest are
  // persisted as per-connection config (read by tools via ctx.getConfig()).
  app.post<{ Params: { integration: string }; Body: { values?: Record<string, string> } }>(
    "/api/auth/apikey/:integration",
    async (request, reply) => {
      const user = await authenticate(request);
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const { integration } = request.params;
      const integ = registry.getIntegration(integration);
      if (!integ || integ.auth.type !== "apikey") {
        return reply.status(404).send({ error: "API-key integration not found" });
      }

      const values = request.body?.values ?? {};
      const secretField = integ.auth.fields.find((f) => f.secret);
      if (!secretField) {
        return reply.status(500).send({ error: "Integration has no secret field" });
      }

      // Validate: required (non-optional) fields must be present; any enum
      // field that *is* supplied must match its options.
      for (const f of integ.auth.fields) {
        const v = (values[f.key] ?? "").trim();
        if (!v) {
          if (f.optional) continue;
          return reply.status(400).send({ error: `Missing required field: ${f.label}` });
        }
        if (f.options && !f.options.includes(v)) {
          return reply.status(400).send({ error: `${f.label} must be one of: ${f.options.join(", ")}` });
        }
      }

      const secret = values[secretField.key].trim();
      const configFields: Record<string, string> = {};
      for (const f of integ.auth.fields) {
        if (f.secret) continue;
        const v = (values[f.key] ?? "").trim();
        // Skip optional fields left blank — don't persist empty strings.
        if (!v) continue;
        configFields[f.key] = v;
      }

      await storeToken(user.userId, integration, {
        accessToken: secret,
        scopes: "",
        config: Object.keys(configFields).length ? JSON.stringify(configFields) : undefined,
      });
      // No markConnected(): apikey connect is synchronous (no PENDING record to
      // flip). The stored token alone makes /api/connections report connected.
      return { success: true };
    }
  );

  // Plugin OAuth callback (generic — works for any oauth2 plugin
  // whose creds are wired in getPluginOAuthCreds). Namespaced under
  // /plugin/ to avoid colliding with /api/auth/google/callback (SSO).
  app.get("/api/auth/plugin/:integration/callback", async (request, reply) => {
    const { integration } = request.params as { integration: string };
    const { code, state, error } = request.query as Record<string, string>;

    // Every exit is a redirect to the portal's result page carrying a status
    // code, never a message. The provider's `error` and any exception text are
    // attacker-influenced and this URL is shown to a human — they go to the log
    // instead, where an operator can still read them.
    const result = (status: "ok" | "denied" | "expired" | "failed") => {
      const url = new URL(config.PORTAL_URL);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/connected/${encodeURIComponent(integration)}`;
      url.searchParams.set("status", status);
      return reply.redirect(url.toString());
    };

    if (error) {
      request.log.warn({ integration, providerError: error }, "plugin oauth callback: provider error");
      return result(error === "access_denied" ? "denied" : "failed");
    }
    if (!code || !state) {
      request.log.warn({ integration }, "plugin oauth callback: missing code or state");
      return result("failed");
    }

    try {
      const { userId } = await handlePluginCallback(integration, code, state);
      markConnected(userId, integration);
      return result("ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn({ integration, err: message }, "plugin oauth callback failed");
      // handlePluginCallback throws this exact string when the pending_auth row
      // is missing or names another integration — the expired-link case, which
      // is worth telling the human apart from a genuine failure.
      return result(message === "Invalid state" ? "expired" : "failed");
    }
  });

  // Cookie auth capture
  app.post("/api/auth/cookie/:integration/capture", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.status(401).send({ error: "Unauthorized" });

    const { integration } = request.params as { integration: string };
    const integ = registry.getIntegration(integration);
    if (!integ || integ.auth.type !== "cookie") {
      return reply.status(404).send({ error: "Cookie integration not found" });
    }

    try {
      const data = await captureLiveCookies(user.userId, integ.auth.targetDomain, integ.auth.cookieDomains);
      if (data.cookies.length === 0) {
        return reply.status(400).send({ error: "No cookies captured. Complete login before capturing." });
      }
      await storeCookies(user.userId, integration, data);
      markConnected(user.userId, integration);
      return { success: true, cookieCount: data.cookies.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  // Export a stored cookie-auth session as a portable bundle. Lets a user
  // capture on a machine whose egress IP the login provider accepts (e.g. a
  // residential ISP) and move the live session to a headless/in-cluster
  // workbench that the provider would otherwise block. Authed — the bundle
  // contains live session cookies, returned only to its owner.
  app.get<{ Params: { integration: string } }>(
    "/api/integrations/:integration/session/export",
    async (request, reply) => {
      const user = await authenticate(request);
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { integration } = request.params;
      const integ = registry.getIntegration(integration);
      if (!integ || integ.auth.type !== "cookie") {
        return reply.status(404).send({ error: "Cookie integration not found" });
      }
      const session = await getCookies(user.userId, integration);
      if (!session) return reply.status(404).send({ error: "No session to export. Connect the integration first." });
      return { integration, session };
    }
  );

  // Import a cookie-auth session bundle (from /session/export elsewhere) and
  // store it under the caller, marking the integration connected.
  app.post<{
    Params: { integration: string };
    Body: { session?: CookieData | CookieData["cookies"] } | CookieData["cookies"];
  }>(
    "/api/integrations/:integration/session/import",
    async (request, reply) => {
      const user = await authenticate(request);
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { integration } = request.params;
      const integ = registry.getIntegration(integration);
      if (!integ || integ.auth.type !== "cookie") {
        return reply.status(404).send({ error: "Cookie integration not found" });
      }
      // Accept a bare cookie array (no { cookies } wrapper) at either the body
      // root or under `session`, and normalize it into a CookieData bundle.
      const body = request.body;
      const raw = Array.isArray(body) ? body : body?.session;
      const session: Partial<CookieData> | undefined = Array.isArray(raw) ? { cookies: raw } : raw;
      if (!session || !Array.isArray(session.cookies) || session.cookies.length === 0) {
        return reply.status(400).send({ error: "Invalid session bundle: expected non-empty { cookies } or a cookie array." });
      }
      const data: CookieData = {
        domain: session.domain ?? integ.auth.targetDomain,
        cookies: session.cookies,
        capturedAt: session.capturedAt ?? Math.floor(Date.now() / 1000),
      };
      await storeCookies(user.userId, integration, data);
      markConnected(user.userId, integration);
      return { success: true, cookieCount: data.cookies.length };
    }
  );

  // Reset (wipe) the caller's persistent browser profile — logs them out of all
  // sites in the capture browser. Per-user, not per-integration.
  app.post("/api/browser-session/reset", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.status(401).send({ error: "Unauthorized" });
    try {
      await resetBrowserProfile(user.userId);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("BROWSER_SESSION_BUSY")) {
        return reply.status(409).send({ error: "A browser session is active. Finish or cancel it first." });
      }
      return reply.status(400).send({ error: message });
    }
  });

  // Mint a user-initiated live-view link for the per-user browser session.
  // Mirrors the browser_live_url meta-tool (the agent path) but is driven from
  // the portal: ensures a warm session, optionally navigates to a URL, and
  // returns a short-lived /browser?t= link the user opens to take over by hand.
  app.post("/api/browser-session/live-url", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.status(401).send({ error: "Unauthorized" });
    const { url } = (request.body ?? {}) as { url?: string };
    if (url !== undefined && typeof url !== "string") {
      return reply.status(400).send({ error: "url must be a string" });
    }
    if (url && !isUrl(url)) {
      return reply.status(400).send({ error: "url must be http(s)" });
    }
    try {
      const s = await ensureSession(user.userId);
      if (url) await navigate(s, url);
      const rec = createPending({
        userId: user.userId,
        integration: "__browser__",
        // "cookie" is a stand-in: ConnectionType has no browser member, and
        // type is never read back for a "__browser__" record.
        type: "cookie",
        ttlSeconds: config.CONNECT_TTL_SECONDS,
      });
      const token = await signConnectToken(
        { connectionId: rec.connectionId, userId: user.userId, integration: "__browser__", sessionId: user.userId },
        config.CONNECT_TTL_SECONDS
      );
      return { url: `${config.PORTAL_URL}/browser?t=${token}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("BROWSER_SESSION_BUSY")) {
        return reply.status(409).send({ error: "A cookie capture is in progress. Finish or cancel it first." });
      }
      return reply.status(400).send({ error: message });
    }
  });

  // Cookie auth cancel
  app.post("/api/auth/cookie/:integration/cancel", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.status(401).send({ error: "Unauthorized" });
    // Capture shares the per-user browser session, which browser-use may also be
    // driving — do not kill it here. The idle reaper reclaims it on its own.
    return { success: true };
  });

  // Connect-link handshake. A connect link names an integration and the
  // workbench user it was minted for; it is a claim, not a capability. The
  // human redeeming it must prove they own that same workbench account. Only
  // after the match does any side effect run — warming a browser session or
  // writing a pending_auth row before that point is what let a link minted for
  // account A capture a credential belonging to whoever opened it.
  app.post<{ Body: { token?: string } }>("/api/connect/redeem", async (request, reply) => {
    // Session first, so an unauthenticated hit never spends a valid link.
    const user = await authenticate(request);
    if (!user) return reply.status(401).send({ error: "AUTH_REQUIRED" });

    const token = request.body?.token;
    if (!token) return reply.status(401).send({ error: "LINK_INVALID" });

    let payload;
    try {
      payload = await verifyConnectToken(token);
    } catch {
      return reply.status(401).send({ error: "LINK_INVALID" });
    }

    // The mismatch check runs before redeemPending, so a wrong-account attempt
    // leaves the link usable by its rightful owner.
    if (payload.userId !== user.userId) {
      return reply.status(403).send({ error: "ACCOUNT_MISMATCH", integration: payload.integration });
    }

    const rec = getPending(payload.connectionId);
    if (!rec || rec.userId !== payload.userId) {
      return reply.status(410).send({ error: "LINK_CONSUMED" });
    }
    if (!redeemPending(payload.connectionId)) {
      return reply.status(410).send({ error: "LINK_CONSUMED" });
    }

    if (payload.integration === "__browser__") {
      try {
        // Warms the browser on this replica. The portal sends the routing key
        // on this call too, so it lands where the live view will.
        await ensureSession(user.userId);
        return {
          type: "browser",
          cdpProxyUrl: "/api/browser-session/cdp",
        };
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    const integ = registry.getIntegration(payload.integration);
    if (!integ) return reply.status(404).send({ error: "Integration not found" });

    if (integ.auth.type === "cookie") {
      try {
        const session = await ensureSession(user.userId);
        await navigate(session, integ.auth.loginUrl);
        return {
          type: "cookie",
          integration: payload.integration,
          loginUrl: integ.auth.loginUrl,
          cdpProxyUrl: `/api/auth/cookie/${payload.integration}/cdp`,
        };
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (integ.auth.type === "oauth2") {
      try {
        const url = await buildPluginAuthUrl(user.userId, payload.integration);
        return { type: "oauth2", url };
      } catch (err) {
        return reply.status(503).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    return reply.status(400).send({ error: "Integration is not connectable by link" });
  });

  // Capture the cookies now present in the user's warm browser session. The
  // portal session proves who is asking; the link token says which pending
  // connection they are completing. Both must name the same user — checking
  // only the link is what let a third party's login be stored under someone
  // else's account.
  app.post<{ Body: { token?: string } }>("/api/connect/capture", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.status(401).send({ error: "AUTH_REQUIRED" });

    const linkToken = request.body?.token;
    if (!linkToken) return reply.status(401).send({ error: "LINK_INVALID" });

    let payload;
    try { payload = await verifyConnectToken(linkToken); }
    catch { return reply.status(401).send({ error: "LINK_INVALID" }); }

    if (payload.userId !== user.userId) {
      return reply.status(403).send({ error: "ACCOUNT_MISMATCH", integration: payload.integration });
    }

    const integ = registry.getIntegration(payload.integration);
    if (!integ || integ.auth.type !== "cookie") {
      return reply.status(404).send({ error: "Cookie integration not found" });
    }
    try {
      const data = await captureLiveCookies(user.userId, integ.auth.targetDomain, integ.auth.cookieDomains);
      if (data.cookies.length === 0) {
        return reply.status(400).send({ error: "No cookies captured. Complete login before capturing." });
      }
      await storeCookies(user.userId, payload.integration, data);
      markConnected(user.userId, payload.integration);
      return { success: true, cookieCount: data.cookies.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  // Connection status per integration
  app.get("/api/connections", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const integrations = registry.listIntegrations();
    const connections = await Promise.all(
      integrations.map(async (i) => ({
        name: i.name,
        connected:
          i.auth.type === "none"
            ? true
            : i.auth.type === "cookie"
              ? await hasValidCookies(user.userId, i.name)
              : !!(await getToken(user.userId, i.name)),
      }))
    );
    const customApps = await listCustomApps(user.userId);
    const customConnections = await Promise.all(
      customApps.map(async (c) => ({
        name: integrationKey(c.id),
        connected: !!(await getToken(user.userId, integrationKey(c.id))),
      }))
    );
    return { connections: [...connections, ...customConnections] };
  });

  // Disconnect: drop stored creds (OAuth tokens or cookies) for one integration.
  app.delete<{ Params: { integration: string } }>(
    "/api/connections/:integration",
    async (request, reply) => {
      const user = await authenticate(request);
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const { integration } = request.params;
      // Custom apps disconnect by dropping their stored OAuth token.
      const customId = idFromIntegrationKey(integration);
      if (customId) {
        const app = await getCustomApp(user.userId, customId);
        if (!app) return reply.status(404).send({ error: "Integration not found" });
        await deleteToken(user.userId, integration);
        invalidateIndex(user.userId);
        return { success: true };
      }
      const integ = registry.getIntegration(integration);
      if (!integ) {
        return reply.status(404).send({ error: "Integration not found" });
      }
      if (integ.auth.type === "none") {
        return reply.status(400).send({ error: "Built-in integration cannot be disconnected" });
      }
      // Both delete the same connections row; branch by auth type for clarity.
      if (integ.auth.type === "cookie") {
        await deleteCookies(user.userId, integration);
      } else {
        await deleteToken(user.userId, integration);
      }
      return { success: true };
    }
  );

  // --- Custom apps (per-user external MCP servers, exposed as apps) ---

  app.post<{ Body: { name?: string; baseUrl?: string } }>("/api/custom-apps", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.status(401).send({ error: "Unauthorized" });

    const name = (request.body?.name ?? "").trim();
    const baseUrl = (request.body?.baseUrl ?? "").trim();
    if (!name || !baseUrl) return reply.status(400).send({ error: "name and baseUrl are required" });
    if (name.length > 64) return reply.status(400).send({ error: "name too long" });

    // Name is unique per user (it becomes the tool namespace); the UNIQUE
    // constraint backs this, but a friendly message beats a raw SQL error.
    if (await getCustomAppByName(user.userId, name)) {
      return reply.status(409).send({ error: `An app named "${name}" already exists` });
    }

    try {
      const normalized = normalizeBaseUrl(baseUrl);
      if (!normalized) return reply.status(400).send({ error: `Invalid or blocked URL: ${baseUrl}` });

      const id = crypto.randomUUID();
      const metadata = await discoverMetadata(normalized);
      const reg = await registerClient(metadata, id);
      const app = await createCustomApp({
        id,
        userId: user.userId,
        name,
        baseUrl: normalized,
        metadata: { ...metadata, authMethod: reg.authMethod },
        clientId: reg.clientId,
        clientSecret: reg.clientSecret,
      });
      return { app: { id: app.id, name: app.name, baseUrl: app.baseUrl } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn({ name, err: message }, "custom app register failed");
      return reply.status(400).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/custom-apps/:id", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.status(401).send({ error: "Unauthorized" });
    const app = await getCustomApp(user.userId, request.params.id);
    if (!app) return reply.status(404).send({ error: "Custom app not found" });
    await deleteCustomApp(user.userId, request.params.id);
    invalidateIndex(user.userId);
    return { success: true };
  });

  // Provider redirects here after the user authorizes. Lands on the same
  // /connected/:integration handshake page every other app uses.
  app.get<{ Params: { id: string } }>("/api/custom-apps/:id/callback", async (request, reply) => {
    const { id } = request.params;
    const { code, state, error } = request.query as Record<string, string>;

    const result = (status: "ok" | "denied" | "expired" | "failed") => {
      const url = new URL(config.PORTAL_URL);
      url.pathname = `/connected/${encodeURIComponent(integrationKey(id))}`;
      url.searchParams.set("status", status);
      return reply.redirect(url.toString());
    };

    if (error) return result(error === "access_denied" ? "denied" : "failed");
    if (!code || !state) return result("failed");

    const app = await getCustomAppById(id);
    if (!app) return result("failed");

    try {
      const { userId } = await handleCustomAppCallback(app, code, state);
      markConnected(userId, integrationKey(id));
      invalidateIndex(userId);
      return result("ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn({ id, err: message }, "custom app oauth callback failed");
      return result(message === "Invalid state" ? "expired" : "failed");
    }
  });

  // Connected agents: MCP/OAuth clients the user has authorized to reach their
  // workbench. Distinct from /api/connections (workbench → SaaS). One row per
  // client_id.
  app.get("/api/agents", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    return { agents: await listAgents(user.userId) };
  });

  // How far back /api/stats looks. One value, not a query parameter: the
  // number is a product decision, and letting a caller widen it turns a
  // constant-cost summary into an unbounded scan.
  const STATS_WINDOW_DAYS = 30;

  // Tool-call history for the caller — the signed-in human, or an agent
  // holding their `x-workbench-api-key` (authenticate() accepts either, same
  // as every other route here); either way the user id comes from the
  // credential and is never read from input, so asking for someone else's
  // rows is not expressible.
  app.get("/api/activity", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    if (!auditStored()) {
      return { stored: false, events: [], next_cursor: null };
    }

    const raw = request.query as {
      limit?: string | string[];
      cursor?: string | string[];
      integration?: string | string[];
      status?: string | string[];
    };
    const q = {
      limit: firstQueryValue(raw.limit),
      cursor: firstQueryValue(raw.cursor),
      integration: firstQueryValue(raw.integration),
      status: firstQueryValue(raw.status),
    };

    const requested = Number(q.limit);
    const limit =
      q.limit === undefined || !Number.isFinite(requested)
        ? 50
        : Math.min(100, Math.max(1, Math.floor(requested)));

    let cursor: { createdAt: number; id: number } | undefined;
    if (q.cursor) {
      const decoded = decodeCursor(q.cursor);
      if (!decoded) {
        return reply.status(400).send({ error: "invalid_cursor" });
      }
      cursor = decoded;
    }

    const status = q.status === "success" || q.status === "error" ? q.status : undefined;

    // Fetch one extra row: its presence is what tells us another page exists,
    // without a second COUNT query.
    const rows = await listAuditEvents({
      userId: user.userId,
      limit: limit + 1,
      cursor,
      integration: q.integration,
      status,
    });

    const events = rows.slice(0, limit);
    const last = events[events.length - 1];
    const next_cursor = rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null;

    return { stored: true, events, next_cursor };
  });

  app.get("/api/stats", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    if (!auditStored()) {
      return {
        stored: false,
        window_days: STATS_WINDOW_DAYS,
        tool_calls: 0,
        success_rate: null,
        most_used_integration: null,
      };
    }
    const s = await summarizeAudit(user.userId, STATS_WINDOW_DAYS);
    return {
      stored: true,
      window_days: STATS_WINDOW_DAYS,
      tool_calls: s.toolCalls,
      success_rate: s.successRate,
      most_used_integration: s.mostUsedIntegration,
    };
  });

  // Revoke an agent: delete the user's refresh tokens for that client (soft
  // revoke — live access tokens lapse at their TTL). Idempotent: returns
  // { revoked: 0 } when there was nothing to remove.
  app.delete<{ Params: { clientId: string } }>(
    "/api/agents/:clientId",
    async (request, reply) => {
      const user = await authenticate(request);
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const revoked = await revokeAgent(user.userId, request.params.clientId);
      return { revoked };
    }
  );
}
