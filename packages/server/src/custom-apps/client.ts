import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

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
// so a fresh Client + initialize per call would lose it. Keyed by
// server:token (equivalent to user:server — the token is per-user); a token
// change (refresh) drops the session, which is fine — the old token is invalid
// for it anyway.
const sessions = new Map<string, Client>();

async function getSession(baseUrl: string, token: string): Promise<Client> {
  const key = `${baseUrl}::${token}`;
  const existing = sessions.get(key);
  if (existing) return existing;

  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: { headers: authHeaders(token) },
      })
    );
  } catch (e) {
    await client.close().catch(() => undefined);
    // Legacy HTTP+SSE-only servers (2024-11-05 spec) reject the streamable
    // handshake with a 4xx — retry over SSE (SDK-recommended fallback).
    if (e instanceof StreamableHTTPError && e.code !== undefined && e.code >= 400 && e.code < 500) {
      const sse = new Client(CLIENT_INFO);
      await sse.connect(
        new SSEClientTransport(new URL(baseUrl), {
          requestInit: { headers: authHeaders(token) },
        })
      );
      sessions.set(key, sse);
      return sse;
    }
    throw e;
  }
  sessions.set(key, client);
  return client;
}

export async function discoverTools(baseUrl: string, token: string): Promise<RemoteTool[]> {
  const client = await getSession(baseUrl, token);
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
  baseUrl: string,
  token: string,
  remoteName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const client = await getSession(baseUrl, token);
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
