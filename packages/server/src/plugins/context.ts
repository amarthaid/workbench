import { getToken, storeToken, getConnectionConfig, TokenData } from "../auth/tokens";
import { getCookies, CookieData, isCookieExpired } from "../auth/cookie";
import { getPluginOAuthCreds, resolveOAuthUrls } from "../auth/plugin-oauth";
import { registry } from "./registry";
import { matchesDead } from "../auth/reconnect/dead";
import { reconnectSession, canAttemptReconnect } from "../auth/reconnect/runner";
import { getReconnectState, updateReconnectState } from "../auth/reconnect/state";

function buildCookieHeader(data: CookieData, targetHost: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return data.cookies
    .filter((c) => !c.expires || c.expires >= nowSec)
    .filter((c) => {
      const cd = c.domain.replace(/^\./, "").toLowerCase();
      return targetHost === cd || targetHost.endsWith("." + cd);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

// A login bounce means the upstream never processed the request, so it is
// safe to re-send, but only a body we still hold. A stream is spent.
function isReplayableBody(body: RequestInit["body"]): boolean {
  return (
    body == null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

// Refresh a few seconds before the actual expiry to absorb clock skew.
const TOKEN_EXPIRY_SKEW_SECONDS = 30;

async function refreshAccessToken(
  userId: string,
  integration: string,
  data: TokenData
): Promise<TokenData> {
  if (!data.refreshToken) throw new Error("Token expired and no refresh_token stored");
  const integ = registry.getIntegration(integration);
  if (!integ || integ.auth.type !== "oauth2") {
    throw new Error("Cannot refresh non-oauth2 integration");
  }
  const creds = getPluginOAuthCreds(integration);
  if (!creds) throw new Error(`OAuth client not configured for ${integration}`);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    refresh_token: data.refreshToken,
  });
  if (creds.clientSecret) body.set("client_secret", creds.clientSecret);

  const { tokenUrl } = resolveOAuthUrls(integ.auth, data.config);
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Refresh failed ${res.status}: ${body.slice(0, 200)}`);
  }
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const refreshed: TokenData = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? data.refreshToken,
    expiresAt: tokens.expires_in
      ? Math.floor(Date.now() / 1000) + tokens.expires_in
      : undefined,
    scopes: data.scopes,
    config: data.config,
  };
  await storeToken(userId, integration, refreshed);
  return refreshed;
}

export interface ToolContext {
  userId: string;
  getToken(): Promise<string>;
  http(url: string, init?: RequestInit): Promise<Response>;
  // Per-connection config set at connect time (e.g. { instanceUrl } for a
  // self-hosted GitLab). Returns {} when none was stored.
  getConfig(): Record<string, unknown>;
}

// Cache resolved Atlassian cloud IDs per (user, product) so we don't hit
// the /accessible-resources endpoint on every tool call.
const atlassianCloudIdCache = new Map<string, string>();

async function resolveAtlassianCloudId(
  accessToken: string,
  product: "jira" | "confluence"
): Promise<string> {
  const res = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`accessible-resources ${res.status}`);
  const sites = (await res.json()) as Array<{ id: string; scopes?: string[]; url?: string }>;
  const needle = product === "jira" ? "jira" : "confluence";
  const match = sites.find((s) => (s.scopes ?? []).some((sc) => sc.includes(needle))) ?? sites[0];
  if (!match) throw new Error(`No accessible Atlassian site for ${product}`);
  return match.id;
}

// Pre-fetch connection config so getConfig() can stay synchronous on ToolContext.
export async function createContext(userId: string, integration: string): Promise<ToolContext> {
  const rawConfig = await getConnectionConfig(userId, integration);
  let parsedConfig: Record<string, unknown> = {};
  if (rawConfig) {
    try {
      parsedConfig = JSON.parse(rawConfig) as Record<string, unknown>;
    } catch {
      parsedConfig = {};
    }
  }

  let tokenData: TokenData | null = null;
  let cookieData: CookieData | null = null;

  const ctx: ToolContext = {
    userId,

    getConfig(): Record<string, unknown> {
      return parsedConfig;
    },

    async getToken(): Promise<string> {
      if (!tokenData) {
        tokenData = await getToken(userId, integration);
        if (!tokenData) throw new Error("Not connected");
      }
      const now = Math.floor(Date.now() / 1000);
      if (tokenData.expiresAt && tokenData.expiresAt - TOKEN_EXPIRY_SKEW_SECONDS <= now) {
        tokenData = await refreshAccessToken(userId, integration, tokenData);
      }
      return tokenData.accessToken;
    },

    async http(url: string, init?: RequestInit): Promise<Response> {
      const integrationConfig = registry.getIntegration(integration);
      const headers = new Headers(init?.headers);

      if (integrationConfig?.auth.type === "apikey") {
        if (!tokenData) {
          tokenData = await getToken(userId, integration);
          if (!tokenData) throw new Error("NOT_CONNECTED");
        }
        const allowedHosts = integrationConfig.auth.allowedHosts;
        if (allowedHosts && allowedHosts.length) {
          const targetHost = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
          const allowed = allowedHosts.map((d) => d.replace(/^\./, "").toLowerCase());
          if (!allowed.some((d) => targetHost === d || targetHost.endsWith("." + d))) {
            throw new Error(
              `API-key auth: URL host ${targetHost} not in declared allowedHosts`
            );
          }
        }
        headers.set(integrationConfig.auth.headerName, tokenData.accessToken);
        return fetch(url, { ...init, headers });
      }

      if (integrationConfig?.auth.type === "cookie") {
        if (!cookieData) {
          cookieData = await getCookies(userId, integration);
          if (!cookieData || isCookieExpired(cookieData)) {
            throw new Error("NOT_CONNECTED");
          }
        }

        const targetHost = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
        const allowed = [
          integrationConfig.auth.targetDomain,
          ...(integrationConfig.auth.cookieDomains ?? []),
        ].map((d) => d.replace(/^\./, "").toLowerCase());

        if (!allowed.some((d) => targetHost === d || targetHost.endsWith("." + d))) {
          throw new Error(
            `Cookie auth: URL host ${targetHost} not in declared cookieDomains`
          );
        }

        const send = () => {
          headers.set("Cookie", buildCookieHeader(cookieData!, targetHost));
          return fetch(url, { ...init, headers, redirect: "manual" });
        };
        const res = await send();
        const session = integrationConfig.auth.session;
        if (!session || !matchesDead(res, session.dead, url)) return res;
        if (!integrationConfig.auth.reconnect) {
          await updateReconnectState(userId, integration, { deadAt: Date.now() });
          return res;
        }
        // Inside the cooldown, don't re-run the recipe; just keep the dead mark.
        if (!canAttemptReconnect(await getReconnectState(userId, integration))) {
          await updateReconnectState(userId, integration, { deadAt: Date.now() });
          return res;
        }
        const outcome = await reconnectSession(userId, integration);
        if (!outcome.ok || !isReplayableBody(init?.body)) return res;
        const fresh = await getCookies(userId, integration);
        if (!fresh) return res;
        cookieData = fresh;
        const retried = await send();
        if (matchesDead(retried, session.dead, url)) {
          // The recipe "succeeded" but its cookies are still refused. Record it
          // as a failed attempt so the cooldown holds the rate at its promised cap.
          const now = Date.now();
          await updateReconnectState(userId, integration, {
            deadAt: now,
            last: { at: now, ok: false, error: "verify: PROBE_FAILED" },
          });
        }
        return retried;
      }

      const token = await ctx.getToken();
      headers.set("Authorization", `Bearer ${token}`);

      let resolvedUrl = url;
      const atlassianMatch = url.match(/^https:\/\/api\.atlassian\.com\/ex\/(jira|confluence)\/cloud-id\//);
      if (atlassianMatch) {
        const product = atlassianMatch[1] as "jira" | "confluence";
        const cacheKey = `${userId}:${product}`;
        let cloudId = atlassianCloudIdCache.get(cacheKey);
        if (!cloudId) {
          cloudId = await resolveAtlassianCloudId(token, product);
          atlassianCloudIdCache.set(cacheKey, cloudId);
        }
        resolvedUrl = url.replace(
          `/ex/${product}/cloud-id/`,
          `/ex/${product}/${cloudId}/`
        );
      }

      return fetch(resolvedUrl, { ...init, headers });
    },
  };
  return ctx;
}
