import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import type { IndexEntry } from "./parse";

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_REDIRECTS = 2;

const entrySchema = z.object({
  id: z.string(),
  title: z.string(),
  name: z.string().optional(),
  importPath: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  componentPath: z.string().optional(),
});

const indexSchema = z.object({
  entries: z.record(entrySchema),
});

type AuthType = "none" | "bearer" | "basic" | "cookie";

interface Session {
  userId: string;
  baseUrl: string;
  origin: string;
  headers: Record<string, string>;
  cacheKey: string;
}

const cache = new Map<string, { expires: number; value: unknown }>();

export function clearStorybooksCache(): void {
  cache.clear();
}

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown): void {
  if (cache.size > 200) cache.clear();
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const loopback = h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]" || /^127\./.test(h);
  if (loopback) return process.env.NODE_ENV !== "development";
  if (h === "[::1]" || h.startsWith("[fc") || h.startsWith("[fd") || h.startsWith("[fe8") || h.startsWith("[fe9") || h.startsWith("[fea") || h.startsWith("[feb")) {
    return true;
  }
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) return isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]));
  const mapped = h.match(/^\[::ffff:(?:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))\]$/);
  if (mapped) {
    if (mapped[1] !== undefined) return isPrivateIpv4(Number(mapped[1]), Number(mapped[2]));
    const hi = parseInt(mapped[5] ?? "0", 16);
    return isPrivateIpv4(hi >> 8, hi & 0xff);
  }
  return false;
}

function isBlockedAddress(addr: string): boolean {
  return isBlockedHost(addr.includes(":") ? `[${addr}]` : addr);
}

export function normalizeStorybookBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`Storybook URL is not valid: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Storybook URL must be http or https");
  }
  if (u.username || u.password) throw new Error("Storybook URL must not contain credentials");
  if (isBlockedHost(u.hostname)) throw new Error(`Storybook host ${u.hostname} is not allowed`);
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/$/, "");
}

export function storybookUrl(baseUrl: string, path: string): string {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const rel = path.replace(/^\/+/, "");
  const queryAt = rel.indexOf("?");
  const pathname = queryAt === -1 ? rel : rel.slice(0, queryAt);
  const search = queryAt === -1 ? "" : rel.slice(queryAt);
  if (!pathname && !search) throw new Error("Storybook path is empty");
  if (pathname.includes("..") || pathname.includes("\\") || pathname.startsWith("//")) {
    throw new Error(`Storybook path is not allowed: ${path}`);
  }
  const target = new URL(`${pathname}${search}`, root);
  const base = new URL(root);
  if (target.origin !== base.origin) throw new Error("Storybook path escapes the configured origin");
  if (!target.pathname.startsWith(base.pathname)) {
    throw new Error("Storybook path escapes the configured base path");
  }
  return target.toString();
}

function authHeaders(authType: AuthType, credential: string, username?: string): Record<string, string> {
  switch (authType) {
    case "none":
      return {};
    case "bearer": {
      const value = /^bearer\s+/i.test(credential) ? credential : `Bearer ${credential}`;
      return { Authorization: value };
    }
    case "basic": {
      const user = username ?? "";
      if (!user) throw new Error("Basic auth requires a username on the Storybooks connection");
      return { Authorization: `Basic ${Buffer.from(`${user}:${credential}`).toString("base64")}` };
    }
    case "cookie":
      return { Cookie: credential };
    default: {
      const neverType: never = authType;
      throw new Error(`Unknown auth type ${neverType}`);
    }
  }
}

function parseAuthType(raw: unknown): AuthType {
  const value = String(raw ?? "none");
  if (value === "none" || value === "bearer" || value === "basic" || value === "cookie") return value;
  throw new Error("authType must be one of: none, bearer, basic, cookie");
}

async function assertResolvesPublic(hostname: string): Promise<{ address: string }[] | null> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let resolved: { address: string }[] | null = null;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    return null;
  }
  if (resolved.some((a) => isBlockedAddress(a.address))) {
    throw new Error(`Refusing to fetch ${hostname}: it resolves to a private address`);
  }
  return resolved;
}

async function readLimited(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error(`Storybook response exceeded ${MAX_BYTES} bytes`);
  return new TextDecoder().decode(buf);
}

async function requestText(session: Session, path: string, redirects = 0): Promise<string> {
  const url = storybookUrl(session.baseUrl, path);
  const target = new URL(url);
  const resolved = await assertResolvesPublic(target.hostname);
  let fetchUrl = url;
  const headers = new Headers(session.headers);
  headers.set("Accept", "application/json, text/html, text/css, text/plain, */*");
  if (target.protocol === "http:" && resolved && resolved.length) {
    const pinned = new URL(url);
    pinned.hostname = resolved[0]!.address;
    headers.set("Host", target.host);
    fetchUrl = pinned.toString();
  }

  const res = await fetch(fetchUrl, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location || redirects >= MAX_REDIRECTS) {
      throw new Error(`Refusing to follow a redirect from ${path}`);
    }
    const next = new URL(location, url);
    if (next.origin !== session.origin) {
      throw new Error(`Refusing a cross-origin redirect from Storybook to ${next.origin}`);
    }
    const basePath = new URL(session.baseUrl.endsWith("/") ? session.baseUrl : `${session.baseUrl}/`).pathname;
    const rel = next.pathname.startsWith(basePath) ? next.pathname.slice(basePath.length) : next.pathname;
    return requestText(session, `${rel}${next.search}`, redirects + 1);
  }

  const text = await readLimited(res);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Storybook refused the request (${res.status}). Check the connection auth type and credential.`);
  }
  if (!res.ok) {
    throw new Error(`Storybook request failed for ${path}: HTTP ${res.status}`);
  }
  return text;
}

