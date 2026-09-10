import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import CdpScreencast, { parseSseFrame } from "./CdpScreencast";

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

describe("CdpScreencast channel recovery", () => {
  beforeEach(() => {
    localStorage.setItem("awb_token", "portal-jwt");
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("re-attaches when a command POST reports the channel is gone", async () => {
    // A 404 on /commands means the channel isn't on the server that answered —
    // the session ended, or the request reached another replica, since the
    // browser session is per-process. Without recovery the stream keeps
    // painting frames while every click goes nowhere.
    const attachedChannels: string[] = [];
    const streamedChannels: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/attach")) {
        const id = `c${attachedChannels.length + 1}`;
        attachedChannels.push(id);
        return new Response(JSON.stringify({ channelId: id }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/events")) {
        streamedChannels.push(new URL(url, "http://localhost").searchParams.get("channel")!);
        return openStream(["event: ready\n\n"]);
      }
      if (url.includes("/commands")) {
        // Only the first channel is stale; the re-attached one works.
        const channel = new URL(url, "http://localhost").searchParams.get("channel");
        return new Response(JSON.stringify({ error: "NO_CHANNEL" }), {
          status: channel === "c1" ? 404 : 202,
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CdpScreencast cdpProxyUrl="/api/browser-session/cdp" sessionId="u1" cdpToken="ctok" width={320} />);

    // First channel attaches, streams, and its enable/startScreencast batch 404s.
    await waitFor(() => expect(streamedChannels).toEqual(["c1"]));
    // The retry waits out one backoff step before the second attach.
    await waitFor(() => expect(streamedChannels).toEqual(["c1", "c2"]), { timeout: 4000 });
    expect(attachedChannels).toEqual(["c1", "c2"]);
  });

  it("stops without retrying when attach is refused", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/attach")) return new Response(null, { status: 401 });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <CdpScreencast cdpProxyUrl="/api/browser-session/cdp" sessionId="u1" cdpToken="ctok" width={320} />
    );

    await waitFor(() => expect(container.textContent).toContain("Unauthorized"));
    // One attempt only — reconnecting cannot fix a credential.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/attach"))).toHaveLength(1);
  });
});
