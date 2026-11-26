import { getToken, getConnectionConfig, TokenData } from "../auth/tokens";
import { isExpiring, refreshToken } from "../auth/token-refresh";
import { getCookies, CookieData, isCookieExpired } from "../auth/cookie";
import { registry } from "./registry";
import { matchesDead } from "../auth/reconnect/dead";
import { reconnectSession } from "../auth/reconnect/runner";
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
): Promise<string | Response> {
  const res = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) return res;
  if (!res.ok) throw new Error(`accessible-resources ${res.status}`);
  const sites = (await res.json()) as Array<{ id: string; scopes?: string[]; url?: string }>;
  const needle = product === "jira" ? "jira" : "confluence";
  const match = sites.find((s) => (s.scopes ?? []).some((sc) => sc.includes(needle))) ?? sites[0];
  if (!match) throw new Error(`No accessible Atlassian site for ${product}`);
  return match.id;
}

export interface CreateContextOptions {
  // false: a dead cookie session is returned as is, never revived through the
  // reconnect recipe (a call made on someone else's behalf, a delegated Space).
  autoReconnect?: boolean;
}

// Pre-fetch connection config so getConfig() can stay synchronous on ToolContext.
export async function createContext(
  userId: string,
  integration: string,
  opts?: CreateContextOptions
): Promise<ToolContext> {
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
      if (isExpiring(tokenData)) {
        if (registry.getIntegration(integration)?.auth.type !== "oauth2") {
          throw new Error("Cannot refresh non-oauth2 integration");
        }
        tokenData = await refreshToken(userId, integration, tokenData.accessToken);
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
        if (!integrationConfig.auth.reconnect || opts?.autoReconnect === false) {
          await updateReconnectState(userId, integration, { deadAt: Date.now() });
          return res;
        }
        // The runner applies the cooldown itself, after its fast path (which
        // types nothing), and marks the session dead when it refuses.
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

      const send = async (token: string): Promise<Response> => {
        headers.set("Authorization", `Bearer ${token}`);
        let resolvedUrl = url;
        const atlassianMatch = url.match(/^https:\/\/api\.atlassian\.com\/ex\/(jira|confluence)\/cloud-id\//);
        if (atlassianMatch) {
          const product = atlassianMatch[1] as "jira" | "confluence";
          const cacheKey = `${userId}:${product}`;
          let cloudId = atlassianCloudIdCache.get(cacheKey);
          if (!cloudId) {
            const resolved = await resolveAtlassianCloudId(token, product);
            // A rejected token here is the same signal as a 401 on the call itself.
            if (resolved instanceof Response) return resolved;
            cloudId = resolved;
            atlassianCloudIdCache.set(cacheKey, cloudId);
          }
          resolvedUrl = url.replace(`/ex/${product}/cloud-id/`, `/ex/${product}/${cloudId}/`);
        }
        return fetch(resolvedUrl, { ...init, headers });
      };

      const token = await ctx.getToken();
      const res = await send(token);

      // Retry once on 401: the token died before its stated expiry (revoked
      // and re-granted, no expires_in from the provider, clock skew, rotated
      // elsewhere). A 401 means the upstream rejected the credentials before
      // doing anything, so re-sending is safe for writes too, but only with a
      // body we still hold. Only OAuth grants with a refresh token qualify;
      // a 403 is a permission problem a refresh cannot fix.
      if (
        res.status !== 401 ||
        integrationConfig?.auth.type !== "oauth2" ||
        !tokenData?.refreshToken ||
        !isReplayableBody(init?.body)
      ) {
        return res;
      }
      await res.body?.cancel().catch(() => undefined);
      tokenData = await refreshToken(userId, integration, token);
      return send(tokenData.accessToken);
    },
  };
  return ctx;
}
