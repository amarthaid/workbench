import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApprovalApiError,
  approveAdminApproval,
  approveApproval,
  cancelApproval,
  fetchAdminApprovals,
  fetchApprovals,
  rejectAdminApproval,
  rejectApproval,
  requestSpaceAccess,
} from "./approvals-api";

const fetchMock = vi.fn();

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit & { headers: Record<string, string> } };
}

beforeEach(() => {
  localStorage.setItem("awb_token", "tok-abc");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(respond(200, { ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  localStorage.clear();
});

describe("admin approvals", () => {
  it("lists with limit and cursor under the admin path", async () => {
    const page = { items: [], next_cursor: "c2", pending_total: 7 };
    fetchMock.mockResolvedValue(respond(200, page));
    expect(await fetchAdminApprovals({ limit: 25, cursor: "c1" })).toEqual(page);
    const { url, init } = lastCall();
    expect(url).toBe("/api/admin/approvals?limit=25&cursor=c1");
    expect(init.headers).toEqual({ Authorization: "Bearer tok-abc" });
  });

  it("lists without a query string by default", async () => {
    await fetchAdminApprovals();
    expect(lastCall().url).toBe("/api/admin/approvals");
  });

  it("approves with a bodyless POST", async () => {
    await approveAdminApproval("a/1");
    const { url, init } = lastCall();
    expect(url).toBe("/api/admin/approvals/a%2F1/approve");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: "Bearer tok-abc" });
  });

  it("rejects with a trimmed note, or an empty body when there is none", async () => {
    await rejectAdminApproval("a1", "  not now  ");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ note: "not now" });
    await rejectAdminApproval("a1", "   ");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({});
    expect(lastCall().init.headers["Content-Type"]).toBe("application/json");
  });
});

describe("space approvals", () => {
  it("lists by scope", async () => {
    fetchMock.mockResolvedValue(respond(200, { items: [{ id: "x" }] }));
    expect(await fetchApprovals("inbox")).toEqual([{ id: "x" }]);
    expect(lastCall().url).toBe("/api/approvals?scope=inbox");
    fetchMock.mockResolvedValue(respond(200, {}));
    expect(await fetchApprovals("mine")).toEqual([]);
    expect(lastCall().url).toBe("/api/approvals?scope=mine");
  });

  it("asks for access with the kind, the Space name and an optional message", async () => {
    fetchMock.mockResolvedValue(respond(202, { accepted: true }));
    await requestSpaceAccess("sprint-board", " please ");
    expect(lastCall().url).toBe("/api/approvals");
    expect(lastCall().init.method).toBe("POST");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      kind: "space.access",
      subject: "sprint-board",
      message: "please",
    });
    await requestSpaceAccess("sprint-board");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ kind: "space.access", subject: "sprint-board" });
  });

  it("approves, rejects and cancels on the portal paths", async () => {
    await approveApproval("r1");
    expect(lastCall().url).toBe("/api/approvals/r1/approve");
    await rejectApproval("r1", "no");
    expect(lastCall().url).toBe("/api/approvals/r1/reject");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ note: "no" });
    await cancelApproval("r1");
    expect(lastCall().url).toBe("/api/approvals/r1");
    expect(lastCall().init.method).toBe("DELETE");
  });
});

describe("errors", () => {
  it("maps a rate limit to fixed copy", async () => {
    fetchMock.mockResolvedValue(respond(429, { error: "rate_limited" }));
    const e = await requestSpaceAccess("a").catch((x) => x);
    expect(e).toBeInstanceOf(ApprovalApiError);
    expect(e.status).toBe(429);
    expect(e.message).toBe("Too many requests. Try again later.");
  });

  it("never echoes server text into the message", async () => {
    fetchMock.mockResolvedValue(respond(400, { error: "<b>boom</b>" }));
    const e = await approveApproval("r1").catch((x) => x);
    expect(e.message).toBe("Action failed");
  });

  it("signs out on a 401", async () => {
    const original = window.location;
    Object.defineProperty(window, "location", { value: { href: "/admin" }, writable: true });
    try {
      fetchMock.mockResolvedValue(respond(401, {}));
      await expect(fetchAdminApprovals()).rejects.toMatchObject({ status: 401 });
      expect(localStorage.getItem("awb_token")).toBeNull();
      expect(window.location.href).toBe("/login");
    } finally {
      Object.defineProperty(window, "location", { value: original, writable: true });
    }
  });

  it("reports a network failure as status 0", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    await expect(fetchApprovals("mine")).rejects.toMatchObject({ status: 0 });
  });
});
