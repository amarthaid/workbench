import { readSecretValue } from "./store";

// `{{vault:NAME}}` in tool args → the secret's value, applied at the top of
// executeSingle (mcp/meta-tools.ts) so MCP, batch and REST all go through it.
// The model composes references; the server sees values; the model never does.
//
// The grammar inside the braces is the store's name grammar. Anything that does
// not match is not a reference and is left for the tool's own schema to reject.

export const VAULT_REF_RE = /\{\{vault:([a-z0-9][a-z0-9_.-]{0,63})\}\}/g;

export class VaultRefError extends Error {
  readonly code = "VAULT_SECRET_NOT_FOUND" as const;
  constructor(public readonly secretName: string) {
    super(`No secret named '${secretName}'. Call vault_list to see what exists.`);
    this.name = "VaultRefError";
  }
}

function walkStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkStrings(v, fn);
    return out;
  }
  return value;
}

export function findVaultRefs(args: unknown): string[] {
  const names = new Set<string>();
  walkStrings(args, (s) => {
    for (const m of s.matchAll(VAULT_REF_RE)) names.add(m[1]);
    return s;
  });
  return [...names].sort();
}

export function substituteVaultRefs<T>(args: T, values: Map<string, string>): T {
  return walkStrings(args, (s) =>
    s.replace(VAULT_REF_RE, (whole, name: string) => values.get(name) ?? whole)
  ) as T;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrubString(s: string, substituted: Map<string, string>): string {
  if (substituted.size === 0) return s;
  // Longest value first so a value that contains another is replaced whole.
  const entries = [...substituted].sort((a, b) => b[1].length - a[1].length);
  let out = s;
  for (const [name, value] of entries) {
    if (value === "") continue;
    out = out.replace(new RegExp(escapeRe(value), "g"), `{{vault:${name}}}`);
  }
  return out;
}

export class VaultScrubError extends Error {
  readonly code = "VAULT_SCRUB_FAILED" as const;
  constructor(cause: unknown) {
    super("Failed to scrub vault values from tool result");
    this.name = "VaultScrubError";
    this.cause = cause;
  }
}

// Scrub a JSON-safe tree structurally rather than as text, so a secret that
// happens to look like a JSON scalar (a number, "true", "null") is only
// matched where it actually sits as a value or key — never by regexing raw
// JSON text, which can't distinguish a value's position from surrounding
// string content (see 2026-09-16 finding on the earlier regex approach).
function scrubJson(node: unknown, substituted: Map<string, string>): unknown {
  if (typeof node === "string") return scrubString(node, substituted);
  if (node === null || typeof node === "number" || typeof node === "boolean") {
    for (const [name, value] of substituted) {
      if (value !== "" && String(node) === value) return `{{vault:${name}}}`;
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((v) => scrubJson(v, substituted));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[scrubString(k, substituted)] = scrubJson(v, substituted);
    }
    return out;
  }
  return node;
}

/**
 * Put the references back into a tool result before it re-enters the model.
 *
 * Only what THIS call substituted is scrubbed. Scanning every result for every
 * secret the user owns would decrypt the whole vault on each call, and a short
 * value would collide with unrelated output. Best-effort against encodings: a
 * base64'd or URL-encoded echo is not caught.
 *
 * Fails closed: a value the JSON round-trip can't represent (BigInt, a cycle)
 * throws `VaultScrubError` rather than silently falling back to returning the
 * unscrubbed result — the caller (executeSingle) turns that into an error
 * response, never a plaintext leak.
 */
export function scrubVaultValues<T>(value: T, substituted: Map<string, string>): T {
  if (substituted.size === 0) return value;
  if (value === undefined || typeof value === "function") return value;
  let normalised: unknown;
  try {
    normalised = JSON.parse(JSON.stringify(value));
  } catch (e) {
    throw new VaultScrubError(e);
  }
  return scrubJson(normalised, substituted) as T;
}

export async function resolveVaultRefs(
  userId: string,
  args: Record<string, unknown>
): Promise<{ args: Record<string, unknown>; substituted: Map<string, string> }> {
  const names = findVaultRefs(args);
  const substituted = new Map<string, string>();
  if (names.length === 0) return { args, substituted };
  for (const name of names) {
    const value = await readSecretValue(userId, name);
    if (value === null) throw new VaultRefError(name);
    substituted.set(name, value);
  }
  return { args: substituteVaultRefs(args, substituted), substituted };
}
