# MCP result overflow goes to a URL, not into context

**Date:** 2026-11-23

## Problem

`tools/call` results over 60,000 characters were cut mid-string with a notice.
An agent that needed the whole payload (a long Confluence page for a QA pass, a big
search result) could not get it through `/mcp` at all.

An earlier attempt (PR #46, closed) split the payload into parts returned across
several content blocks, with a `continue_tool_result` tool for the rest. Two problems:

1. The parts lived in a per-process `Map`. Any second replica, or a worker under
   `CLUSTER_ENABLED`, could not serve a continuation it did not store.
2. Paging through parts still loads the whole payload into the agent's context,
   just spread over turns with envelope overhead on top.

## Fix

Past the cap, `renderResultText` (`packages/server/src/mcp/result-overflow.ts`)
writes the full JSON into the caller's file workspace and mints a download grant
with the existing workspace presign (`mintPresign(..., "download")`). The agent
gets a stub with the URL, size, expiry and a 2,000-character preview, curls it,
and filters locally with `jq`/`grep`. Only what it extracts enters context.

- **Stateless across pods:** bytes are on the shared workspace volume, the grant is
  a row in `pending_auth`. No new store, no reaper, no DDL.
- **Multi-use until expiry:** the download grant is deliberately not single-use
  (curl retries, some clients `HEAD` first). `WORKSPACE_PRESIGN_TTL_SECONDS`
  bounds it. The file follows the normal workspace TTL and quota.
- **Batches:** for `execute_tools`, the largest item results are offloaded one at a
  time until the batch fits, so small siblings and errors stay inline and each
  oversized item gets its own file. If the batch still does not fit, the whole
  result is offloaded.
- **Fallback:** if the write is refused (`WORKSPACE_MAX_FILE_BYTES`, per-user
  quota) the old truncation applies.

## Requirement on the client

The agent must be able to reach `SERVER_PUBLIC_URL` over HTTP (curl or a fetch
tool). Claude Code can. A client that cannot still sees the preview.
