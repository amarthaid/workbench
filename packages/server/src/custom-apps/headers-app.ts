import { randomUUID } from "node:crypto";
import { normalizeBaseUrl } from "./ssrf";
import { isOwnResource } from "./loop-guard";
import { discoverTools, evictSession } from "./client";
import { validateHeaders, headersToRecord } from "./headers";
import {
  createCustomApp, getCustomApp, getCustomAppByName, isHeadersApp,
  setCustomAppHeaders, type CustomApp,
} from "./store";

export class HeadersAppError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type Verify = (userId: string, baseUrl: string, headers: Record<string, string>) => Promise<void>;

const defaultVerify: Verify = async (userId, baseUrl, headers) => {
  await discoverTools(userId, baseUrl, headers);
};

/** Status-only: upstream error text can echo request details, so never forward it. */
export function verifyFailureMessage(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "number" && code >= 400 && code < 600) return `Server rejected the headers (HTTP ${code})`;
  return "Could not connect to the server with these headers";
}

export async function createHeadersApp(
  args: { userId: string; name: string; baseUrl: string; headers: unknown },
  verify: Verify = defaultVerify
): Promise<CustomApp> {
  const name = args.name.trim();
  if (!name || !args.baseUrl.trim()) throw new HeadersAppError(400, "name and baseUrl are required");
  if (name.length > 64) throw new HeadersAppError(400, "name too long");
  if (await getCustomAppByName(args.userId, name)) throw new HeadersAppError(409, `An app named "${name}" already exists`);

  const baseUrl = normalizeBaseUrl(args.baseUrl.trim());
  if (!baseUrl) throw new HeadersAppError(400, `Invalid or blocked URL: ${args.baseUrl.trim().slice(0, 200)}`);
  if (isOwnResource(baseUrl)) throw new HeadersAppError(400, "This URL points back at this workbench");

  const v = validateHeaders(args.headers);
  if (!v.ok) throw new HeadersAppError(400, v.error);

  try {
    await verify(args.userId, baseUrl, headersToRecord(v.headers));
  } catch (e) {
    evictSession(args.userId, baseUrl);
    throw new HeadersAppError(400, verifyFailureMessage(e));
  }
  return createCustomApp({
    id: randomUUID(), userId: args.userId, name, baseUrl,
    metadata: { authType: "headers" }, headers: v.headers,
  });
}

export async function updateHeadersApp(
  args: { userId: string; id: string; headers: unknown },
  verify: Verify = defaultVerify
): Promise<CustomApp> {
  const app = await getCustomApp(args.userId, args.id);
  if (!app) throw new HeadersAppError(404, "Custom app not found");
  if (!isHeadersApp(app)) throw new HeadersAppError(400, "This app uses OAuth, not headers");

  const v = validateHeaders(args.headers, app.headers);
  if (!v.ok) throw new HeadersAppError(400, v.error);
  try {
    await verify(args.userId, app.baseUrl, headersToRecord(v.headers));
  } catch (e) {
    throw new HeadersAppError(400, verifyFailureMessage(e));
  }
  const saved = await setCustomAppHeaders(args.userId, args.id, v.headers);
  return saved!;
}
