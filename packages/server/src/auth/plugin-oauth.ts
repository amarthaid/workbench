import { config } from "../config";
import { registry } from "../plugins/registry";
import {
  createAuthState,
  verifyAuthState,
  exchangeCode,
  generateCodeVerifier,
  codeChallengeS256,
} from "./oauth";
import { storeToken } from "./tokens";

interface ClientCreds {
  clientId: string;
  // Absent for public (PKCE-only) clients — e.g. a Keycloak client with
  // "Client authentication" off. The flow then relies on PKCE alone.
  clientSecret?: string;
}

/**
 * Per-integration OAuth client credentials.
 *
 * Today only Google plugin is wired. Lookup falls back to the SSO client
 * if the plugin-specific pair is unset — this is allowed but logged as a
 * warning at startup, since SSO and plugin grants live on the same OAuth
 * app and share consent screen scope lists.
 *
 * To add a new provider: extend the switch with its env var pair.
 */
/**
 * Each plugin owns its own OAuth client — no sharing, no fallback.
 *
 * Env var naming convention:
 *   plugin name `google-gmail` → `GOOGLE_GMAIL_CLIENT_ID` / `_SECRET`
 *   plugin name `atlassian-jira` → `ATLASSIAN_JIRA_CLIENT_ID` / `_SECRET`
 *
 * Transform: kebab → upper snake.
 */
export function envVarPrefix(integration: string): string {
  return integration.replace(/-/g, "_").toUpperCase();
}

export function getPluginOAuthCreds(integration: string): ClientCreds | null {
  const prefix = envVarPrefix(integration);
  const id = process.env[`${prefix}_CLIENT_ID`];
  const secret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!id) return null;
  // Empty/unset secret means a public client: configured, but PKCE-only.
  return { clientId: id, clientSecret: secret || undefined };
}

export function getPluginCallbackUrl(integration: string): string {
  return `${config.SERVER_PUBLIC_URL}/api/auth/plugin/${integration}/callback`;
}

/**
 * Block obvious SSRF targets given as IP literals or loopback names. This is a
 * literal-only check (no DNS); the real containment is the host allowlist in
 * isInstanceAllowed — but rejecting these outright stops the dumbest mistakes
 * even for an allowlisted-but-misconfigured deployment.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "[::1]" || h === "::1") return true;
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10).
  if (h.startsWith("[::1") || h.startsWith("[fc") || h.startsWith("[fd") || h.startsWith("[fe8") || h.startsWith("[fe9") || h.startsWith("[fea") || h.startsWith("[feb")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, RFC1918
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
  }
  return false;
}

/**
 * Normalize a user-supplied instance URL to a bare origin (scheme + host[:port]),
 * dropping any path/query/fragment. Returns null if invalid or unsafe.
 *
 * The OAuth token-exchange POST sends the (shared) client secret to this origin,
 * so we are strict: https only — no plaintext secret on the wire; no userinfo —
 * a `user:pass@host` URL is a classic open-redirect/credential trick; and no
 * private/loopback literals (defense-in-depth against SSRF; the allowlist is the
 * primary control).
 */
export function normalizeInstanceUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (isPrivateHost(u.hostname)) return null;
  return u.origin;
}

/**
 * A user picks the instance origin at connect time, and the server then POSTs
 * the shared OAuth client secret to that origin's /oauth/token. Without a guard,
 * any authenticated user could point that at an attacker host and steal the
 * secret (or SSRF an internal service). So the origin must be allowlisted:
 *  - the manifest's cloud default (e.g. https://gitlab.com) is always allowed;
 *  - additional self-hosted origins come from <PREFIX>_ALLOWED_INSTANCES
 *    (comma-separated), set by the deployment admin who controls those hosts.
 * With no env allowlist, only the cloud default is permitted.
 */
export function isInstanceAllowed(
  integration: string,
  instanceDefault: string,
  origin: string
): boolean {
  if (origin === normalizeInstanceUrl(instanceDefault)) return true;
  const env = process.env[`${envVarPrefix(integration)}_ALLOWED_INSTANCES`];
  if (!env) return false;
  const allowed = env
    .split(",")
    .map((s) => normalizeInstanceUrl(s))
    .filter((o): o is string => Boolean(o));
  return allowed.includes(origin);
}

/**
 * Resolve the authorize/token URLs for an OAuth integration, honoring a
 * self-hosted instance origin when the integration declares `instance` support.
 * The manifest's authorizationUrl/tokenUrl are the cloud default; for a custom
 * instance we keep their path and swap in the user's origin.
 */
