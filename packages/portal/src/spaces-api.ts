// Portal client for /api/spaces. These routes accept the portal session only
// (an API key or OAuth token gets a 401), so every request carries the
// viewer's Bearer token and nothing else.

const API_URL = import.meta.env.VITE_API_URL || "";

export type ToolEffect = "read" | "write" | "destructive";
export type SpaceVisibility = "private" | "org" | "users";

export interface SpaceSummary {
  name: string;
  title: string;
  description: string | null;
  ownerEmail: string;
  visibility: SpaceVisibility;
  /** Epoch ms. */
  updatedAt: number;
  mine: boolean;
  /** Owner: the stored setting. Anyone else: whether it is in effect. */
  delegate_access?: boolean;
  /** On, but paused until the owner confirms a changed tool list. */
  delegation_suspended?: boolean;
  /** Owner only: the stored mode is on but the owner lacks the permission. */
  delegation_blocked?: "no_permission";
}

export interface SpaceTool {
  name: string;
  integration: string;
  integrationName: string;
  /** Absent or unrecognised means the shell treats it as destructive. */
  effect?: ToolEffect | string;
  connected?: boolean;
  description?: string;
  /** The tool no longer exists in the registry. */
  missing?: boolean;
  /** False: refused when the Space runs with delegated access. */
  delegable?: boolean;
}

/**
 * Why a delegated Space cannot run calls right now. "owner_not_connected" is
 * only shown to viewers: delegation is in effect, but the owner has not
 * connected every integration the Space uses.
 */
export interface DelegationOff {
  reason: "turned_off" | "tools_changed" | "owner_not_connected";
  message: string;
}

export interface SpaceDetail {
  name: string;
  title: string;
  description: string | null;
  ownerEmail: string;
  mine: boolean;
  visibility: SpaceVisibility;
  /** Only returned to the owner. */
  users?: string[];
  /** Epoch ms. */
  updatedAt: number;
  tools: SpaceTool[];
  consented: boolean;
  /** What approving this screen approves; sent back with the approval. */
  consent_hash?: string;
  appUrl: string;
  /**
   * Calls run with the owner's connections. The owner gets the stored
   * setting; anyone else whether it is in effect.
   */
  delegate_access?: boolean;
  /** On, but paused until the owner confirms the changed tool list. */
  delegation_suspended?: boolean;
  /** Owner only: the stored mode is on but the owner lacks the permission. */
  delegation_blocked?: "no_permission";
  /** Set when delegated access is on but cannot run calls (or, for a viewer, the owner must connect first). */
  delegation_off?: DelegationOff | null;
  /** Owner only: the hash of this tool list, sent back to confirm it. */
  tools_hash?: string;
  /** Owner only: an admin allowed this user to delegate access. */
  can_delegate?: boolean;
}

/**
 * Error codes the Space routes answer with that the portal maps to its own
 * copy. Others (CONSENT_REQUIRED, NOT_CONNECTED, ...) are handled where they
 * occur.
 */
// DELEGATION_PORTAL_ONLY is intentionally not here: only an agent credential
// gets it (an agent may not turn delegation on), and the portal never sends
// one, so the portal has nothing to show for it.
export const DELEGATION_ERROR_CODES = {
  /** PATCH sharing: no admin grant, or an "Only me" audience. */
  NOT_ALLOWED: "DELEGATION_NOT_ALLOWED",
  /** PATCH sharing: the tool list changed since the owner reviewed it. */
  TOOLS_CHANGED: "TOOLS_CHANGED",
  /** POST call: delegation is on but turned off or paused. */
  OFF: "DELEGATION_OFF",
  /** POST call: this tool never runs with someone else's access. */
  TOOL_NOT_DELEGABLE: "TOOL_NOT_DELEGABLE",
} as const;

export interface SpaceErrorBody {
  code: string;
  message: string;
  integration?: string;
  tool?: string;
  /** DELEGATION_OFF: why. */
  reason?: string;
  /** NOT_CONNECTED on a delegated call: the owner must reconnect, not the viewer. */
  delegated?: boolean;
}

/** A non-200 from /api/spaces, or a network failure (UPSTREAM_ERROR, status 0). */
export class SpaceApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly integration?: string;
  readonly tool?: string;
  readonly retryAfterMs?: number;
  readonly reason?: string;
  readonly delegated?: boolean;

  constructor(status: number, body: Partial<SpaceErrorBody> & { retryAfterMs?: number }) {
    super(body.message || body.code || "Request failed");
    this.name = "SpaceApiError";
    this.status = status;
    this.code = body.code || (status === 401 ? "UNAUTHENTICATED" : "UPSTREAM_ERROR");
    if (body.integration) this.integration = body.integration;
    if (body.tool) this.tool = body.tool;
    if (typeof body.retryAfterMs === "number") this.retryAfterMs = body.retryAfterMs;
    if (typeof body.reason === "string") this.reason = body.reason;
    if (body.delegated === true) this.delegated = true;
  }

  /** The shape the bridge sends back to a Space. */
  toBody(): SpaceErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.integration ? { integration: this.integration } : {}),
      ...(this.tool ? { tool: this.tool } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.delegated ? { delegated: true } : {}),
    };
  }
}

