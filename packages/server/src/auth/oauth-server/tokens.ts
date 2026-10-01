import { SignJWT, jwtVerify } from "jose";
import { config } from "../../config";
import { isUserDisabled } from "../user-status";

const secret = new TextEncoder().encode(config.SESSION_SECRET);
const ISSUER = config.SERVER_PUBLIC_URL;
const RESOURCE = `${config.SERVER_PUBLIC_URL}/mcp`;

export interface AccessTokenClaims {
  userId: string;
  scope: string;
  clientId: string;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ scope: claims.scope, client_id: claims.clientId, token_type: "oauth" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${config.OAUTH_ACCESS_TOKEN_TTL_SECONDS}s`)
    .setAudience(RESOURCE)
    .setIssuer(ISSUER)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, secret, {
    clockTolerance: 5,
    audience: RESOURCE,
    issuer: ISSUER,
  });
  if (
    payload.token_type !== "oauth" ||
    typeof payload.sub !== "string" ||
    typeof payload.scope !== "string" ||
    typeof payload.client_id !== "string"
  ) {
    throw new Error("Not an OAuth access token");
  }
  if (await isUserDisabled(payload.sub)) throw new Error("User disabled");
  return { userId: payload.sub, scope: payload.scope, clientId: payload.client_id };
}
