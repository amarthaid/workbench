import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearUserPermission,
  disableAdminUser,
  getUserPermissions,
  setUserPermission,
  enableAdminUser,
  fetchAdminActivity,
  fetchAdminInstance,
  fetchAdminUsers,
  revokeAdminUserKey,
  userStatus,
} from "./api";

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.setItem("awb_token", "tok-abc");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  localStorage.clear();
});

describe("admin fetchers", () => {
  it("fetchAdminInstance calls the instance endpoint with the bearer token", async () => {
    await fetchAdminInstance();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/overview/instance");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
  });

  it("fetchAdminActivity sends only the filters it was given", async () => {
    await fetchAdminActivity({ limit: 50, status: "error", email: "dev@example.com", cursor: "c1" });
    const url = new URL(fetchMock.mock.calls[0][0], "http://x");
    expect(url.pathname).toBe("/api/admin/overview/activity");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "50",
      status: "error",
      email: "dev@example.com",
      cursor: "c1",
    });
  });

  it("fetchAdminActivity with no options adds no query string", async () => {
    await fetchAdminActivity();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/overview/activity");
  });

  it("throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    await expect(fetchAdminInstance()).rejects.toThrow("Failed to fetch instance info");
  });

  it("fetchAdminUsers calls the users endpoint", async () => {
    await fetchAdminUsers();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/users");
  });

  it.each([
    ["disable", disableAdminUser],
    ["enable", enableAdminUser],
    ["revoke-key", revokeAdminUserKey],
  ] as const)("%s POSTs with the bearer token and no Content-Type", async (path, fn) => {
    await fn("u 1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/admin/users/u%201/${path}`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("an action the server refuses throws a readable message", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "cannot_disable_self" }) });
    await expect(disableAdminUser("me")).rejects.toThrow("You can't disable your own account.");
  });

  it("an unrecognised error code falls back to a generic message", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "weird" }) });
    await expect(enableAdminUser("u1")).rejects.toThrow("Action failed");
  });

  describe("user permissions", () => {
    it("getUserPermissions reads the user's permissions with the bearer token", async () => {
      const view = {
        permissions: [
          {
            capability: "spaces.delegate_access",
            label: "Delegate access in Spaces",
            description: "d",
            default: "deny",
            effect: "allow",
            source: "rule",
            grantedBy: "admin",
            grantedByEmail: "admin@example.com",
            grantedAt: 1_700_000_000,
          },
        ],
        delegatedSpaces: 2,
      };
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => view });
      expect(await getUserPermissions("u 1")).toEqual(view);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/admin/users/u%201/permissions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
    });

    it("setUserPermission PUTs the effect as JSON", async () => {
      await setUserPermission("u1", "spaces.delegate_access", "allow");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/admin/users/u1/permissions/spaces.delegate_access");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ effect: "allow" });
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("clearUserPermission is a bodyless DELETE with no Content-Type", async () => {
      await clearUserPermission("u1", "spaces.delegate_access");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/admin/users/u1/permissions/spaces.delegate_access");
      expect(init.method).toBe("DELETE");
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    });

    it("a refused permission change throws a readable message", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "invalid_effect" }) });
      await expect(setUserPermission("u1", "spaces.delegate_access", "deny")).rejects.toThrow(
        "That permission can only be allowed or set back to the default."
      );
      fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "user_not_found" }) });
      await expect(clearUserPermission("gone", "spaces.delegate_access")).rejects.toThrow("That user no longer exists.");
    });
  });
});

describe("userStatus", () => {
  it("reads status when the server sends it", () => {
    expect(userStatus({ status: "active", disabled_at: null })).toBe("active");
    expect(userStatus({ status: "pending", disabled_at: null })).toBe("pending");
    expect(userStatus({ status: "disabled", disabled_at: 5 })).toBe("disabled");
  });

  it("falls back to disabled_at without a status, and fails closed on a stale disabled_at", () => {
    expect(userStatus({ disabled_at: null })).toBe("active");
    expect(userStatus({ disabled_at: 5 })).toBe("disabled");
    expect(userStatus({ status: "active", disabled_at: 5 })).toBe("disabled");
  });
});
