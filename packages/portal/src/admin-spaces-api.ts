// Portal client for GET /api/admin/spaces/search (admin session only). Mirrors the
// auth handling of spaces-api.ts: the viewer's Bearer token, nothing else.

const API_URL = import.meta.env.VITE_API_URL || "";

export interface AdminSpaceHit {
  name: string;
  title: string;
  owner_email: string | null;
}

export interface AdminSpaceSearch {
  spaces: AdminSpaceHit[];
  has_more: boolean;
}

export async function searchAdminSpaces(q: string, signal?: AbortSignal): Promise<AdminSpaceSearch> {
  const token = localStorage.getItem("awb_token");
  const res = await fetch(`${API_URL}/api/admin/spaces/search?q=${encodeURIComponent(q)}&limit=20`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (res.status === 401) {
    localStorage.removeItem("awb_token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error("Failed to search spaces");
  return res.json();
}
