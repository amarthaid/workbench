import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import CdpScreencast, { parseSseFrame } from "./CdpScreencast";
import { clearBrowserSessionKey } from "../api";

// The live view reads its SSE stream through fetch (EventSource cannot send an
// Authorization header), so frame parsing is ours to get right.
describe("parseSseFrame", () => {
  it("reads an event with no data, like the ready handshake", () => {
    expect(parseSseFrame("event: ready")).toEqual({ event: "ready", data: "" });
  });

  it("reads a CDP message", () => {
    const payload = '{"method":"Page.screencastFrame","params":{"data":"AAA"}}';
    expect(parseSseFrame(`event: cdp\ndata: ${payload}`)).toEqual({
      event: "cdp",
      data: payload,
    });
  });

  it("rejoins a payload the server split across data lines", () => {
    expect(parseSseFrame("event: cdp\ndata: one\ndata: two")).toEqual({
      event: "cdp",
      data: "one\ntwo",
    });
  });

  it("ignores keepalive comments — they are not events", () => {
    expect(parseSseFrame(": keepalive")).toBeNull();
  });
});

// An SSE response that stays open until the test lets it end.
function openStream(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      // Deliberately not closed: a live view holds its stream open.
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// Header a request carried, whichever fetch form the caller used.
function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe("CdpScreencast transport", () => {
  beforeEach(() => {
    localStorage.setItem("awb_token", "portal-jwt");
    clearBrowserSessionKey();
  });
  afterEach(() => {
    localStorage.clear();
    clearBrowserSessionKey();
    vi.unstubAllGlobals();
  });

  it("mints a routing key and carries it on the stream and the commands", async () => {
    const seen: { url: string; key?: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, key: headerOf(init, "X-Browser-Session") });
      if (url.endsWith("/attach")) {
        return new Response(JSON.stringify({ sessionKey: "key-abc", header: "x-browser-session" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/events")) return openStream(["event: ready\n\n"]);
      return new Response(JSON.stringify({ sent: 1 }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CdpScreencast cdpProxyUrl="/api/browser-session/cdp" width={320} />);

    // The stream opens keyed, and the enable/startScreencast batch follows —
    // that batch is what starts chromium server-side.
    await waitFor(() => expect(seen.some((r) => r.url.endsWith("/commands"))).toBe(true));
    const attach = seen.find((r) => r.url.endsWith("/attach"))!;
    const events = seen.find((r) => r.url.endsWith("/events"))!;
    const commands = seen.find((r) => r.url.endsWith("/commands"))!;
    // Attach cannot be routed — it is the request that hands out the key.
    expect(attach.key).toBeUndefined();
    expect(events.key).toBe("key-abc");
    expect(commands.key).toBe("key-abc");
    // No ids in the URL; routing rides the header.
    expect(events.url).not.toContain("?");
  });

  it("re-attaches when a command POST reports the session is gone", async () => {
    // The session ended, or the request reached a replica that does not hold
    // it. Without recovery the stream keeps painting frames while every click
    // goes nowhere.
    let attaches = 0;
    let streams = 0;
    let commands = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attach")) {
        attaches++;
        return new Response(JSON.stringify({ sessionKey: `key-${attaches}` }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/events")) {
        streams++;
        return openStream(["event: ready\n\n"]);
      }
      if (url.endsWith("/commands")) {
        commands++;
        // The first view's commands are orphaned; the re-attached one works.
        return new Response(JSON.stringify({ error: "NO_CHANNEL" }), {
          status: commands === 1 ? 404 : 202,
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CdpScreencast cdpProxyUrl="/api/browser-session/cdp" width={320} />);

    await waitFor(() => expect(streams).toBe(1));
    // The retry waits out one backoff step before attaching again.
    await waitFor(() => expect(streams).toBe(2), { timeout: 4000 });
    expect(attaches).toBe(2);
  });

  it("treats a busy browser as retryable too", async () => {
    // 409 BROWSER_SESSION_BUSY means a spawn is in flight for this user —
    // transient, so the view should come back rather than die.
    let streams = 0;
    let commands = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attach")) {
        return new Response(JSON.stringify({ sessionKey: "key-abc" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/events")) {
        streams++;
        return openStream(["event: ready\n\n"]);
      }
      if (url.endsWith("/commands")) {
        commands++;
        return new Response(JSON.stringify({ error: "BROWSER_SESSION_BUSY" }), {
          status: commands === 1 ? 409 : 202,
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CdpScreencast cdpProxyUrl="/api/browser-session/cdp" width={320} />);
    await waitFor(() => expect(streams).toBe(2), { timeout: 4000 });
  });

  it("stops without retrying when attach is refused", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attach")) return new Response(null, { status: 401 });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <CdpScreencast cdpProxyUrl="/api/browser-session/cdp" width={320} />
    );

    await waitFor(() => expect(container.textContent).toContain("Unauthorized"));
    // One attempt only — reconnecting cannot fix a credential.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/attach"))).toHaveLength(1);
  });
});
