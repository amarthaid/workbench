// Tool-call arguments and results for the audit log (AUDIT_PAYLOAD).
//
// What is recorded is a sanitised, capped JSON text, never the live value:
//
// - Arguments are the ones the agent SENT, before `{{vault:NAME}}` references
//   are resolved, so vault secrets stay as placeholders. Results are the
//   vault-scrubbed result the agent was given.
// - Any object key that names a credential (password, secret, token, api key,
//   authorization, cookie, private key …) has its value replaced with
//   "[REDACTED]", at any depth. A secret the agent typed into an ordinary
//   field is NOT caught: the audit log holds what the agent sent.
// - Binary data (Buffer / typed arrays), `data:` URIs and long base64 runs
//   (screenshots, file contents) become "[binary N bytes]".
// - The JSON text is cut at AUDIT_PAYLOAD_ARGS_MAX_BYTES (arguments) or
//   AUDIT_PAYLOAD_RESULT_MAX_BYTES (result), counted in UTF-8 bytes, and flagged
//   as truncated; a truncated value is no longer valid JSON.
//
// Request/response bodies of the curl proxy are never recorded; this is only
// for tool calls (/mcp, /rest).

import { config } from "../config";

export type PayloadMode = "off" | "args" | "full";

export interface CapturedValue {
  text: string;
  truncated: boolean;
  /** UTF-8 size of the full sanitised JSON text, before any cut. */
  bytes: number;
}

// Matched on the words of a key (camelCase, snake_case, kebab-case split), so
// `apiKey`, `client_secret`, `X-Auth-Token` match and `footprint` does not.
const SECRET_WORDS = new Set([
  "password", "passwd", "passphrase", "pwd", "secret", "secrets", "token", "tokens", "apikey",
  "authorization", "authorisation", "cookie", "cookies", "credential", "credentials", "otp", "pin",
  "privatekey", "sessionid", "signature",
]);
const SECRET_PAIRS = new Set(["api key", "private key", "session id", "access key"]);

export function isSecretKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 1 && words[0] === "auth") return true;
  for (let i = 0; i < words.length; i++) {
    if (SECRET_WORDS.has(words[i])) return true;
    if (i > 0 && SECRET_PAIRS.has(`${words[i - 1]} ${words[i]}`)) return true;
  }
  return false;
}
const BASE64_RUN = /^[A-Za-z0-9+/_-]{512,}={0,2}$/;
const MAX_DEPTH = 32;

function binaryNote(bytes: number): string {
  return `[binary ${bytes} bytes]`;
}

/** A JSON-safe copy with credentials redacted and binary blobs replaced. Never throws. */
export function sanitizeForAudit(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v ?? null;
    if (typeof v === "string") {
      if (v.startsWith("data:") && v.length > 64) return binaryNote(Math.floor((v.length - v.indexOf(",") - 1) * 0.75));
      // Base64 is often wrapped at 64/76 columns: ignore line breaks only, so
      // prose (which has spaces) never qualifies. Mixed case is required so a
      // long run of one letter or a lowercase identifier is not mistaken for it.
      if (v.length >= 512) {
        const compact = v.replace(/[\r\n]+/g, "");
        if (BASE64_RUN.test(compact) && /[A-Z]/.test(compact) && /[a-z]/.test(compact)) {
          return binaryNote(Math.floor(compact.length * 0.75));
        }
      }
      return v;
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function" || typeof v === "symbol") return undefined;
    if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return binaryNote((v as ArrayBufferView).byteLength);
    if (v instanceof ArrayBuffer) return binaryNote(v.byteLength);
    if (v instanceof Date) return v.toISOString();
    if (typeof v !== "object") return String(v);
    if (depth >= MAX_DEPTH) return "[too deep]";
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1) ?? null);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (isSecretKey(k) && x !== null && x !== undefined && x !== "") {
        out[k] = "[REDACTED]";
        continue;
      }
      const w = walk(x, depth + 1);
      if (w !== undefined) out[k] = w;
    }
    return out;
  };
  try {
    return walk(value, 0);
  } catch {
    return "[unserialisable]";
  }
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
function capUtf8(s: string, maxBytes: number): CapturedValue {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false, bytes: buf.length };
  let end = maxBytes;
  // Back off continuation bytes (10xxxxxx) so the cut lands on a boundary.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true, bytes: buf.length };
}

/** Sanitised JSON text of `value`, capped. Undefined when there is nothing to record. */
export function captureValue(value: unknown, maxBytes: number): CapturedValue | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(sanitizeForAudit(value)) ?? "null";
  } catch {
    text = '"[unserialisable]"';
  }
  return capUtf8(text, maxBytes);
}

export function payloadMode(): PayloadMode {
  return config.AUDIT_PAYLOAD;
}

export function payloadLimits(): { args: number; result: number } {
  return { args: config.AUDIT_PAYLOAD_ARGS_MAX_BYTES, result: config.AUDIT_PAYLOAD_RESULT_MAX_BYTES };
}
