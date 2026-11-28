import crypto from "node:crypto";
import { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";

/**
 * `awb_waiting`: a signed, httpOnly cookie that lets a person held for admin
 * approval (no session) ask the waiting room whether they were let in. It is
 * NOT a credential: it only authorizes reading a coarse state from
 * GET /api/auth/waiting. Value: base64url(JSON {u,p,e}) "." base64url(HMAC).
 */
export const WAITING_COOKIE = "awb_waiting";
export const WAITING_TTL_SECONDS = 7 * 24 * 60 * 60;
export type WaitingProvider = "google" | "keycloak";

const PATH = "/api/auth";

function mac(body: string): Buffer {
  return crypto.createHmac("sha256", config.SESSION_SECRET).update(`awb-waiting|${body}`).digest();
}

export function mintWaitingValue(userId: string, provider: WaitingProvider, nowMs: number = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ u: userId, p: provider, e: Math.floor(nowMs / 1000) + WAITING_TTL_SECONDS })).toString("base64url");
  return `${body}.${mac(body).toString("base64url")}`;
}

/** The userId and provider, or null when malformed, forged, or expired. */
export function verifyWaitingValue(
  value: string | undefined,
  nowMs: number = Date.now()
): { userId: string; provider: WaitingProvider } | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const given = Buffer.from(sig, "base64url");
  const expected = mac(body);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: unknown; p?: unknown; e?: unknown };
    if (typeof p.u !== "string" || p.u === "" || typeof p.e !== "number") return null;
    if (p.p !== "google" && p.p !== "keycloak") return null;
    if (p.e * 1000 <= nowMs) return null;
    return { userId: p.u, provider: p.p };
  } catch {
    return null;
  }
}

export function setWaitingCookie(reply: FastifyReply, userId: string, provider: WaitingProvider): void {
  const secure = config.SERVER_PUBLIC_URL.startsWith("https://") ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${WAITING_COOKIE}=${mintWaitingValue(userId, provider)}; HttpOnly; Path=${PATH}; Max-Age=${WAITING_TTL_SECONDS}; SameSite=Lax${secure}`
  );
}

export function readWaitingCookie(request: FastifyRequest): string | undefined {
  const m = (request.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${WAITING_COOKIE}=([^;]+)`));
  return m ? m[1] : undefined;
}

// Small per-IP token bucket (60/min). Per process, so approximate across replicas.
const buckets = new Map<string, { tokens: number; at: number }>();
const RATE = 60;
export function waitingRateOk(key: string, nowMs: number = Date.now()): boolean {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= 10_000) buckets.clear();
    b = { tokens: RATE, at: nowMs };
    buckets.set(key, b);
  }
  b.tokens = Math.min(RATE, b.tokens + ((nowMs - b.at) * RATE) / 60_000);
  b.at = nowMs;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
export function _resetWaitingRateForTest(): void {
  buckets.clear();
}
