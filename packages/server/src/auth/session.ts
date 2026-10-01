import { SignJWT, jwtVerify } from "jose";
import { config } from "../config";
import { isUserDisabled } from "./user-status";

const secret = new TextEncoder().encode(config.SESSION_SECRET);

export interface SessionPayload {
  userId: string;
  email: string;
}

export async function signSession(payload: SessionPayload, expiresInHours = 24): Promise<string> {
  return new SignJWT({ sub: payload.userId, email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiresInHours}h`)
    .setAudience("a-workbench")
    .setIssuer("a-workbench")
    .sign(secret);
}

export async function verifySession(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, secret, {
    clockTolerance: 5,
    audience: "a-workbench",
    issuer: "a-workbench",
  });
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("Invalid session payload");
  }
  // Checked here, not at each call site: every portal-session consumer
  // (authenticate, /mcp, the CDP bridge, vault, OAuth) goes through this function.
  if (await isUserDisabled(payload.sub)) throw new Error("User disabled");
  return { userId: payload.sub, email: payload.email };
}
