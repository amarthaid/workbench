import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { safeFetch } from "./ssrf";

export interface RemoteTool {
  name: string;
  description?: string;
  /** 2025-spec tool metadata — preserved so hints like readOnly/destructive survive. */
  title?: string;
  annotations?: unknown;
  /** JSON Schema from the remote server — passed through, never zod-ified. */
  inputSchema: unknown;
}

const CLIENT_INFO = { name: "workbench", version: "0.29.0" };

// Tool calls can be long-running; without this the SDK's default ~60s timeout
// kills them. Progress resets the per-request timer, maxTotal is a hard ceiling.
const TOOL_TIMEOUT_MS = 120_000;
const TOOL_MAX_TOTAL_MS = 600_000;

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

// Session cache: stateful MCP servers keep state in a session (Mcp-Session-Id),
// so a fresh Client + initialize per call would lose it. Keyed by user:server;
// a token change (refresh) closes the old session — its token is invalid for
// the server anyway.
const sessions = new Map<string, { client: Client; token: string }>();

async function getSession(userId: string, baseUrl: string, token: string): Promise<Client> {
  const key = `${userId}::${baseUrl}`;
  const existing = sessions.get(key);
  if (existing && existing.token === token) return existing.client;
  if (existing) await existing.client.close().catch(() => undefined);

  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: { headers: authHeaders(token) },
        fetch: safeFetch,
      })
    );
  } catch (e) {
    await client.close().catch(() => undefined);
    // Legacy HTTP+SSE-only servers (2024-11-05 spec) reject the streamable
    // handshake with a 4xx — retry over SSE (SDK-recommended fallback).
    // Fall back to SSE only when the streamable handshake is genuinely
    // unsupported (404/405), not on 401/403 (an auth failure is a real error).
    if (e instanceof StreamableHTTPError && (e.code === 404 || e.code === 405)) {
      const sse = new Client(CLIENT_INFO);
      await sse.connect(
        new SSEClientTransport(new URL(baseUrl), {
          requestInit: { headers: authHeaders(token) },
          fetch: safeFetch,
        })
      );
      sessions.set(key, { client: sse, token });
      return sse;
    }
    throw e;
  }
  sessions.set(key, { client, token });
  return client;
}

export async function discoverTools(userId: string, baseUrl: string, token: string): Promise<RemoteTool[]> {
  const client = await getSession(userId, baseUrl, token);
  const { tools } = await client.listTools();
  return tools.map((t) => {
    const tool = t as { name: string; description?: string; title?: string; annotations?: unknown; inputSchema: unknown };
    return {
      name: tool.name,
      description: tool.description,
      title: tool.title,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema,
    };
  });
}

export async function callRemoteTool(
  userId: string,
  baseUrl: string,
  token: string,
  remoteName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const client = await getSession(userId, baseUrl, token);
  const result = (await client.callTool(
    { name: remoteName, arguments: args },
    undefined,
    { timeout: TOOL_TIMEOUT_MS, resetTimeoutOnProgress: true, maxTotalTimeout: TOOL_MAX_TOTAL_MS }
  )) as {
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
  };
  // Image blocks are reduced to a marker — the base64 would bloat the model
  // context, and the _mcpImage renderer only surfaces one image per node anyway.
  const content = (result.content ?? []).map((block) =>
    block.type === "image"
      ? { type: "image", mimeType: block.mimeType, data: "<image omitted>" }
      : block
  );
  return { content, isError: result.isError };
}
