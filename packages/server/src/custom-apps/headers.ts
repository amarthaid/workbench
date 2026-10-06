import { createHash } from "node:crypto";
import type { CustomAppHeader } from "./store";

export const MAX_HEADERS = 10;
export const MAX_HEADER_VALUE_BYTES = 4096;

export type HeaderInput = { name: string; value?: string };
type Result = { ok: true; headers: CustomAppHeader[] } | { ok: false; error: string };

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Headers workbench owns, or that would break the MCP transport.
const DENY = new Set([
  "host", "content-length", "content-type", "accept", "mcp-session-id", "x-workbench-via",
  "connection", "transfer-encoding", "upgrade", "keep-alive", "te", "trailer",
  "proxy-authorization", "proxy-connection",
]);

// Errors name the header, never the value.
export function validateHeaders(input: unknown, existing?: CustomAppHeader[]): Result {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "headers must be a non-empty list" };
  }
  if (input.length > MAX_HEADERS) {
    return { ok: false, error: `at most ${MAX_HEADERS} headers are allowed` };
  }
  const kept = new Map((existing ?? []).map((h) => [h.name.toLowerCase(), h]));
  const seen = new Set<string>();
  const out: CustomAppHeader[] = [];
  for (const raw of input as HeaderInput[]) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name || !TOKEN.test(name)) return { ok: false, error: `invalid header name "${name.slice(0, 64)}"` };
    const lower = name.toLowerCase();
    if (DENY.has(lower)) return { ok: false, error: `header "${name}" is not allowed` };
    if (seen.has(lower)) return { ok: false, error: `duplicate header "${name}"` };
    seen.add(lower);

    const value = typeof raw.value === "string" ? raw.value : "";
    if (value === "") {
      const prior = kept.get(lower);
      if (!prior) return { ok: false, error: `header "${name}" needs a value` };
      out.push({ name: prior.name, value: prior.value });
      continue;
    }
    // Only bytes fetch() accepts as a ByteString header value (no CR/LF/NUL, other controls, DEL, or > U+00FF),
    // and not whitespace-only (it would be trimmed to empty on the wire).
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value) || value.trim() === "") return { ok: false, error: `header "${name}" has an invalid value` };
    if (Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_BYTES) {
      return { ok: false, error: `header "${name}" value is too long` };
    }
    out.push({ name, value });
  }
  return { ok: true, headers: out };
}

export function headersToRecord(headers: CustomAppHeader[]): Record<string, string> {
  return Object.fromEntries(headers.map((h) => [h.name, h.value]));
}

/** Stable digest used as a session-cache key — the plaintext never leaves memory. */
export function fingerprint(headers: Record<string, string>): string {
  const h = createHash("sha256");
  for (const k of Object.keys(headers).sort()) h.update(`${k.toLowerCase()}\0${headers[k]}\0`);
  return h.digest("hex");
}
