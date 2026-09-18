import { config } from "../config";
import { normalizeBaseUrl, assertSafeUrl, safeFetch } from "./ssrf";
import { Connector, ConnectorMetadata, integrationKey } from "./store";
import {
  createAuthState,
  verifyAuthState,
  generateCodeVerifier,
  codeChallengeS256,
} from "../auth/oauth";
import { storeToken, getToken } from "../auth/tokens";

const TOKEN_EXPIRY_SKEW_SECONDS = 30;

export function connectorCallbackUrl(connectorId: string): string {
  return `${config.SERVER_PUBLIC_URL}/api/connectors/${connectorId}/callback`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await safeFetch(url, init);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Discover the OAuth authorization-server and protected-resource metadata for
 * a connector base URL (MCP auth spec). Well-known paths are host-rooted, so
 * they're built from the origin, not the (possibly path-qualified) base URL.
 */
export async function discoverMetadata(baseUrl: string): Promise<ConnectorMetadata> {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) throw new Error(`Invalid or blocked connector URL: ${baseUrl}`);
  const origin = new URL(normalized).origin;

  // 1. Protected-resource metadata (PRM). Prefer the URL the server advertises
  // in a 401 WWW-Authenticate challenge (resource_metadata=...) — it may be
  // path-qualified or on a separate IdP host. Fall back to origin-root
  // well-known. Also capture the challenge's scope= when present.
  let prmUrl = `${origin}/.well-known/oauth-protected-resource`;
  let challengeScope: string | undefined;
  try {
    const probe = await safeFetch(normalized, { method: "GET" });
    if (probe.status === 401) {
      const www = probe.headers.get("www-authenticate") ?? "";
      const rm = www.match(/resource_metadata="([^"]+)"/);
      if (rm) prmUrl = assertSafeUrl(rm[1], "resource_metadata");
      const sm = www.match(/(?:^|[,\s])scope="([^"]+)"/);
      if (sm) challengeScope = sm[1];
    }
  } catch {
    /* probe is best-effort */
  }
  const resourceMeta = await fetchJson(prmUrl).catch(() => ({} as Record<string, unknown>));

  // 2. Authorization-server metadata: PRM's authorization_servers list (a
  // separate IdP), falling back to the connector's own origin.
  const asServers = Array.isArray(resourceMeta.authorization_servers)
    ? (resourceMeta.authorization_servers as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  let asMeta: Record<string, unknown> = {};
  for (const asUrl of [...asServers, origin]) {
    try {
      const as = assertSafeUrl(asUrl, "authorization_server").replace(/\/$/, "");
      asMeta = await fetchJson(`${as}/.well-known/oauth-authorization-server`);
      if (asMeta.authorization_endpoint || asMeta.token_endpoint) break;
    } catch {
      /* try the next authorization server */
    }
  }

  // Scope to request: the PRM's scopes_supported, then the 401 challenge's
  // scope, then the AS's scopes_supported — never blindly every AS scope.
  const scopes = (() => {
    const from = (v: unknown) =>
      Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === "string") : [];
    const prm = from(resourceMeta.scopes_supported);
    if (prm.length) return prm;
    if (challengeScope) return challengeScope.split(" ").filter(Boolean);
    return from(asMeta.scopes_supported);
  })();

  const metadata: ConnectorMetadata = {
    authorizationEndpoint: typeof asMeta.authorization_endpoint === "string" ? asMeta.authorization_endpoint : undefined,
    tokenEndpoint: typeof asMeta.token_endpoint === "string" ? asMeta.token_endpoint : undefined,
    registrationEndpoint: typeof asMeta.registration_endpoint === "string" ? asMeta.registration_endpoint : undefined,
    resourceUrl: typeof resourceMeta.resource === "string" ? resourceMeta.resource : undefined,
    scopes: scopes.length ? scopes : undefined,
  };

  if (!metadata.authorizationEndpoint || !metadata.tokenEndpoint) {
    throw new Error(
      `Connector at ${baseUrl} did not advertise an OAuth authorization server (/.well-known/oauth-authorization-server)`
    );
  }
  // The AS metadata is attacker-influenced: every endpoint the server will
  // later fetch (registration, token) — or hand to the browser — must be a
  // safe, non-private URL, or a hostile server points us at 169.254.169.254.
  assertSafeUrl(metadata.authorizationEndpoint, "authorization_endpoint");
  assertSafeUrl(metadata.tokenEndpoint, "token_endpoint");
  if (metadata.registrationEndpoint) assertSafeUrl(metadata.registrationEndpoint, "registration_endpoint");
  return metadata;
}

interface Registration {
  clientId: string;
  clientSecret?: string;
  authMethod?: ConnectorMetadata["authMethod"];
}

/**
 * RFC 7591 dynamic client registration. A server that returns no
 * `client_secret` (or none at all) is a public client — PKCE carries the flow.
 */
