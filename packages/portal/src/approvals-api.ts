// Portal client for the maker-checker routes.
//
// Two groups, both session-only (an API key or OAuth token gets a 401):
//   /api/admin/approvals/*  account.activate requests, admin sessions only
//   /api/approvals/*        space.access requests, any portal session
//
// Message and note text comes from other people. It is data: callers render it
// as text and never as markup.

const API_URL = import.meta.env.VITE_API_URL || "";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface AdminApproval {
  id: string;
  kind: "account.activate";
  requester_email: string;
  message: string | null;
  /** Unix seconds. */
  created_at: number;
}

export interface AdminApprovalPage {
  items: AdminApproval[];
  next_cursor: string | null;
  /** All open account requests, not only this page. */
  pending_total: number;
}

export interface SpaceApproval {
  id: string;
  kind: "space.access";
  /** The Space name. */
  subject: string;
  subject_label: string;
  /** Inbox only; null for your own requests. */
  requester_email: string | null;
  message: string | null;
  status: ApprovalStatus;
  /** Unix seconds. */
  created_at: number;
  /** The Space runs with its owner's connections. */
  delegated: boolean;
}

export type ApprovalScope = "mine" | "inbox";

/** The longest message the server stores; the form stops here too. */
export const REQUEST_MESSAGE_MAX = 280;
/** The longest decision note the form sends. */
export const DECISION_NOTE_MAX = 280;

export class ApprovalApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApprovalApiError";
    this.status = status;
    this.code = code;
  }
}

const CODE_MESSAGES: Record<string, string> = {
  rate_limited: "Too many requests. Try again later.",
  not_found: "That request is no longer open.",
  closed: "That request is no longer open.",
};

function token(): string | null {
  try {
    return localStorage.getItem("awb_token");
  } catch {
    return null;
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const t = token();
  const hasBody = init.body !== undefined;
  const headers: Record<string, string> = {
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    // A Content-Type with no body is rejected by Fastify, so only set it with one.
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApprovalApiError(0, "network", "Network request failed");
  }
  if (res.status === 401) {
    try {
      localStorage.removeItem("awb_token");
    } catch {
      /* the redirect matters more */
    }
    window.location.href = "/login";
    throw new ApprovalApiError(401, "unauthenticated", "Sign in again to continue");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    const raw = typeof body.error === "string" ? body.error : typeof body.code === "string" ? body.code : "";
    const code = raw.toLowerCase();
    const message =
      CODE_MESSAGES[code] ?? (res.status === 429 ? CODE_MESSAGES.rate_limited : "Action failed");
    throw new ApprovalApiError(res.status, code || "failed", message);
  }
  return (await res.json().catch(() => ({}))) as T;
}

const seg = encodeURIComponent;

// ─── Admin: account requests ─────────────────────────────────────────────
export function fetchAdminApprovals(opts: { limit?: number; cursor?: string } = {}): Promise<AdminApprovalPage> {
  const qs = new URLSearchParams();
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  const suffix = qs.toString() ? `?${qs}` : "";
  return call<AdminApprovalPage>(`/api/admin/approvals${suffix}`);
}

export async function approveAdminApproval(id: string): Promise<void> {
  await call(`/api/admin/approvals/${seg(id)}/approve`, { method: "POST" });
}

export async function rejectAdminApproval(id: string, note?: string): Promise<void> {
  const trimmed = note?.trim();
  await call(`/api/admin/approvals/${seg(id)}/reject`, {
    method: "POST",
    body: trimmed ? { note: trimmed } : {},
  });
}

// ─── Portal: Space access requests ───────────────────────────────────────
export async function fetchApprovals(scope: ApprovalScope): Promise<SpaceApproval[]> {
  const data = await call<{ items?: SpaceApproval[] }>(`/api/approvals?scope=${scope}`);
  return data.items ?? [];
}

/**
 * Always 202 {accepted:true}, whether or not the Space exists: the server
 * deliberately answers the same, so nothing here may imply it does.
 */
export async function requestSpaceAccess(subject: string, message?: string): Promise<void> {
  const trimmed = message?.trim();
  await call(`/api/approvals`, {
    method: "POST",
    body: { kind: "space.access", subject, ...(trimmed ? { message: trimmed } : {}) },
  });
}

export async function approveApproval(id: string): Promise<void> {
  await call(`/api/approvals/${seg(id)}/approve`, { method: "POST" });
}

export async function rejectApproval(id: string, note?: string): Promise<void> {
  const trimmed = note?.trim();
  await call(`/api/approvals/${seg(id)}/reject`, { method: "POST", body: trimmed ? { note: trimmed } : {} });
}

export async function cancelApproval(id: string): Promise<void> {
  await call(`/api/approvals/${seg(id)}`, { method: "DELETE" });
}
