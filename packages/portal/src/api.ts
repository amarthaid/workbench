const API_URL = import.meta.env.VITE_API_URL || "";
// The server's own absolute origin, ONLY for the one case that needs a real
// cross-origin browser navigation rather than a fetch (see AuthorizeChoose's
// resume form) — same "" = same-origin default as API_URL, but this value
// must come from build-time config alone, never from a URL query param: it
// becomes a POST target for a live session token, and attacker-controlled
// input must never decide where a credential gets sent.
export const SERVER_URL = import.meta.env.VITE_SERVER_URL || "";

function getHeaders(): HeadersInit {
  const token = localStorage.getItem("awb_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// Auth header WITHOUT Content-Type — for bodyless requests. Fastify rejects a
// POST/DELETE that declares application/json but sends no body
// (FST_ERR_CTP_EMPTY_JSON_BODY).
function authHeaders(): HeadersInit {
  const token = localStorage.getItem("awb_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Browser-session routing key ──────────────────────────────────────────
// A per-user key the server mints on demand. It is NOT a credential — the
// bearer still authorizes every request and the server always resolves the
// session from that bearer, never from this key. It exists so that in a
// multi-replica deployment an L7 proxy can hash it and land every request
// that touches this user's Chromium on the one replica that owns it. See
// docs/findings/2026-09-10-browser-session-pod-affinity.md.
//
// Kept in memory only: it is cheap to re-mint, and persisting it would strand
// a stale key across a change of user in the same browser.
const BROWSER_SESSION_HEADER = "X-Browser-Session";
let browserSessionKey: string | null = null;

export function setBrowserSessionKey(key: string): void {
  browserSessionKey = key;
}

export function clearBrowserSessionKey(): void {
  browserSessionKey = null;
}

// Mint the key. Deliberately unrouted — the caller has no key to route on yet
// — which is why the endpoint starts no browser and holds no state.
export async function ensureBrowserSessionKey(): Promise<string | null> {
  if (browserSessionKey) return browserSessionKey;
  const res = await fetch(`${API_URL}/api/browser-session/cdp/attach`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) return null;
  const { sessionKey } = (await res.json()) as { sessionKey?: string };
  browserSessionKey = sessionKey ?? null;
  return browserSessionKey;
}

// Spread into any request that reaches a browser session: cookie capture, the
// live view, reset, and the connect flows that warm one.
export function browserSessionHeaders(): Record<string, string> {
  return browserSessionKey ? { [BROWSER_SESSION_HEADER]: browserSessionKey } : {};
}

export async function fetchIntegrations() {
  const res = await fetch(`${API_URL}/api/integrations`, { headers: getHeaders() });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json();
}

export interface InstanceConfig {
  label: string;
  placeholder?: string;
  default: string;
}

export interface ApiKeyField {
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  secret?: boolean;
  options?: string[];
  optional?: boolean;
  multiline?: boolean;
}

export interface IntegrationSummary {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  categories?: string[];
  logo?: string;
  toolCount: number;
  configured?: boolean;
  authType?: string;
  // True for a per-user custom app (external MCP server).
  custom?: boolean;
  // Present when the integration supports a self-hosted instance URL prompt.
  instance?: InstanceConfig;
  // Present for apikey integrations: the connect-time form field spec.
  apikeyFields?: ApiKeyField[];
}

export interface IntegrationDetail extends IntegrationSummary {
  authType: string;
  tools: { name: string; description: string }[];
}

export async function fetchIntegration(name: string): Promise<IntegrationDetail> {
  const res = await fetch(`${API_URL}/api/integrations/${name}`, { headers: getHeaders() });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error("Failed to fetch integration");
  return res.json();
}

export async function fetchProviders(): Promise<{ providers: string[] }> {
  const res = await fetch(`${API_URL}/api/auth/providers`);
  if (!res.ok) return { providers: [] };
  return res.json();
}

// `ticket` carries an in-flight agent /authorize request through SSO so its
// callback knows which pending flow to resume, instead of a normal portal login.
export async function fetchAuthUrl(ticket?: string): Promise<{ url: string }> {
  const qs = ticket ? `?ticket=${encodeURIComponent(ticket)}` : "";
  const res = await fetch(`${API_URL}/api/auth/google${qs}`);
  if (!res.ok) throw new Error("SSO not configured");
  return res.json();
}

export async function fetchKeycloakAuthUrl(ticket?: string): Promise<{ url: string }> {
  const qs = ticket ? `?ticket=${encodeURIComponent(ticket)}` : "";
  const res = await fetch(`${API_URL}/api/auth/keycloak${qs}`);
  if (!res.ok) throw new Error("Keycloak SSO not configured");
  return res.json();
}

export async function createCustomApp(name: string, baseUrl: string): Promise<{ app: { id: string; name: string; baseUrl: string } }> {
  const res = await fetch(`${API_URL}/api/custom-apps`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ name, baseUrl }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || "Failed to register custom app");
  }
  return res.json();
}

export async function removeCustomApp(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/api/custom-apps/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to delete custom app");
  return res.json();
}

export async function fetchConnections() {
  const res = await fetch(`${API_URL}/api/connections`, { headers: getHeaders() });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error("Failed to fetch connections");
  return res.json();
}

export async function disconnectIntegration(integration: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/api/connections/${integration}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || "Failed to disconnect");
  }
  return res.json();
}

