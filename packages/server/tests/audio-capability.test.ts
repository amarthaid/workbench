import { describe, it, expect } from "vitest";
import { capabilityFor, sessionForCapability, redactAudioPath } from "../src/audio/capability";
import type { AudioSession } from "../src/audio/session";

function fakeSession() {
  let end!: () => void;
  const s = { ended: undefined as string | undefined, whenEnded: new Promise<void>((r) => { end = r; }) };
  return { session: s as unknown as AudioSession, end: () => { s.ended = "stopped"; end(); } };
}

describe("audio capability", () => {
  it("is 128 random bits of base64url, stable per session, distinct across sessions", () => {
    const a = fakeSession();
    const b = fakeSession();
    const cap = capabilityFor(a.session);
    expect(cap).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(capabilityFor(a.session)).toBe(cap);
    expect(capabilityFor(b.session)).not.toBe(cap);
  });

  it("opens its session until the session ends, then nothing", async () => {
    const a = fakeSession();
    const cap = capabilityFor(a.session);
    expect(sessionForCapability(cap)).toBe(a.session);
    a.end();
    expect(sessionForCapability(cap)).toBeUndefined();
    await a.session.whenEnded;
    expect(sessionForCapability(cap)).toBeUndefined();
  });

  it("unknown and empty capabilities open nothing", () => {
    expect(sessionForCapability("")).toBeUndefined();
    expect(sessionForCapability("AAAAAAAAAAAAAAAAAAAAAA")).toBeUndefined();
  });

  it("redacts the capability from a path, keeping the rest", () => {
    expect(redactAudioPath("/api/browser/audio/abcDEF_-123/stream?x=1")).toBe("/api/browser/audio/[REDACTED]/stream?x=1");
    expect(redactAudioPath("/api/browser/tabs/T1")).toBe("/api/browser/tabs/T1");
  });
});
