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

// `substringOk`, when given, restricts which values may match as a substring
// of a larger string. A value absent from it only matches when the WHOLE
// string equals it exactly — never mid-sentence. Omit it (as every call site
// outside meta-tools' recent-values merge does) to allow every value to match
// anywhere, the original behaviour. See docs/findings/2026-09-16-vault-scrub-json-text.md
// for why this exists: a short value remembered from an earlier call (a PIN,
// a port) is more likely to collide with unrelated prose than a value this
// call substituted itself, which the agent just opted into using.
export function scrubString(
  s: string,
  entries: Iterable<readonly [string, string]>,
  substringOk?: ReadonlySet<string>
): string {
  const list = [...entries].filter(([, value]) => value !== "");
  if (list.length === 0) return s;

  // Whole-string-only entries: only replace when the entire string equals
  // the value. Checked first and against the ORIGINAL string, since a value
  // this restricted is by construction not a substring of anything else in
  // this list (values are unique — see the dedupe in meta-tools.ts).
  if (substringOk) {
    for (const [name, value] of list) {
      if (!substringOk.has(value) && s === value) return `{{vault:${name}}}`;
    }
  }

  const substringEntries = (substringOk ? list.filter(([, value]) => substringOk.has(value)) : list)
    // Longest value first: at a given position a regex alternation takes the
    // first alternative that matches, so ordering longest-first is what
    // makes a value that contains another get replaced whole rather than
    // partially.
    .sort((a, b) => b[1].length - a[1].length);
  if (substringEntries.length === 0) return s;

  // One pass over the ORIGINAL string via a single alternated regex, not a
  // sequential `.replace()` per entry over a growing accumulator. The
  // sequential form re-scans text an EARLIER replacement just produced —
  // replacing "vault" late in the loop can match the literal "vault" inside
  // a "{{vault:name}}" placeholder an earlier entry just inserted, corrupting
  // it into a nested placeholder. `String.replace` over one regex visits the
  // input once, left to right, and never revisits generated output, so this
  // can't happen; it's also what makes the longest-first ordering above
  // reliable across every entry at once rather than only within one pass.
  const nameByValue = new Map(substringEntries.map(([name, value]) => [value, name]));
  const pattern = new RegExp(substringEntries.map(([, value]) => escapeRe(value)).join("|"), "g");
  return s.replace(pattern, (matched) => `{{vault:${nameByValue.get(matched)}}}`);
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
// string content (docs/findings/2026-09-16-vault-scrub-json-text.md).
function scrubJson(
  node: unknown,
  entries: Array<readonly [string, string]>,
  substringOk?: ReadonlySet<string>
): unknown {
  if (typeof node === "string") return scrubString(node, entries, substringOk);
  if (node === null || typeof node === "number" || typeof node === "boolean") {
    // Scalar leaves always require whole-value equality regardless of
    // `substringOk` — there is no "inside a larger string" for a bare
    // number, boolean, or null, so the guard has nothing to restrict here.
    for (const [name, value] of entries) {
      if (value !== "" && String(node) === value) return `{{vault:${name}}}`;
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((v) => scrubJson(v, entries, substringOk));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[scrubString(k, entries, substringOk)] = scrubJson(v, entries, substringOk);
    }
    return out;
  }
  return node;
}

/**
 * Put the references back into a tool result before it re-enters the model.
 *
 * Only values the caller passes in are scrubbed — what THIS call substituted,
 * plus (per `packages/server/src/vault/recent.ts`) whatever the same user
 * substituted in a recent earlier call. Scanning every result for every
 * secret the user owns would decrypt the whole vault on each call, and a
 * short value would collide with unrelated output regardless of whether the
 * agent had ever used it — that's what `substringOk` guards against for the
 * recent-values case. Best-effort against encodings: a base64'd or
 * URL-encoded echo is not caught.
 *
 * Fails closed: a value the JSON round-trip can't represent (BigInt, a cycle)
 * throws `VaultScrubError` rather than silently falling back to returning the
 * unscrubbed result — the caller (executeSingle) turns that into an error
 * response, never a plaintext leak. This applies even when the entries came
 * entirely from the recent-values ring on an otherwise vault-unrelated call:
 * once any value needs scrubbing, the whole result must be JSON-safe or the
 * call fails, not just the vault-referencing ones.
 */
export function scrubVaultValues<T>(
  value: T,
  entries: Iterable<readonly [string, string]>,
  substringOk?: ReadonlySet<string>
): T {
  const list = [...entries].filter(([, v]) => v !== "");
  if (list.length === 0) return value;
  if (value === undefined || typeof value === "function") return value;
  let normalised: unknown;
  try {
    normalised = JSON.parse(JSON.stringify(value));
  } catch (e) {
    throw new VaultScrubError(e);
  }
  return scrubJson(normalised, list, substringOk) as T;
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