export interface ConnectedAgent {
  client_id: string;
  client_name?: string;
  scopes: string[];
  connected_since: number;
  expires_at: number;
}

export async function fetchAgents(): Promise<{ agents: ConnectedAgent[] }> {
  const res = await fetch(`${API_URL}/api/agents`, { headers: getHeaders() });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error("Failed to fetch agents");
  return res.json();
}

export async function revokeAgent(clientId: string): Promise<{ revoked: number }> {
  const res = await fetch(`${API_URL}/api/agents/${encodeURIComponent(clientId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || "Failed to revoke agent");
  }
  return res.json();
}

export type StartAuthResult =
  | {
      type: "cookie";
      status: "login_required";
      cdpProxyUrl: string;
      loginUrl: string;
    }
  | { type: "oauth2"; url: string }
  | { type: "apikey"; fields: ApiKeyField[] }
  | { type: "manual"; state: string };

export async function startIntegrationAuth(
  integration: string,
  instanceUrl?: string
): Promise<StartAuthResult> {
  const qs = instanceUrl ? `?instanceUrl=${encodeURIComponent(instanceUrl)}` : "";
  // A cookie integration warms the browser inside this very call, so mint the
  // routing key first — the auth type isn't known until the response, and one
  // extra POST on a connect click is cheaper than a session on a stray replica.
  await ensureBrowserSessionKey();
  const res = await fetch(`${API_URL}/api/auth/${integration}${qs}`, {
    headers: { ...getHeaders(), ...browserSessionHeaders() },
  });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || "Failed to start integration auth");
  }
  const data = await res.json();
  if (data.type) return data as StartAuthResult;
  if (data.state) return { type: "manual", state: data.state };
  throw new Error("Unknown auth response");
}

/** @deprecated use startIntegrationAuth */
export const startCookieAuth = startIntegrationAuth;

// Submit the apikey connect form: the user-entered field values (credential +
// any config such as region) are stored server-side as the connection.
export async function submitApiKey(
  integration: string,
  values: Record<string, string>
): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/api/auth/apikey/${integration}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || "Failed to connect");
  }
  return res.json();
}

export async function captureCookies(integration: string): Promise<{ success: boolean; cookieCount: number }> {
  const res = await fetch(`${API_URL}/api/auth/cookie/${integration}/capture`, {
    method: "POST",
    headers: { ...authHeaders(), ...browserSessionHeaders() },
  });
  if (!res.ok) throw new Error("Failed to capture cookies");
  return res.json();
}

export async function cancelCookieAuth(integration: string): Promise<void> {
  await fetch(`${API_URL}/api/auth/cookie/${integration}/cancel`, {
    method: "POST",
    headers: { ...authHeaders(), ...browserSessionHeaders() },
  });
}

export type RedeemResult =
  | { type: "cookie"; integration: string; loginUrl: string; cdpProxyUrl: string }
  | { type: "oauth2"; url: string }
  | { type: "browser"; cdpProxyUrl: string };

export type ConnectLinkCode =
  | "AUTH_REQUIRED" | "LINK_INVALID" | "LINK_CONSUMED" | "ACCOUNT_MISMATCH" | "UNKNOWN";

export class ConnectLinkError extends Error {
  code: ConnectLinkCode;
  integration?: string;
  constructor(code: ConnectLinkCode, integration?: string) {
    super(code);
    this.code = code;
    this.integration = integration;
  }
}

async function connectLinkError(res: Response): Promise<ConnectLinkError> {
  const body = await res.json().catch(() => ({}));
  const known: ConnectLinkCode[] = ["AUTH_REQUIRED", "LINK_INVALID", "LINK_CONSUMED", "ACCOUNT_MISMATCH"];
  const code = known.includes(body.error) ? (body.error as ConnectLinkCode) : "UNKNOWN";
  return new ConnectLinkError(code, body.integration);
}

export async function redeemConnectLink(token: string): Promise<RedeemResult> {
  // Redeeming a cookie or browser link warms the browser inside this call.
  await ensureBrowserSessionKey();
  const res = await fetch(`${API_URL}/api/connect/redeem`, {
    method: "POST",
    headers: { ...getHeaders(), ...browserSessionHeaders() },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw await connectLinkError(res);
  return res.json();
}

export async function connectCapture(token: string) {
  const res = await fetch(`${API_URL}/api/connect/capture`, {
    method: "POST",
    headers: { ...getHeaders(), ...browserSessionHeaders() },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw await connectLinkError(res);
  return res.json() as Promise<{ success: boolean; cookieCount: number }>;
}

// Export a cookie-auth session bundle (to move a working capture to another
// workbench whose egress IP the provider would block).
export async function exportSession(integration: string): Promise<{ integration: string; session: unknown }> {
  const res = await fetch(`${API_URL}/api/integrations/${integration}/session/export`, { headers: getHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Export failed");
  return res.json();
}

// Import a cookie-auth session bundle captured elsewhere.
export async function importSession(integration: string, session: unknown): Promise<{ success: boolean; cookieCount: number }> {
  const res = await fetch(`${API_URL}/api/integrations/${integration}/session/import`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ session }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Import failed");
  return res.json();
}

export async function getApiKeyStatus(): Promise<{ hasKey: boolean }> {
  const res = await fetch(`${API_URL}/api/keys`, { headers: getHeaders() });
  if (!res.ok) throw new Error("Failed to read key status");
  return res.json();
}

export async function mintApiKey(): Promise<{ apiKey: string }> {
  const res = await fetch(`${API_URL}/api/keys`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to mint key");
  return res.json();
}

export async function revealApiKey(): Promise<{ apiKey: string }> {
  const res = await fetch(`${API_URL}/api/keys/reveal`, { headers: getHeaders() });
  if (!res.ok) throw new Error("Failed to reveal key");
  return res.json();
}

export async function revokeApiKey(): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/api/keys`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to revoke key");
  return res.json();
}

export async function resetBrowserSession(): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/api/browser-session/reset`, {
    method: "POST",
    headers: { ...authHeaders(), ...browserSessionHeaders() },
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || "Reset failed";
    throw new Error(msg);
  }
  return res.json();
}

// User-initiated browser live view. Optional url navigates the warm session
// there first. Returns a short-lived /browser?t= link to open in a new tab.
export async function openBrowserLiveUrl(url?: string): Promise<{ url: string }> {
  const res = await fetch(`${API_URL}/api/browser-session/live-url`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(url ? { url } : {}),
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || "Failed to open live view";
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchMe() {
  const res = await fetch(`${API_URL}/api/auth/me`, { headers: getHeaders() });
  if (!res.ok) return null;
  return res.json();
}

export async function logout() {
  await fetch(`${API_URL}/api/auth/logout`, {
    method: "POST",
    headers: getHeaders(),
  });
  localStorage.removeItem("awb_token");
  // The key is derived from the user — never carry one across a sign-out.
  clearBrowserSessionKey();
}

export interface ActivityEvent {
  id: number;
  integration: string | null;
  tool: string | null;
  action: string;
  success: boolean;
  error: string | null;
  duration_ms: number | null;
  /** Unix seconds. */
  created_at: number;
}

export interface ActivityPage {
  /** False when this deployment routes audit events somewhere other than the database. */
  stored: boolean;
  events: ActivityEvent[];
  next_cursor: string | null;
}

// Shown wherever a page renders `stored: false` — describes the same API
// state, so it lives beside the type rather than in whichever page rendered
// it first.
export const UNSTORED_MESSAGE =
  "This deployment sends audit events somewhere other than its database, so there is nothing to show here. Set AUDIT_LOG_DEST=sqlite to record them.";

export interface Stats {
  stored: boolean;
  window_days: number;
  tool_calls: number;
  success_rate: number | null;
  most_used_integration: string | null;
}

export async function fetchActivity(opts: {
  limit?: number;
  cursor?: string;
  integration?: string;
  status?: "success" | "error";
} = {}): Promise<ActivityPage> {
  const qs = new URLSearchParams();
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.integration) qs.set("integration", opts.integration);
  if (opts.status) qs.set("status", opts.status);
  const suffix = qs.toString() ? `?${qs}` : "";

  const res = await fetch(`${API_URL}/api/activity${suffix}`, { headers: getHeaders() });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error("Failed to fetch activity");
  return res.json();
}

export async function fetchStats(): Promise<Stats> {
  const res = await fetch(`${API_URL}/api/stats`, { headers: getHeaders() });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

// ─── Agent file workspace ────────────────────────────────────────────────
// The per-user scratch area: browser downloads land here, uploads are read
// from here. Retention is age only — a file is deleted 24h after it is
// written, whether or not anything is using it, and reading does not extend
// that. The UI surfaces the countdown because that is the part people are
// surprised by.

export interface WorkspaceFile {
  name: string;
  bytes: number;
  mtime: string;
  expiresAt: string;
}

export interface WorkspaceListing {
  files: WorkspaceFile[];
  usedBytes: number;
  quotaBytes: number;
  maxFileBytes: number;
  ttlHours: number;
}

export async function fetchWorkspaceFiles(): Promise<WorkspaceListing> {
  const res = await fetch(`${API_URL}/api/files`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load files");
  return res.json();
}

/**
 * Download a workspace file in the browser.
 *
 * Not an <a href>: the portal authenticates with a bearer from its own token
 * store, and a top-level navigation cannot carry an Authorization header —
 * the same constraint as docs/findings/2026-09-04-oauth-authorize-cross-origin-cookie.md.
 * So the bytes come back through fetch and are handed to the browser as a blob.
 *
 * The portal deliberately does NOT mint itself a presigned URL here. It already
 * holds a credential, and a blob keeps the bytes out of the URL bar and out of
 * every access log between here and the server.
 *
 * The cost is that the whole file is buffered in memory before it is saved,
 * which is fine at the 100MB per-file cap and irrelevant at CSV sizes.
 */
export async function downloadWorkspaceFile(name: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/files/${encodeURIComponent(name)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadWorkspaceFile(file: File): Promise<WorkspaceFile> {
  const res = await fetch(`${API_URL}/api/files/${encodeURIComponent(file.name)}`, {
    method: "POST",
    // Raw body, not multipart: the server streams the request straight to disk.
    headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Upload failed");
  }
  return res.json();
}

export async function deleteWorkspaceFile(name: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/files/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Delete failed");
}

// ─── Vault ────────────────────────────────────────────────────────────────
// Write-only from every surface: the list never carries a value and there is
// no read endpoint. To rotate, overwrite.

export interface VaultSecret {
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export async function fetchVaultSecrets(): Promise<VaultSecret[]> {
  const res = await fetch(`${API_URL}/api/vault`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load vault");
  return (await res.json()).secrets;
}

export async function putVaultSecret(input: {
  name: string;
  value: string;
  description?: string;
}): Promise<void> {
  const body: { value: string; description?: string | null } = { value: input.value };
  if (input.description !== undefined) body.description = input.description;
  const res = await fetch(`${API_URL}/api/vault/${encodeURIComponent(input.name)}`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const code = (await res.json().catch(() => ({}))).error;
    throw new Error(
      code === "INVALID_NAME"
        ? "Names are lowercase letters, digits, and _ . - (max 64)."
        : code === "TOO_LARGE"
          ? "Value is too large (8 KB max)."
          : code === "EMPTY_VALUE"
            ? "Value cannot be empty."
            : "Save failed"
    );
  }
}

/**
 * Mint a one-time link for a value that is never stored in the vault. The
 * URL works exactly once and dies at `expires_at` (unix seconds) if unused.
 */
export async function mintVaultOneTimeLink(input: {
  value: string;
  ttl_seconds?: number;
}): Promise<{ url: string; expires_at: number }> {
  const res = await fetch(`${API_URL}/api/vault/otl`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const code = (await res.json().catch(() => ({}))).error;
    throw new Error(
      code === "TOO_LARGE"
        ? "Value is too large (8 KB max)."
        : code === "EMPTY_VALUE"
          ? "Value cannot be empty."
          : code === "PORTAL_SESSION_REQUIRED"
            ? "Only a signed-in portal session can create a link."
            : "Could not create the link"
    );
  }
  return res.json();
}

export async function deleteVaultSecret(name: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/vault/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Delete failed");
}
