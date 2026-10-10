// Capability URLs for the audio routes. The voice client holding a call open
// is not the agent that called browser_audio_start and carries no workbench
// credential, so the URL itself is the credential: 128 random bits, valid only
// while that one AudioSession is live.
//
// The registry is keyed by SHA-256 of the capability, never the capability
// itself: a Map lookup compares keys with string equality, and hashing first
// means the timing of that comparison says nothing about the secret.
import { createHash, randomBytes } from "node:crypto";
import type { AudioSession } from "./session";

export const CAPABILITY_BYTES = 16;
/** The shape capabilityFor mints: 16 bytes of base64url, unpadded. */
export const CAPABILITY_RE = /^[A-Za-z0-9_-]{22}$/;

const byHash = new Map<string, AudioSession>();
const bySession = new WeakMap<AudioSession, { cap: string; hash: string }>();

const hashOf = (cap: string) => createHash("sha256").update(cap).digest("base64url");

/** The session's capability, minted on first call. Revoked automatically when the session ends. */
export function capabilityFor(session: AudioSession): string {
  const known = bySession.get(session);
  if (known) return known.cap;
  const cap = randomBytes(CAPABILITY_BYTES).toString("base64url");
  const hash = hashOf(cap);
  byHash.set(hash, session);
  bySession.set(session, { cap, hash });
  void session.whenEnded.then(() => revokeCapability(session));
  return cap;
}

/** The live session this capability opens, or undefined (unknown, revoked, or the session has ended). */
export function sessionForCapability(cap: string): AudioSession | undefined {
  if (!cap) return undefined;
  const s = byHash.get(hashOf(cap));
  return s && !s.ended ? s : undefined;
}

export function revokeCapability(session: AudioSession): void {
  const known = bySession.get(session);
  if (known) byHash.delete(known.hash);
}

/** Replace any capability in a URL path with a fixed marker, for logs and spans. */
export function redactAudioPath(url: string): string {
  return url.replace(/(\/api\/browser\/audio\/)[^/?#]+/, "$1[REDACTED]");
}
