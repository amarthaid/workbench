import { listConnectors, integrationKey } from "./store";
import { ensureConnectorToken } from "./oauth";
import { discoverTools } from "./client";

export interface IndexedTool {
  /** Namespaced name exposed to the agent: `${connectorName}__${remoteName}`. */
  name: string;
  /** `connections.integration` key, e.g. `connector:<id>`. */
  integration: string;
  connectorId: string;
  baseUrl: string;
  remoteName: string;
  description: string;
  /** JSON Schema passthrough from the remote server. */
  inputSchema: unknown;
}

export function namespacedName(connectorName: string, remoteName: string): string {
  return `${connectorName}__${remoteName}`;
}

// Per-user cache of discovered tools. Live discovery happens at connect and is
// re-run lazily once this TTL lapses — the remote tool list is not immutable.
const cache = new Map<string, { at: number; tools: IndexedTool[] }>();
const TTL_MS = 60_000;

export function invalidateIndex(userId: string): void {
  cache.delete(userId);
}

export async function ensureIndex(userId: string): Promise<IndexedTool[]> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.tools;

  const connectors = await listConnectors(userId);
  const tools: IndexedTool[] = [];
  for (const c of connectors) {
    let token: string;
    try {
      token = await ensureConnectorToken(userId, c);
    } catch {
      continue; // not connected / refresh failed — tools simply don't appear
    }
    try {
      const remote = await discoverTools(c.baseUrl, token);
      for (const t of remote) {
        tools.push({
          name: namespacedName(c.name, t.name),
          integration: integrationKey(c.id),
          connectorId: c.id,
          baseUrl: c.baseUrl,
          remoteName: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
        });
      }
    } catch {
      // discovery failure: skip this connector for this cycle
    }
  }
  cache.set(userId, { at: Date.now(), tools });
  return tools;
}

export async function getToolForUser(userId: string, name: string): Promise<IndexedTool | undefined> {
  const tools = await ensureIndex(userId);
  return tools.find((t) => t.name === name);
}

export async function searchForUser(userId: string, query: string): Promise<IndexedTool[]> {
  const tools = await ensureIndex(userId);
  const q = query.toLowerCase();
  return tools.filter(
    (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
  );
}
