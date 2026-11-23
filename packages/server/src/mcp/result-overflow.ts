import crypto from "node:crypto";
import { mintPresign } from "../workspace/presign";
import { writeFileBytes } from "../workspace/store";

// Upstream APIs can return arbitrarily large payloads and plugin handlers
// mostly pass them through; without a cap a single tools/call can blow the
// caller's context window.
export const MAX_RESULT_CHARS = 60_000;

/** How much of an offloaded payload is shown inline so the agent can see its shape. */
export const OVERFLOW_PREVIEW_CHARS = 2_000;

// An oversized result is NOT cut mid-string any more. It is written whole to the
// caller's file workspace and handed back as a short-lived download URL. The
// agent fetches it with curl and filters it locally (jq, grep), so only the part
// it extracts ever enters its context.
//
// Stateless across pods by construction: the bytes sit on the shared workspace
// volume and the grant sits in `pending_auth` (workspace/presign.ts), so the
// pod that minted the URL does not have to be the one that serves it. The URL
// is multi-use inside its TTL (a curl gets retried; some clients HEAD first)
// and dead after it. The file itself goes with the workspace reaper.

export interface OverflowStub {
  _overflow: true;
  url: string;
  /** Workspace file name: also readable through files_read / files_presign until the workspace reaper drops it. */
  file: string;
  bytes: number;
  content_type: "application/json";
  url_expires_at: string;
  preview: string;
  hint: string;
}

const HINT =
  "Result too large to return inline. Fetch the full JSON with `curl -sS -o result.json \"<url>\"` and filter it locally (jq, grep, head) rather than printing it whole. The URL needs no auth header, works more than once, and expires at url_expires_at.";

/** The old behaviour, kept as the fallback when the payload cannot be offloaded. */
export function truncateResultText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n…[result truncated: ${text.length} chars total, showing first ${MAX_RESULT_CHARS}. Narrow the request (limit/fields/pagination) to get complete data.]`
  );
}

function overflowName(): string {
  // Flat name: the workspace HTTP routes take one path segment.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `mcp-overflow-${ts}-${crypto.randomBytes(4).toString("hex")}.json`;
}

async function offload(userId: string, text: string): Promise<OverflowStub> {
  const name = overflowName();
  const data = Buffer.from(text, "utf8");
  // Throws WorkspaceError on TOO_LARGE / QUOTA_EXCEEDED; the caller falls back.
  await writeFileBytes(userId, name, data);
  const grant = await mintPresign(userId, name, "download");
  return {
    _overflow: true,
    url: grant.url,
    file: name,
    bytes: data.byteLength,
    content_type: "application/json",
    url_expires_at: new Date(grant.expiresAt).toISOString(),
    preview: text.slice(0, OVERFLOW_PREVIEW_CHARS),
    hint: HINT,
  };
}

type BatchItem = { result?: unknown } & Record<string, unknown>;

function isBatch(value: unknown): value is { results: BatchItem[] } & Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { results?: unknown }).results)
  );
}

/**
 * Render a tool result as the text block of an MCP tools/call response.
 *
 * - Fits under MAX_RESULT_CHARS: returned as-is.
 * - An `execute_tools` batch: the largest item results are offloaded one by one
 *   until the batch fits, so small siblings stay inline and each oversized item
 *   gets its own URL (never one file mixing several items).
 * - Anything else, or a batch still too big after that: the whole result is
 *   offloaded.
 * - Offload impossible (quota, file cap, disk): falls back to truncation.
 */
export async function renderResultText(userId: string, result: unknown): Promise<string> {
  const text = JSON.stringify(result) ?? "null";
  if (text.length <= MAX_RESULT_CHARS) return text;

  try {
    if (isBatch(result)) {
      const items = result.results.map((item) => ({ ...item }));
      const order = items
        .map((item, i) => ({ i, len: "result" in item ? (JSON.stringify(item.result) ?? "").length : 0 }))
        .filter((x) => x.len > OVERFLOW_PREVIEW_CHARS)
        .sort((a, b) => b.len - a.len);
      let out = text;
      for (const { i } of order) {
        if (out.length <= MAX_RESULT_CHARS) break;
        items[i] = { ...items[i], result: await offload(userId, JSON.stringify(items[i].result)) };
        out = JSON.stringify({ ...result, results: items });
      }
      if (out.length <= MAX_RESULT_CHARS) return out;
    }
    return JSON.stringify(await offload(userId, text));
  } catch {
    return truncateResultText(text);
  }
}
