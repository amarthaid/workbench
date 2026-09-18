import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface RemoteTool {
  name: string;
  description?: string;
  /** JSON Schema from the remote server — passed through, never zod-ified. */
  inputSchema: unknown;
}

// ponytail: fresh Client+transport per operation (re-initializes each call).
// Add a per-(user,app) session cache if round-trips or server session
// churn ever matter.
async function withClient<T>(
  baseUrl: string,
  token: string,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "workbench", version: "0.29.0" });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function discoverTools(baseUrl: string, token: string): Promise<RemoteTool[]> {
  return withClient(baseUrl, token, async (client) => {
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  });
}

export async function callRemoteTool(
  baseUrl: string,
  token: string,
  remoteName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return withClient(baseUrl, token, async (client) => {
    // SDK types callTool's result as a union (task variant has no `content`),
    // so narrow to the CallToolResult shape we actually get.
    const result = (await client.callTool({ name: remoteName, arguments: args })) as {
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
  });
}