export async function registerClient(
  metadata: ConnectorMetadata,
  connectorId: string
): Promise<Registration> {
  if (!metadata.registrationEndpoint) {
    throw new Error("Connector's authorization server does not support dynamic client registration");
  }
  const body = {
    // Shown on the provider's consent screen — identify as the workbench app,
    // not "workbench:<connector name>".
    client_name: "Workbench",
    client_uri: config.SERVER_PUBLIC_URL,
    redirect_uris: [connectorCallbackUrl(connectorId)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  const res = await safeFetch(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Dynamic client registration failed: ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.client_id !== "string") {
    throw new Error("Registration response missing client_id");
  }
  // RFC 7591: omitted token_endpoint_auth_method defaults to client_secret_basic.
  const authMethod =
    data.token_endpoint_auth_method === "none"
      ? "none"
      : data.token_endpoint_auth_method === "client_secret_post"
        ? "client_secret_post"
        : "client_secret_basic";
  return {
    clientId: data.client_id,
    clientSecret: typeof data.client_secret === "string" ? data.client_secret : undefined,
    authMethod,
  };
}

export async function buildConnectorAuthUrl(userId: string, connector: Connector): Promise<string> {
  if (!connector.clientId) throw new Error("Connector has no registered OAuth client");
  const { authorizationEndpoint, scopes, resourceUrl } = connector.metadata;
  if (!authorizationEndpoint) throw new Error("Connector has no authorization endpoint");

  const codeVerifier = generateCodeVerifier();
  const state = await createAuthState(userId, integrationKey(connector.id), codeVerifier);

  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", connector.clientId);
  url.searchParams.set("redirect_uri", connectorCallbackUrl(connector.id));
  url.searchParams.set("code_challenge", codeChallengeS256(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (scopes?.length) url.searchParams.set("scope", scopes.join(" "));
  if (resourceUrl) url.searchParams.set("resource", resourceUrl);
  return url.toString();
}

async function exchangeConnectorToken(
  connector: Connector,
  code: string,
  codeVerifier: string
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; scopes: string }> {
  const { tokenEndpoint, resourceUrl } = connector.metadata;
  if (!tokenEndpoint) throw new Error("Connector has no token endpoint");

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: connectorCallbackUrl(connector.id),
    code_verifier: codeVerifier,
  });

  if (connector.clientSecret && connector.metadata.authMethod === "client_secret_basic") {
    // Credentials live only in the Basic header — client_id must NOT also
    // appear in the body, or strict ASes (Notion) reject it as "multiple
    // authentication methods".
    headers.Authorization = `Basic ${Buffer.from(`${connector.clientId}:${connector.clientSecret}`).toString("base64")}`;
  } else {
    // client_secret_post or public client (none): client_id in the body; the
    // secret joins it only for the post method.
    body.set("client_id", connector.clientId!);
    if (connector.clientSecret) body.set("client_secret", connector.clientSecret);
  }
  if (resourceUrl) body.set("resource", resourceUrl);

  const res = await safeFetch(tokenEndpoint, { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tokens.access_token) throw new Error("Token response missing access_token");
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? Math.floor(Date.now() / 1000) + tokens.expires_in : undefined,
    scopes: tokens.scope ?? (connector.metadata.scopes ?? []).join(" "),
  };
}

export async function handleConnectorCallback(
  connector: Connector,
  code: string,
  state: string
): Promise<{ userId: string }> {
  const authState = await verifyAuthState(state);
  if (!authState || authState.integration !== integrationKey(connector.id)) {
    throw new Error("Invalid state");
  }
  if (!authState.codeVerifier) throw new Error("Missing code verifier");

  const tokens = await exchangeConnectorToken(connector, code, authState.codeVerifier);
  await storeToken(authState.userId, integrationKey(connector.id), {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
  });
  return { userId: authState.userId };
}

/**
 * Return a valid access token for a connector, refreshing (and re-storing)
 * when the stored one is within the expiry skew. Throws NOT_CONNECTED when the
 * user has no stored token.
 */
// Single-flight refresh: concurrent tool calls on an expired token must not
// fire N refresh requests with the same refresh_token (rotation rejects the
// extras / revokes the family). One refresh, everyone awaits it.
const refreshLocks = new Map<string, Promise<string>>();

export async function ensureConnectorToken(userId: string, connector: Connector): Promise<string> {
  const data = await getToken(userId, integrationKey(connector.id));
  if (!data) throw new Error("NOT_CONNECTED");
  const now = Math.floor(Date.now() / 1000);
  if (data.expiresAt && data.expiresAt - TOKEN_EXPIRY_SKEW_SECONDS <= now) {
    if (!data.refreshToken) throw new Error("Token expired and no refresh_token stored");
    const key = `${userId}:${connector.id}`;
    let refresh = refreshLocks.get(key);
    if (!refresh) {
      refresh = doRefresh(userId, connector, data.refreshToken, data.scopes, data.config);
      refreshLocks.set(key, refresh);
      void refresh.finally(() => refreshLocks.delete(key));
    }
    return refresh;
  }
  return data.accessToken;
}

async function doRefresh(
  userId: string,
  connector: Connector,
  refreshToken: string,
  scopes: string,
  config: string | undefined
): Promise<string> {
  const refreshed = await refreshConnectorToken(connector, refreshToken);
  await storeToken(userId, integrationKey(connector.id), {
    accessToken: refreshed.accessToken,
    // Many ASes omit refresh_token on refresh (rotation windows, opaque
    // tokens) — falling back to the stored one keeps the connection alive
    // instead of wiping it to NULL and forcing a reconnect next expiry.
    refreshToken: refreshed.refreshToken ?? refreshToken,
    expiresAt: refreshed.expiresAt,
    scopes,
    config,
  });
  return refreshed.accessToken;
}

/** Refresh a connector's access token (called from the tool context). */
export async function refreshConnectorToken(
  connector: Connector,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const { tokenEndpoint, resourceUrl } = connector.metadata;
  if (!tokenEndpoint) throw new Error("Connector has no token endpoint");
  if (!connector.clientId) throw new Error("Connector has no registered OAuth client");

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (connector.clientSecret && connector.metadata.authMethod === "client_secret_basic") {
    headers.Authorization = `Basic ${Buffer.from(`${connector.clientId}:${connector.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", connector.clientId);
    if (connector.clientSecret) body.set("client_secret", connector.clientSecret);
  }
  if (resourceUrl) body.set("resource", resourceUrl);

  const res = await safeFetch(tokenEndpoint, { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refresh failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token) throw new Error("Refresh response missing access_token");
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? Math.floor(Date.now() / 1000) + tokens.expires_in : undefined,
  };
}