async function openSession(ctx: any, baseUrlOverride?: string, anonymous = false): Promise<Session> {
  const cfg = (ctx.getConfig?.() ?? {}) as Record<string, unknown>;
  const baseUrl = normalizeStorybookBase(baseUrlOverride ?? String(cfg.baseUrl ?? ""));
  const authType = anonymous ? "none" : parseAuthType(cfg.authType);
  let credential = "";
  if (authType !== "none") {
    try {
      credential = String(await ctx.getToken());
    } catch {
      throw new Error("Storybooks is not connected. Connect it in the portal first.");
    }
    if (!credential || credential === "none") {
      throw new Error(`A credential is required when auth type is ${authType}`);
    }
  }
  const headers = authHeaders(authType, credential, typeof cfg.username === "string" ? cfg.username : undefined);
  const secret = createHash("sha256").update(credential).digest("hex").slice(0, 16);
  return {
    userId: String(ctx.userId ?? ""),
    baseUrl,
    origin: new URL(baseUrl).origin,
    headers,
    cacheKey: `${ctx.userId}|${baseUrl}|${authType}|${secret}`,
  };
}

function toEntries(payload: unknown): IndexEntry[] {
  const parsed = indexSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Storybook index.json is not a Storybook 8 index");
  return Object.values(parsed.data.entries)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      name: entry.name ?? "",
      importPath: entry.importPath,
      type: entry.type ?? "story",
      tags: entry.tags ?? [],
      componentPath: entry.componentPath,
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
}

async function loadIndex(session: Session): Promise<IndexEntry[]> {
  const key = `${session.cacheKey}:index`;
  const cached = cacheGet<IndexEntry[]>(key);
  if (cached) return cached;
  const text = await requestText(session, "index.json");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML")) {
    throw new Error("Storybook returned HTML instead of index.json. The deployment may require bearer, basic, or cookie auth.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Storybook index.json was not JSON");
  }
  const entries = toEntries(json);
  cacheSet(key, entries);
  return entries;
}

export async function connectedEntries(ctx: any): Promise<{ session: Session; entries: IndexEntry[] }> {
  const session = await openSession(ctx);
  return { session, entries: await loadIndex(session) };
}

export async function publicEntries(url: string): Promise<IndexEntry[]> {
  const session = await openSession({ userId: "public", getConfig: () => ({ baseUrl: url, authType: "none" }) }, url, true);
  return loadIndex(session);
}

export async function fetchChunk(session: Session, importPath: string | undefined): Promise<string | undefined> {
  if (!importPath) return undefined;
  const mapKey = `${session.cacheKey}:import-map`;
  let map = cacheGet<Record<string, string>>(mapKey);
  if (!map) {
    let html = "";
    try {
      html = await requestText(session, "iframe.html");
    } catch {
      return undefined;
    }
    const script = html.match(/src="(?:\.\/|\/)?assets\/(iframe-[A-Za-z0-9._-]+\.js)"/);
    const built = new Map<string, string>();
    if (script?.[1]) {
      try {
        const bundle = await requestText(session, `assets/${script[1]}`);
        const pattern = /"(\.\/[^"]+)":async\(\)=>[^.]+\(\(\)=>import\("\.\/([A-Za-z0-9._-]+\.js)"\)/g;
        for (const match of bundle.matchAll(pattern)) {
          if (match[1] && match[2]) built.set(match[1], `assets/${match[2]}`);
        }
      } catch {
        // Docs text is optional when the iframe bundle cannot be read.
      }
    }
    map = Object.fromEntries(built);
    cacheSet(mapKey, map);
  }
  const asset = map[importPath];
  if (!asset) return undefined;
  const chunkKey = `${session.cacheKey}:chunk:${asset}`;
  const cached = cacheGet<string>(chunkKey);
  if (cached) return cached;
  const source = await requestText(session, asset);
  cacheSet(chunkKey, source);
  return source;
}

export async function fetchText(session: Session, path: string): Promise<string> {
  return requestText(session, path);
}

export function findEntry(entries: IndexEntry[], storyId: string): IndexEntry {
  const id = storyId.trim();
  const alt = id.replace(/\//g, "-");
  const hit = entries.find((entry) => entry.id === id || entry.id === alt);
  if (!hit) throw new Error(`Story not found: ${storyId}`);
  return hit;
}

export type { Session };
