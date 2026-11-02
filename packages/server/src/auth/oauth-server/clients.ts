import crypto from "crypto";
import { db } from "../../db";

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
}

// Dynamic client registration (RFC 7591) is open to anyone, so the redirect
// URI is the only thing standing between "anyone can register a client" and
// "anyone can pick where an authorization code gets delivered". Per OAuth 2.1
// §4.1.1, native/public clients must use https or a loopback http redirect;
// reject everything else outright (javascript:/data:, relative URIs, open
// wildcards, and any non-loopback http).
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false; // rejects relative URIs and unparsable values outright
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return true;
  return false;
}

export async function registerClient(input: { client_name?: string; redirect_uris: string[] }): Promise<OAuthClient> {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new Error("redirect_uris must contain at least one URI");
  }
  if (!input.redirect_uris.every(isAllowedRedirectUri)) {
    throw new Error("redirect_uris must be https, or http on loopback");
  }
  const client_id = crypto.randomBytes(16).toString("hex");
  await db.run(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)",
    [client_id, input.client_name ?? null, JSON.stringify(input.redirect_uris)]
  );
  return { client_id, client_name: input.client_name, redirect_uris: input.redirect_uris };
}

export async function getClient(clientId: string): Promise<OAuthClient | undefined> {
  const row = await db.get<{ client_id: string; client_name: string | null; redirect_uris: string }>(
    "SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?",
    [clientId]
  );
  if (!row) return undefined;
  return {
    client_id: row.client_id,
    client_name: row.client_name ?? undefined,
    redirect_uris: JSON.parse(row.redirect_uris),
  };
}
