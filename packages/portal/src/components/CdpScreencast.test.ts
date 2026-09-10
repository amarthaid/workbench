import { describe, it, expect } from "vitest";
import { parseSseFrame } from "./CdpScreencast";

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
