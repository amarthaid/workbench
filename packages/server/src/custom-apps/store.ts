import { randomUUID } from "node:crypto";
import { db } from "../db";
import { encrypt, decrypt } from "../auth/encryption";

/** Discovered OAuth server + protected-resource metadata for a app. */
export interface CustomAppMetadata {
  /** /.well-known/oauth-authorization-server */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  /** /.well-known/oauth-protected-resource — the resource URL the token grants. */
  resourceUrl?: string;
  scopes?: string[];
  /** Client auth method declared by the registration response. */
  authMethod?: "client_secret_basic" | "client_secret_post" | "none";
}

export interface CustomApp {
  id: string;
  userId: string;
  name: string;
  baseUrl: string;
  metadata: CustomAppMetadata;
  clientId?: string;
  /** Decrypted client secret — only held in memory, never serialized to logs. */
  clientSecret?: string;
  createdAt: number;
  updatedAt: number;
}

/** `connections.integration` key for a custom app's OAuth token row. */
export function integrationKey(id: string): string {
  return `custom:${id}`;
}

export function idFromIntegrationKey(key: string): string | null {
  return key.startsWith("custom:") ? key.slice("custom:".length) : null;
}

interface Row {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  metadata: string;
  client_id: string | null;
  client_secret_enc: Buffer | null;
  created_at: number;
  updated_at: number;
}

function toCustomApp(row: Row): CustomApp {
  let metadata: CustomAppMetadata = {};
  try {
    metadata = JSON.parse(row.metadata) as CustomAppMetadata;
  } catch {
    /* corrupt metadata degrades to empty */
  }
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    baseUrl: row.base_url,
    metadata,
    clientId: row.client_id ?? undefined,
    clientSecret: row.client_secret_enc ? decrypt(row.client_secret_enc) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createCustomApp(args: {
  /** Pre-generated id (the OAuth redirect URI embeds it before insert). */
  id?: string;
  userId: string;
  name: string;
  baseUrl: string;
  metadata: CustomAppMetadata;
  clientId?: string;
  clientSecret?: string;
}): Promise<CustomApp> {
  const id = args.id ?? randomUUID();
  await db.run(
    `INSERT INTO custom_apps (id, user_id, name, base_url, metadata, client_id, client_secret_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.userId,
      args.name,
      args.baseUrl,
      JSON.stringify(args.metadata),
      args.clientId ?? null,
      args.clientSecret ? encrypt(args.clientSecret) : null,
    ]
  );
  return (await getCustomApp(args.userId, id))!;
}

export async function getCustomApp(userId: string, id: string): Promise<CustomApp | null> {
  const row = await db.get<Row>("SELECT * FROM custom_apps WHERE id = ? AND user_id = ?", [id, userId]);
  return row ? toCustomApp(row) : null;
}

/** Lookup without a user filter — only for the OAuth callback, where the state
 * binding (pending_auth.integration) is what authorizes, not the id. */
export async function getCustomAppById(id: string): Promise<CustomApp | null> {
  const row = await db.get<Row>("SELECT * FROM custom_apps WHERE id = ?", [id]);
  return row ? toCustomApp(row) : null;
}

/** Name is unique per user (the tool namespace is built from it). */
export async function getCustomAppByName(userId: string, name: string): Promise<CustomApp | null> {
  const row = await db.get<Row>("SELECT * FROM custom_apps WHERE user_id = ? AND name = ?", [userId, name]);
  return row ? toCustomApp(row) : null;
}

export async function listCustomApps(userId: string): Promise<CustomApp[]> {
  const rows = await db.all<Row>(
    "SELECT * FROM custom_apps WHERE user_id = ? ORDER BY created_at ASC",
    [userId]
  );
  return rows.map(toCustomApp);
}

export async function deleteCustomApp(userId: string, id: string): Promise<void> {
  await db.run("DELETE FROM custom_apps WHERE id = ? AND user_id = ?", [id, userId]);
  // Drop the OAuth token row too — a app's token is meaningless without it.
  await db.run("DELETE FROM connections WHERE user_id = ? AND integration = ?", [userId, integrationKey(id)]);
}
