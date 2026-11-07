import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SpaceApiError,
  callSpaceTool,
  deleteSpaceKv,
  fetchSpace,
  fetchSpaceKv,
  fetchSpaceKvKeys,
  fetchSpaces,
  grantSpaceConsent,
  putSpaceKv,
  revokeSpaceConsent,
} from "./spaces-api";

const fetchMock = vi.fn();

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
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
  sessionStorage.clear();
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit & { headers: Record<string, string> } };
}

describe("spaces api", () => {
  it("fetchSpaces lists with the portal bearer only", async () => {
    fetchMock.mockResolvedValue(respond(200, { spaces: [{ name: "a" }] }));
    expect(await fetchSpaces()).toEqual([{ name: "a" }]);
    const { url, init } = lastCall();
    expect(url).toBe("/api/spaces");
    expect(init.headers).toEqual({ Authorization: "Bearer tok-abc" });
  });

  it("fetchSpace encodes the name", async () => {
    fetchMock.mockResolvedValue(respond(200, { name: "a b" }));
    await fetchSpace("a b");
    expect(lastCall().url).toBe("/api/spaces/a%20b");
  });

  it("fetchSpace surfaces a 404 as a SpaceApiError", async () => {
    fetchMock.mockResolvedValue(respond(404, { code: "NOT_FOUND", message: "nope" }));
    const err = await fetchSpace("x").catch((e) => e);
    expect(err).toBeInstanceOf(SpaceApiError);
    expect(err.status).toBe(404);
  });

  it.each([
    ["grant", grantSpaceConsent, "POST"],
    ["revoke", revokeSpaceConsent, "DELETE"],
  ] as const)("%s consent is a bodyless %s with no Content-Type", async (_n, fn, method) => {
    await fn("pr-timeline");
    const { url, init } = lastCall();
    expect(url).toBe("/api/spaces/pr-timeline/consent");
    expect(init.method).toBe(method);
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: "Bearer tok-abc" });
  });

  it("callSpaceTool posts JSON and returns the result", async () => {
    fetchMock.mockResolvedValue(respond(200, { result: { prs: [] } }));
    const result = await callSpaceTool("pr-timeline", { tool: "github_list_prs", args: { a: 1 } });
    expect(result).toEqual({ prs: [] });
    const { url, init } = lastCall();
    expect(url).toBe("/api/spaces/pr-timeline/call");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer tok-abc", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ tool: "github_list_prs", args: { a: 1 } });
  });

  it("maps an error body straight through", async () => {
    fetchMock.mockResolvedValue(
      respond(409, { code: "NOT_CONNECTED", message: "connect first", integration: "github", tool: "github_list_prs" })
    );
    const err = (await callSpaceTool("s", { tool: "github_list_prs" }).catch((e) => e)) as SpaceApiError;
    expect(err.status).toBe(409);
    expect(err.toBody()).toEqual({
      code: "NOT_CONNECTED",
      message: "connect first",
      integration: "github",
      tool: "github_list_prs",
    });
  });

  it("keeps retryAfterMs on a rate limit", async () => {
    fetchMock.mockResolvedValue(respond(429, { code: "RATE_LIMITED", message: "slow down", retryAfterMs: 500 }));
    const err = (await callSpaceTool("s", { tool: "t" }).catch((e) => e)) as SpaceApiError;
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryAfterMs).toBe(500);
  });

  it("a network failure becomes UPSTREAM_ERROR", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = (await callSpaceTool("s", { tool: "t" }).catch((e) => e)) as SpaceApiError;
    expect(err.code).toBe("UPSTREAM_ERROR");
  });

  it("a body without a code falls back to UPSTREAM_ERROR", async () => {
    fetchMock.mockResolvedValue(respond(500, {}));
    const err = (await callSpaceTool("s", { tool: "t" }).catch((e) => e)) as SpaceApiError;
    expect(err.code).toBe("UPSTREAM_ERROR");
  });

  it("a 401 redirects to login and remembers where the viewer was", async () => {
    window.history.pushState({}, "", "/s/pr-timeline");
    fetchMock.mockResolvedValue(respond(401, {}));
    const err = (await fetchSpace("pr-timeline").catch((e) => e)) as SpaceApiError;
    expect(err.code).toBe("UNAUTHENTICATED");
    expect(localStorage.getItem("awb_token")).toBeNull();
    expect(sessionStorage.getItem("awb_return_to")).toBe("/s/pr-timeline");
    window.history.pushState({}, "", "/");
  });

  describe("kv", () => {
    it("lists keys", async () => {
      fetchMock.mockResolvedValue(respond(200, { keys: ["a"] }));
      expect(await fetchSpaceKvKeys("s")).toEqual(["a"]);
      expect(lastCall().url).toBe("/api/spaces/s/kv");
    });

    it("gets a value", async () => {
      fetchMock.mockResolvedValue(respond(200, { value: { n: 1 } }));
      expect(await fetchSpaceKv("s", "a/b")).toEqual({ n: 1 });
      expect(lastCall().url).toBe("/api/spaces/s/kv/a%2Fb");
    });

    it("a missing key (KEY_NOT_FOUND) is undefined", async () => {
      fetchMock.mockResolvedValue(respond(404, { code: "KEY_NOT_FOUND", message: "no key" }));
      expect(await fetchSpaceKv("s", "a")).toBeUndefined();
    });

    it("a Space-level NOT_FOUND is an error, not a missing key", async () => {
      fetchMock.mockResolvedValue(respond(404, { code: "NOT_FOUND", message: "gone" }));
      await expect(fetchSpaceKv("s", "a")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    });

    it("puts a value as { value }", async () => {
      await putSpaceKv("s", "a", [1, 2]);
      const { url, init } = lastCall();
      expect(url).toBe("/api/spaces/s/kv/a");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({ value: [1, 2] });
    });

    it("deletes a key", async () => {
      await deleteSpaceKv("s", "a");
      const { url, init } = lastCall();
      expect(url).toBe("/api/spaces/s/kv/a");
      expect(init.method).toBe("DELETE");
      expect(init.headers).toEqual({ Authorization: "Bearer tok-abc" });
    });

    it("TOO_LARGE surfaces as an error", async () => {
      fetchMock.mockResolvedValue(respond(413, { code: "TOO_LARGE", message: "too big" }));
      const err = (await putSpaceKv("s", "a", "x").catch((e) => e)) as SpaceApiError;
      expect(err.code).toBe("TOO_LARGE");
    });
  });
});
