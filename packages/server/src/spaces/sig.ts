import crypto from "node:crypto";
import { config } from "../config";

// The capability that lets a sandboxed (credential-less) iframe load a Space's
// files: /s/<name>/app/<sig>/... The MAC is the spec's
// HMAC-SHA256(SESSION_SECRET, "space-app|" + name + "|" + userId + "|" + exp).
//
// The serve route has no other way to learn which viewer the sig was minted
// for, so the user id travels inside the sig:
//   base64url(exp) "." base64url(userId) "." base64url(mac)
// The route takes the sig as the first segment of its wildcard tail, not as a
// :param, so find-my-way's 100-character maxParamLength never applies to it.

export const SIG_TTL_MS = 12 * 60 * 60 * 1000;

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function mac(name: string, userId: string, exp: number): Buffer {
  return crypto
    .createHmac("sha256", config.SESSION_SECRET)
    .update(`space-app|${name}|${userId}|${exp}`)
    .digest();
}

export function mintSig(name: string, userId: string, nowMs: number = Date.now()): string {
  const exp = nowMs + SIG_TTL_MS;
  return [b64u(Buffer.from(String(exp))), b64u(Buffer.from(userId, "utf8")), b64u(mac(name, userId, exp))].join(".");
}

/** The viewer id the sig was minted for, or null when it is malformed, forged, for another Space, or expired. */
export function verifySig(name: string, sig: string, nowMs: number = Date.now()): string | null {
  if (typeof sig !== "string" || sig.length > 512) return null;
  const parts = sig.split(".");
  if (parts.length !== 3) return null;
  const [expPart, userPart, macPart] = parts;
  const expText = Buffer.from(expPart, "base64url").toString("utf8");
  if (!/^\d{1,16}$/.test(expText)) return null;
  const exp = Number(expText);
  const userId = Buffer.from(userPart, "base64url").toString("utf8");
  if (userId === "") return null;
  // Canonical encodings only, so one sig has exactly one spelling.
  if (b64u(Buffer.from(expText)) !== expPart || b64u(Buffer.from(userId, "utf8")) !== userPart) return null;
  const given = Buffer.from(macPart, "base64url");
  const expected = mac(name, userId, exp);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (exp <= nowMs) return null;
  return userId;
}
