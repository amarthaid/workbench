import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  disableAdminUser,
  enableAdminUser,
  fetchAdminActivity,
  fetchAdminInstance,
  fetchAdminUsers,
  revokeAdminUserKey,
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
});