export function resolveOAuthUrls(
  auth: { authorizationUrl: string; tokenUrl: string; instance?: { default: string } },
  configJson?: string
): { authorizationUrl: string; tokenUrl: string } {
  if (!auth.instance) {
    return { authorizationUrl: auth.authorizationUrl, tokenUrl: auth.tokenUrl };
  }
  let instanceUrl: string | undefined;
  if (configJson) {
    try {
      instanceUrl = JSON.parse(configJson)?.instanceUrl;
    } catch {
      /* fall through to default */
    }
  }
  const origin = normalizeInstanceUrl(instanceUrl ?? auth.instance.default) ?? auth.instance.default;
  const swap = (defaultUrl: string): string => {
    const d = new URL(defaultUrl);
    const o = new URL(origin);
    o.pathname = d.pathname;
    o.search = d.search;
    return o.toString();
  };
  return { authorizationUrl: swap(auth.authorizationUrl), tokenUrl: swap(auth.tokenUrl) };
}

/**
 * Provider-specific authorization URL parameters.
 * Google needs access_type=offline + prompt=consent to issue refresh tokens.
 */
function providerExtraParams(integration: string): Record<string, string> {
  // Google needs access_type=offline + prompt=consent for refresh tokens.
  if (integration.startsWith("google-")) {
    return {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    };
  }
  return {};
}

export async function buildPluginAuthUrl(
  userId: string,
  integration: string,
  instanceUrl?: string
): Promise<string> {
  const integ = registry.getIntegration(integration);
  if (!integ) throw new Error(`Integration not found: ${integration}`);
  if (integ.auth.type !== "oauth2") {
    throw new Error(`Integration ${integration} is not oauth2`);
  }

  const creds = getPluginOAuthCreds(integration);
  if (!creds) {
    throw new Error(`OAuth client not configured for ${integration}`);
  }

  // Self-hosted instance: validate + persist the chosen origin through the flow.
  let configJson: string | undefined;
  if (integ.auth.instance) {
    const raw = instanceUrl?.trim() || integ.auth.instance.default;
    const origin = normalizeInstanceUrl(raw);
    if (!origin) {
      throw new Error(`Invalid instance URL for ${integration}: ${raw}`);
    }
    // Guard the shared client secret: the chosen origin receives the token POST,
    // so it must be the cloud default or an admin-allowlisted self-hosted host.
    if (!isInstanceAllowed(integration, integ.auth.instance.default, origin)) {
      throw new Error(
        `Instance not allowed for ${integration}: ${origin}. Add it to ${envVarPrefix(integration)}_ALLOWED_INSTANCES.`
      );
    }
    configJson = JSON.stringify({ instanceUrl: origin });
  }

  const { authorizationUrl } = resolveOAuthUrls(integ.auth, configJson);

  // PKCE on every flow, confidential clients included (OAuth 2.1 baseline).
  // Providers that don't support it ignore the extra params per RFC 6749.
  const codeVerifier = generateCodeVerifier();
  const state = await createAuthState(userId, integration, codeVerifier, configJson);
  const url = new URL(authorizationUrl);
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", getPluginCallbackUrl(integration));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", codeChallengeS256(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  // Slack splits scopes: `scope` issues a bot token, `user_scope` a user
  // token acting as the authorizing user. We always want the user token.
  const scopeParam = integration === "slack" ? "user_scope" : "scope";
  url.searchParams.set(scopeParam, integ.auth.scopes.join(" "));
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(providerExtraParams(integration))) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function handlePluginCallback(
  integration: string,
  code: string,
  state: string
): Promise<{ userId: string }> {
  const authState = await verifyAuthState(state);
  if (!authState || authState.integration !== integration) {
    throw new Error("Invalid state");
  }

  const integ = registry.getIntegration(integration);
  if (!integ || integ.auth.type !== "oauth2") {
    throw new Error("Integration not configured for OAuth");
  }

  const creds = getPluginOAuthCreds(integration);
  if (!creds) {
    throw new Error(`OAuth client not configured for ${integration}`);
  }

  const { tokenUrl } = resolveOAuthUrls(integ.auth, authState.config);
  const tokens = await exchangeCode(
    tokenUrl,
    creds.clientId,
    creds.clientSecret,
    code,
    getPluginCallbackUrl(integration),
    authState.codeVerifier
  );

  // Slack wraps errors in a 200 {ok:false} envelope and nests the user
  // token under authed_user (top-level access_token is the bot token).
  let accessToken = tokens.access_token;
  let refreshToken = tokens.refresh_token;
  let expiresIn = tokens.expires_in;
  if (integration === "slack") {
    if (tokens.ok === false) {
      throw new Error(`Slack token exchange failed: ${tokens.error}`);
    }
    if (!tokens.authed_user?.access_token) {
      throw new Error("Slack response missing user token (authed_user.access_token)");
    }
    accessToken = tokens.authed_user.access_token;
    refreshToken = tokens.authed_user.refresh_token;
    expiresIn = tokens.authed_user.expires_in;
  }

  const expiresAt = expiresIn
    ? Math.floor(Date.now() / 1000) + expiresIn
    : undefined;

  await storeToken(authState.userId, integration, {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: integ.auth.scopes.join(" "),
    config: authState.config,
  });

  return { userId: authState.userId };
}
