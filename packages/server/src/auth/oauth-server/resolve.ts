import { verifyApiKey } from "../users";
import { verifySession } from "../session";
import { verifyAccessToken } from "./tokens";
import { noteAuth } from "../../audit/context";

// Resolve the /mcp caller: API key header, then OAuth Bearer, then session JWT.
// The credential that succeeded is noted for the request's audit events.
export async function resolveMcpUser(headers: {
  authorization?: string;
  "x-workbench-api-key"?: string;
}): Promise<string | null> {
  const apiKey = headers["x-workbench-api-key"];
  if (apiKey) {
    const u = await verifyApiKey(apiKey);
    if (u) {
      noteAuth("api_key");
      return u;
    }
  }
  const auth = headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    try {
      const claims = await verifyAccessToken(token); // OAuth access token
      noteAuth("oauth", claims.clientId);
      return claims.userId;
    } catch {
      try {
        const { userId } = await verifySession(token); // portal session JWT
        noteAuth("session");
        return userId;
      } catch {
        return null;
      }
    }
  }
  return null;
}
