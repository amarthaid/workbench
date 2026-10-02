import { SignJWT, jwtVerify } from "jose";
import { config } from "../config";
import { isUserDisabled } from "./user-status";

const secret = new TextEncoder().encode(config.SESSION_SECRET);
const AUDIENCE = "a-workbench-curl";
const ISSUER = "a-workbench";

export interface CurlSessionPayload {
  userId: string;
  integrations: string[];
}

export async function signCurlToken(
  userId: string,
  integrations: string[],
  expiresInSeconds = 900
): Promise<string> {
  return new SignJWT({ sub: userId, ints: integrations })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .setAudience(AUDIENCE)
    .setIssuer(ISSUER)
    .sign(secret);
}

export async function verifyCurlToken(token: string): Promise<CurlSessionPayload> {
  const { payload } = await jwtVerify(token, secret, {
    audience: AUDIENCE,
    issuer: ISSUER,
  });
  if (
    typeof payload.sub !== "string" ||
    !Array.isArray(payload.ints) ||
    !(payload.ints as unknown[]).every((i) => typeof i === "string")
  ) {
    throw new Error("Invalid curl session token payload");
  }
  if (await isUserDisabled(payload.sub)) throw new Error("User disabled");
  return { userId: payload.sub, integrations: payload.ints as string[] };
}
