import crypto from "node:crypto";
import { db } from "../db";
import { getToken, storeToken, type TokenData } from "./tokens";
import { getPluginOAuthCreds, resolveOAuthUrls } from "./plugin-oauth";
import { registry } from "../plugins/registry";

// OAuth access-token refresh, shared by the expiry check in ctx.getToken() and
// the retry-once-on-401 in ctx.http().
//
// One refresh at a time per (user, integration), across every process. A
// Space page or an execute_tools batch fires several calls at once; near
// expiry, or after a revoke, each of them used to refresh with the same
// refresh token. Providers that rotate refresh tokens (Atlassian, GitLab, ...)
// accept the first and reject the rest, and some treat the reuse as theft and
// revoke the whole grant. So:
//
// - In-process: concurrent callers share one promise.
// - Across pods and cluster workers: a lock row in `pending_auth` (the
//   server's generic short-TTL table, under its own sentinel). INSERT ... ON
//   CONFLICT DO NOTHING arbitrates; the loser polls the token row and takes the
//   winner's token as soon as it lands. The lock is never held across a DB
//   transaction, so a slow token endpoint cannot pin a pooled connection or
//   stall SQLite's transaction queue.
// - Every attempt re-reads the stored token first. If it already differs from
//   the one that was rejected (someone else refreshed), it is used as is.

const LOCK_SENTINEL = "__token_refresh__";
/** A crashed holder's lock expires on its own after this long. */
const LOCK_TTL_SECONDS = 30;
/** How long a caller waits for another process's refresh before giving up. */
const WAIT_MS = 15_000;
const POLL_MS = 250;
const TOKEN_ENDPOINT_TIMEOUT_MS = 10_000;

// Refresh a few seconds before the actual expiry to absorb clock skew.
export const TOKEN_EXPIRY_SKEW_SECONDS = 30;

/**
 * The stored grant is unusable and only reconnecting fixes it: no refresh
 * token, or the provider refused it (400/401, typically invalid_grant).
 * Surfaced to callers as NOT_CONNECTED, not as an upstream error.
 */
export class TokenRefreshError extends Error {
  readonly code = "NOT_CONNECTED";
  constructor(
    readonly integration: string,
    message: string
  ) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

export function isExpiring(data: TokenData, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return !!data.expiresAt && data.expiresAt - TOKEN_EXPIRY_SKEW_SECONDS <= nowSec;
}

// Clock and sleep seams for tests.
let nowMs: () => number = () => Date.now();
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function _setClockForTest(clock: { now?: () => number; sleep?: (ms: number) => Promise<void> }): void {
  if (clock.now) nowMs = clock.now;
  if (clock.sleep) sleep = clock.sleep;
}

function lockKey(userId: string, integration: string): string {
  return "refresh:" + crypto.createHash("sha256").update(`${userId}\0${integration}`).digest("hex").slice(0, 40);
}

async function tryLock(key: string, userId: string): Promise<boolean> {
  const nowSec = Math.floor(nowMs() / 1000);
  // Take over a lock whose holder died without releasing it.
  await db.run("DELETE FROM pending_auth WHERE state = ? AND integration = ? AND expires_at < ?", [
    key,
    LOCK_SENTINEL,
    nowSec,
  ]);
  const { changes } = await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (state) DO NOTHING",
    [key, userId, LOCK_SENTINEL, nowSec + LOCK_TTL_SECONDS]
  );
  return changes === 1;
}

async function unlock(key: string): Promise<void> {
  await db.run("DELETE FROM pending_auth WHERE state = ? AND integration = ?", [key, LOCK_SENTINEL]);
}

async function callTokenEndpoint(userId: string, integration: string, data: TokenData): Promise<TokenData> {
  if (!data.refreshToken) {
    throw new TokenRefreshError(integration, "Token expired and no refresh_token stored. Reconnect the integration.");
  }
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
    signal: AbortSignal.timeout(TOKEN_ENDPOINT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    const message = `Refresh failed ${res.status}: ${text.slice(0, 200)}`;
    // 400/401 from a token endpoint means the grant is dead (RFC 6749 5.2:
    // invalid_grant, invalid_client). Anything else may be transient.
    if (res.status === 400 || res.status === 401) {
      throw new TokenRefreshError(integration, `${message}. Reconnect the integration.`);
    }
    throw new Error(message);
  }
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const refreshed: TokenData = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? data.refreshToken,
    expiresAt: tokens.expires_in ? Math.floor(nowMs() / 1000) + tokens.expires_in : undefined,
    scopes: data.scopes,
    config: data.config,
  };
  await storeToken(userId, integration, refreshed);
  return refreshed;
}

const inflight = new Map<string, Promise<TokenData>>();

/**
 * Get a usable token after `staleAccessToken` was found expired or rejected.
 *
 * Returns the stored token unchanged if someone already replaced it, otherwise
 * refreshes it, at most once at a time per (user, integration) across all
 * processes. Throws TokenRefreshError when only reconnecting can help.
 */
export function refreshToken(userId: string, integration: string, staleAccessToken: string): Promise<TokenData> {
  const key = lockKey(userId, integration);
  const running = inflight.get(key);
  if (running) return running;

  const p = (async (): Promise<TokenData> => {
    const deadline = nowMs() + WAIT_MS;
    for (;;) {
      const current = await getToken(userId, integration);
      if (!current) throw new TokenRefreshError(integration, "Not connected");
      if (current.accessToken !== staleAccessToken && !isExpiring(current)) return current;

      if (await tryLock(key, userId)) {
        try {
          // Re-read under the lock: the previous holder may have finished
          // between our read and our insert.
          const latest = (await getToken(userId, integration)) ?? current;
          if (latest.accessToken !== staleAccessToken && !isExpiring(latest)) return latest;
          return await callTokenEndpoint(userId, integration, latest);
        } finally {
          await unlock(key);
        }
      }

      if (nowMs() >= deadline) throw new Error(`Timed out waiting for another ${integration} token refresh`);
      await sleep(POLL_MS);
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}
