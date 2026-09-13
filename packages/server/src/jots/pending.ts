import crypto from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { config } from "../config";

export interface PendingDeploy {
  owner: string;
  name: string;
  // "replace" publishes the archive as the whole jot; "patch" overlays it onto
  // the live tree. A patch token carries no access/passwordHash — those are
  // read from the live manifest at commit, so a patch can never change gating.
  mode: "replace" | "patch";
  access?: "public" | "password";
  passwordHash?: string;
  cors?: boolean;
  deletes?: string[];
  expiresAt: number;
}

// `mode` is optional at the call site and defaults to "replace" so existing
// deploy callers are unaffected.
export type MintInput = Omit<PendingDeploy, "expiresAt" | "mode"> & {
  mode?: "replace" | "patch";
};

const AUDIENCE = "a-workbench-jot-upload";
const ISSUER = "a-workbench";

// The token is a JWE (encrypted), not a JWS (merely signed): its claims carry
// the owner's userId and — for a password jot — the scrypt hash of the jot
// password. A signed JWT publishes its payload in plaintext to anyone holding
// the URL, and that URL is handed to an agent, pasted into a curl command, and
// kept in shell history. Encrypting keeps the token as opaque as the random
// string it replaces. A256GCM authenticates as well as encrypts, so the
// ciphertext tag is the integrity check — no separate signature needed.
//
// HKDF derives the content key from SESSION_SECRET rather than using it raw:
// `dir`/A256GCM needs exactly 32 bytes, and the distinct `info` keeps this key
// separate from the HS256 signing uses of the same secret elsewhere.
function contentKey(): Uint8Array {
  const ikm = new TextEncoder().encode(config.SESSION_SECRET);
  const info = new TextEncoder().encode("jot-upload-token-v1");
  return new Uint8Array(crypto.hkdfSync("sha256", ikm, new Uint8Array(0), info, 32));
}

// A token rides in the URL path, so its length is bounded by what the router
// and any proxy accept in a request line. Everything in the payload is
// fixed-size (~320 chars) except `deletes`, so a large delete list is the only
// way to reach this. Refuse at mint rather than hand back a URL that dies at
// the router or proxy with no usable error.
//
// The server passes this to Fastify as `maxParamLength`, so the router's bound
// and the mint bound are the same number by construction. It stays well under
// nginx's default 8 KiB request-line buffer.
export const MAX_TOKEN_CHARS = 2048;

export class UploadTokenTooLargeError extends Error {
  constructor() {
    super("Upload token exceeds the maximum URL-safe length");
    this.name = "UploadTokenTooLargeError";
  }
}

// Replay guard. The token is stateless, so nothing but this stops a captured
// URL being uploaded twice inside its TTL. Keyed by `jti` and held only until
// the token would have expired anyway. Best-effort by design: it is per
// process, so under CLUSTER_ENABLED or multiple replicas a replay landing on
// another worker still succeeds. It is defence in depth, not the security
// boundary — the TTL is.
const consumed = new Map<string, number>();

// Clock seam: overridable in tests so TTL expiry is testable without sleeping.
let now: () => number = () => Date.now();
export function _setNowForTest(fn: () => number): void {
  now = fn;
}

export async function mint(input: MintInput): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now() + config.JOTS_UPLOAD_TTL_SECONDS * 1000;
  const token = await new EncryptJWT({
    owner: input.owner,
    name: input.name,
    mode: input.mode ?? "replace",
    access: input.access,
    passwordHash: input.passwordHash,
    cors: input.cors,
    deletes: input.deletes,
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setAudience(AUDIENCE)
    .setIssuer(ISSUER)
    .setJti(crypto.randomUUID())
    .setIssuedAt(Math.floor(now() / 1000))
    // Round up so the token never expires marginally before the `expiresAt`
    // milliseconds handed back to the caller.
    .setExpirationTime(Math.ceil(expiresAt / 1000))
    .encrypt(contentKey());

  if (token.length > MAX_TOKEN_CHARS) throw new UploadTokenTooLargeError();
  return { token, expiresAt };
}

// Single-use within this process. Returns null for a token that is malformed,
// forged, expired, or already consumed here.
export async function consume(token: string): Promise<PendingDeploy | null> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return null;

  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtDecrypt(token, contentKey(), {
      audience: AUDIENCE,
      issuer: ISSUER,
      clockTolerance: 0,
      // Threads the clock seam through jose's own `exp` check, so expiry stays
      // testable without sleeping.
      currentDate: new Date(now()),
    });
    claims = payload as Record<string, unknown>;
  } catch {
    // Wrong key, tampered ciphertext, wrong audience/issuer, or expired.
    return null;
  }

  const jti = claims.jti;
  if (typeof jti !== "string") return null;
  if (consumed.has(jti)) return null;

  const owner = claims.owner;
  const name = claims.name;
  const mode = claims.mode;
  if (typeof owner !== "string" || typeof name !== "string") return null;
  if (mode !== "replace" && mode !== "patch") return null;

  const expiresAt = typeof claims.exp === "number" ? claims.exp * 1000 : now();
  consumed.set(jti, expiresAt);

  return {
    owner,
    name,
    mode,
    access: claims.access === "public" || claims.access === "password" ? claims.access : undefined,
    passwordHash: typeof claims.passwordHash === "string" ? claims.passwordHash : undefined,
    cors: claims.cors === true ? true : undefined,
    deletes: Array.isArray(claims.deletes) ? (claims.deletes as string[]) : undefined,
    expiresAt,
  };
}

// Drops replay-guard entries whose token has expired on its own. Past that
// point the token is refused by the `exp` check, so remembering it adds
// nothing.
export function reapExpired(): void {
  const t = now();
  for (const [jti, exp] of consumed) {
    if (exp < t) consumed.delete(jti);
  }
}

// Periodic cleanup of the replay guard. Mirrors auth/connections reaper.
let timer: ReturnType<typeof setInterval> | null = null;
export function startUploadReaper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => reapExpired(), intervalMs);
  timer.unref?.();
}
export function stopUploadReaper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
