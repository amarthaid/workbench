import { metaTools, metaToolSchemas } from "./meta-tools";
import { renderResultText } from "./result-overflow";

// Result size cap and overflow-to-URL live in ./result-overflow.
export { MAX_RESULT_CHARS } from "./result-overflow";

export async function handleMcpRequest(body: Record<string, unknown>, userId: string): Promise<Record<string, unknown> | null> {
  const { method, params, id } = body;

  // MCP lifecycle: initialize handshake.
  if (method === "initialize") {
    const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requested ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "a-workbench", version: "0.1.0" },
      },
    };
  }

  // Client confirms it's done initializing — no response required.
  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }

  // Optional capability methods: respond with empty lists so clients don't
  // treat them as protocol violations.
  if (method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }
  if (method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: [] } };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: metaTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: metaToolSchemas[t.name] ?? { type: "object", properties: {} },
        })),
      },
    };
  }

  if (method === "tools/call") {
    const toolParams = params as { name: string; arguments: Record<string, unknown> };
    const tool = metaTools.find((t) => t.name === toolParams.name);
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Tool not found: ${toolParams.name}` },
      };
    }

    const parsed = tool.inputSchema.safeParse(toolParams.arguments);
    if (!parsed.success) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Invalid arguments: ${parsed.error.message}` },
      };
    }

    const result = await tool.handler({ userId }, parsed.data as any);

    // A plugin handler may return an image sentinel; surface it as a real MCP
    // image content block instead of JSON text. The renderer stays agnostic of
    // which meta-tool produced the result: it just looks for `_mcpImage`
    // wherever it can sit — on the value itself, under a `{ result }` wrapper,
    // or inside an `execute_tools` `{ results: [{ result }] }` batch (which may
    // carry several screenshots). Any sentinels found become image blocks;
    // otherwise the whole result is text-wrapped.
    type ImageSentinel = { _mcpImage?: { data: string; mimeType: string } };
    const collectImages = (node: unknown): { data: string; mimeType: string }[] => {
      if (!node || typeof node !== "object") return [];
      const direct = (node as ImageSentinel)._mcpImage;
      if (direct) return [direct];
      const wrapped = (node as { result?: unknown }).result;
      if (wrapped !== undefined) return collectImages(wrapped);
      const batch = (node as { results?: unknown }).results;
      if (Array.isArray(batch)) return batch.flatMap(collectImages);
      return [];
    };
    const images = collectImages(result);
    const content = images.length
      ? images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }))
      : [{ type: "text", text: await renderResultText(userId, result) }];

    return {
      jsonrpc: "2.0",
      id,
      result: { content },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}
