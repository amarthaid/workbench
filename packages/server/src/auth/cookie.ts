import { rm } from "node:fs/promises";
import WebSocket from "ws";
import { db } from "../db";
import { encrypt, decrypt } from "./encryption";
import { activeProfiles, userProfileDir } from "./profile-chromium";
import { CDP_ORIGIN } from "./cdp-origin";
import { getReconnectState, updateReconnectState } from "./reconnect/state";

export interface CookieData {
  domain: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
  capturedAt: number;
}

type CdpSend = (payload: Record<string, unknown>) => void;
export function createProxyAuthHandler(creds: { username: string; password: string }) {
  let id = 1000;
  return function handle(msg: Record<string, any>, send: CdpSend): void {
    if (msg.method === "Target.attachedToTarget") {
      send({ sessionId: msg.params.sessionId, id: id++, method: "Fetch.enable", params: { handleAuthRequests: true } });
    } else if (msg.method === "Fetch.authRequired") {
      const isProxy = msg.params?.authChallenge?.source === "Proxy";
      send({
        sessionId: msg.sessionId,
        id: id++,
        method: "Fetch.continueWithAuth",
        params: {
          requestId: msg.params.requestId,
          authChallengeResponse: isProxy
            ? { response: "ProvideCredentials", username: creds.username, password: creds.password }
            : { response: "Default" },
        },
      });
    } else if (msg.method === "Fetch.requestPaused") {
      send({ sessionId: msg.sessionId, id: id++, method: "Fetch.continueRequest", params: { requestId: msg.params.requestId } });
    }
  };
}

export function startProxyAuth(browserWsUrl: string, username: string, password: string): WebSocket {
  const handler = createProxyAuthHandler({ username, password });
  const ws = new WebSocket(browserWsUrl, { perMessageDeflate: false, origin: CDP_ORIGIN });
  ws.on("open", () => {
    ws.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false } }));
  });
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handler(msg, (payload) => ws.send(JSON.stringify(payload)));
    } catch { /* ignore malformed frames */ }
  });
  ws.on("error", () => { /* best-effort */ });
  return ws;
}

export type RawCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
};

export function filterCookies(
  raw: RawCookie[],
  domains: string[],
  now: number = Math.floor(Date.now() / 1000)
): CookieData["cookies"] {
  const allowed = new Set(domains.map((d) => d.replace(/^\./, "").toLowerCase()));
  const allowedArr = Array.from(allowed);
  return raw
    .filter((c) => {
      if (c.expires && c.expires > 0 && c.expires < now) return false;
      const bare = c.domain.replace(/^\./, "").toLowerCase();
      return allowedArr.some((d) => bare === d || bare.endsWith("." + d));
    })
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires && c.expires > 0 ? Math.floor(c.expires) : undefined,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as "Strict" | "Lax" | "None" | undefined,
    }));
}

export async function resetBrowserProfile(userId: string): Promise<void> {
  if (activeProfiles.has(userId)) {
    throw new Error("BROWSER_SESSION_BUSY: finish or cancel the active browser session first");
  }
  await rm(userProfileDir(userId), { recursive: true, force: true }).catch(() => undefined);
}

export async function storeCookies(userId: string, integration: string, data: CookieData): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    `INSERT INTO connections (user_id, integration, access_token, cookies, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, integration) DO UPDATE SET
       access_token = excluded.access_token,
       cookies = excluded.cookies,
       updated_at = ?`,
    [userId, integration, encrypt("cookie-auth"), encrypt(JSON.stringify(data)), now, now, now]
  );
  // Fresh cookies (manual connect, import, or auto-reconnect) end a dead spell.
  // A recorded failure stays: it holds the cooldown, and import accepts an API
  // key, so clearing it here would let an agent loop import -> dead call ->
  // recipe run and replay the vault password without a cap. Only a portal
  // session clears it (clearReconnectFailure).
  await updateReconnectState(userId, integration, { deadAt: undefined });
}

/**
 * Drop a failed attempt (and so its cooldown), keeping a success, and stamp
 * `clearedAt` so a run the runner only remembers in memory (the row was
 * deleted and re-imported since) stops holding too. Call only on a path a
 * signed-in human drove (portal session): a manual reconnect there means the
 * stale "Auto-reconnect failed" no longer applies.
 */
export async function clearReconnectFailure(userId: string, integration: string): Promise<void> {
  const { last } = await getReconnectState(userId, integration);
  await updateReconnectState(userId, integration, {
    clearedAt: Date.now(),
    ...(last && !last.ok ? { last: undefined } : {}),
  });
}

export async function getCookies(userId: string, integration: string): Promise<CookieData | null> {
  const row = await db.get<{ cookies: Buffer }>(
    "SELECT cookies FROM connections WHERE user_id = ? AND integration = ?",
    [userId, integration]
  );

  if (!row?.cookies) return null;

  const decrypted = decrypt(row.cookies);
  return JSON.parse(decrypted) as CookieData;
}

export async function deleteCookies(userId: string, integration: string): Promise<void> {
  await db.run("DELETE FROM connections WHERE user_id = ? AND integration = ?", [userId, integration]);
}

export function isCookieExpired(data: CookieData): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (data.cookies.length === 0) return true;
  const liveCount = data.cookies.filter((c) => !c.expires || c.expires >= now).length;
  return liveCount === 0;
}

export async function hasValidCookies(userId: string, integration: string): Promise<boolean> {
  const data = await getCookies(userId, integration);
  if (!data || isCookieExpired(data)) return false;
  return !(await getReconnectState(userId, integration)).deadAt;
}