function bearer(): Record<string, string> {
  const token = localStorage.getItem("awb_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// The existing portal 401 handling, plus the return path so the viewer lands
// back on the Space they were using after signing in again.
function redirectToLogin(): void {
  try {
    sessionStorage.setItem("awb_return_to", window.location.pathname + window.location.search);
  } catch {
    // Storage can be unavailable; the redirect still matters more.
  }
  localStorage.removeItem("awb_token");
  window.location.href = "/login";
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      // Bodyless requests carry no Content-Type: Fastify rejects an empty
      // application/json body (FST_ERR_CTP_EMPTY_JSON_BODY).
      headers: hasBody ? { ...bearer(), "Content-Type": "application/json" } : bearer(),
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new SpaceApiError(0, { code: "UPSTREAM_ERROR", message: "Network request failed" });
  }
  if (res.status === 401) {
    redirectToLogin();
    throw new SpaceApiError(401, { code: "UNAUTHENTICATED", message: "Sign in again to continue" });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<SpaceErrorBody> & { retryAfterMs?: number };
    throw new SpaceApiError(res.status, body && typeof body === "object" ? body : {});
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const seg = encodeURIComponent;

export async function fetchSpaces(): Promise<SpaceSummary[]> {
  const data = await request<{ spaces: SpaceSummary[] }>("/api/spaces");
  return data.spaces ?? [];
}

export function fetchSpace(name: string): Promise<SpaceDetail> {
  return request<SpaceDetail>(`/api/spaces/${seg(name)}`);
}

export interface SpaceSharing {
  visibility: SpaceVisibility;
  users: string[];
  delegate_access: boolean;
  delegation_suspended: boolean;
}

export interface SpaceSharingChange {
  visibility?: SpaceVisibility;
  add_users?: string[];
  remove_users?: string[];
  /** true needs tools_hash: the hash of the tool list the owner reviewed. */
  delegate_access?: boolean;
  tools_hash?: string;
}

/** Owner only. add_users / remove_users leave everyone else on the list. */
export function updateSpaceSharing(name: string, change: SpaceSharingChange): Promise<SpaceSharing> {
  return request<SpaceSharing>(`/api/spaces/${seg(name)}/sharing`, { method: "PATCH", body: change });
}

/**
 * Approve the tools as shown: `consentHash` is the detail's `consent_hash`. A
 * Space that changed since answers 409 CONSENT_CHANGED.
 */
export async function grantSpaceConsent(name: string, consentHash: string | undefined): Promise<void> {
  await request<{ ok: true }>(`/api/spaces/${seg(name)}/consent`, {
    method: "POST",
    body: { consent_hash: consentHash },
  });
}

export async function revokeSpaceConsent(name: string): Promise<void> {
  await request<{ ok: true }>(`/api/spaces/${seg(name)}/consent`, { method: "DELETE" });
}

export interface SpaceCallBody {
  tool: string;
  args?: unknown;
  confirmed?: true;
}

export async function callSpaceTool(name: string, body: SpaceCallBody): Promise<unknown> {
  const data = await request<{ result: unknown }>(`/api/spaces/${seg(name)}/call`, { method: "POST", body });
  return data.result;
}

export async function fetchSpaceKvKeys(name: string): Promise<string[]> {
  const data = await request<{ keys: string[] }>(`/api/spaces/${seg(name)}/kv`);
  return data.keys ?? [];
}

/**
 * `undefined` when the key is not set (404 KEY_NOT_FOUND). A Space-level 404
 * (NOT_FOUND: gone, or no longer shared) is an error, not a missing key.
 */
export async function fetchSpaceKv(name: string, key: string): Promise<unknown> {
  try {
    const data = await request<{ value: unknown }>(`/api/spaces/${seg(name)}/kv/${seg(key)}`);
    return data.value;
  } catch (e) {
    if (e instanceof SpaceApiError && e.status === 404 && e.code === "KEY_NOT_FOUND") return undefined;
    throw e;
  }
}

export async function putSpaceKv(name: string, key: string, value: unknown): Promise<void> {
  await request<unknown>(`/api/spaces/${seg(name)}/kv/${seg(key)}`, { method: "PUT", body: { value } });
}

export async function deleteSpaceKv(name: string, key: string): Promise<void> {
  await request<unknown>(`/api/spaces/${seg(name)}/kv/${seg(key)}`, { method: "DELETE" });
}
