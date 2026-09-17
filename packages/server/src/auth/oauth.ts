import crypto from "crypto";
import { db } from "../db";

// PKCE (RFC 7636): the verifier lives server-side in pending_auth alongside
// the state, since the whole flow is server-brokered (no SPA in the loop).
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function codeChallengeS256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export async function createAuthState(
  userId: string,
  integration: string,
  codeVerifier?: string,
  config?: string,
  nonce?: string
): Promise<string> {
  const state = crypto.randomBytes(32).toString("hex");
  await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at, code_verifier, config, nonce) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [state, userId, integration, Math.floor(Date.now() / 1000) + 600, codeVerifier ?? null, config ?? null, nonce ?? null]
  );
  await db.run("DELETE FROM pending_auth WHERE expires_at < ?", [Math.floor(Date.now() / 1000)]);
  return state;
}

// Same literal as OTL_SENTINEL in ../vault/otl.ts; a literal rather than an import keeps this module free of the vault. tests/vault-otl.test.ts enforces the behaviour.
const VAULT_OTL_SENTINEL = "__vault_otl__";

export async function verifyAuthState(
  state: string
): Promise<{ userId: string; integration: string; codeVerifier?: string; config?: string; nonce?: string } | null> {
  const row = await db.get<{
    user_id: string;
    integration: string;
    code_verifier: string | null;
    config: string | null;
    nonce: string | null;
  }>(
    // pending_auth is the shared short-TTL handshake table. A vault one-time
    // link row (`__vault_otl__`) carries encrypted secret material, and its
    // token has the same 32-hex shape as an OAuth state: never spend one here.
    "SELECT user_id, integration, code_verifier, config, nonce FROM pending_auth WHERE state = ? AND integration != ? AND expires_at > ?",
    [state, VAULT_OTL_SENTINEL, Math.floor(Date.now() / 1000)]
  );

  if (!row) return null;

  await db.run("DELETE FROM pending_auth WHERE state = ? AND integration != ?", [state, VAULT_OTL_SENTINEL]);
  return {
    userId: row.user_id,
    integration: row.integration,
    codeVerifier: row.code_verifier ?? undefined,
    config: row.config ?? undefined,
    nonce: row.nonce ?? undefined,
  };
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  // Slack-specific: ok/error envelope, user token nested under authed_user
  ok?: boolean;
  error?: string;
  authed_user?: {
    id?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
}

export async function exchangeCode(
  tokenUrl: string,
  clientId: string,
  clientSecret: string | undefined,
  code: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
  });
  if (clientSecret) body.set("client_secret", clientSecret);
  if (codeVerifier) body.set("code_verifier", codeVerifier);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return response.json();
}
