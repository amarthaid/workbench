import { describe, it, expect } from "vitest";
import { validateHeaders, headersToRecord, fingerprint, MAX_HEADERS } from "../src/custom-apps/headers";

describe("validateHeaders", () => {
  it("accepts a well-formed header", () => {
    expect(validateHeaders([{ name: "X-Api-Key", value: "tok-abc" }])).toEqual({
      ok: true,
      headers: [{ name: "X-Api-Key", value: "tok-abc" }],
    });
  });

  it("rejects non-array, empty list, and too many headers", () => {
    expect(validateHeaders("x").ok).toBe(false);
    expect(validateHeaders([]).ok).toBe(false);
    const many = Array.from({ length: MAX_HEADERS + 1 }, (_, i) => ({ name: `X-H${i}`, value: "v" }));
    expect(validateHeaders(many).ok).toBe(false);
  });

  it("rejects invalid names", () => {
    for (const name of ["", "Bad Name", "X:Y", "X-Ä", "a\r\nb"]) {
      expect(validateHeaders([{ name, value: "v" }]).ok, name).toBe(false);
    }
  });

  it("rejects deny-listed names case-insensitively", () => {
    for (const name of ["Host", "content-length", "Content-Type", "ACCEPT", "Mcp-Session-Id", "x-workbench-via", "Transfer-Encoding", "MCP-Protocol-Version", "Last-Event-ID"]) {
      expect(validateHeaders([{ name, value: "v" }]).ok, name).toBe(false);
    }
  });

  it("caps the name length at 256 and truncates it in the error", () => {
    const ok256 = "a".repeat(256);
    expect(validateHeaders([{ name: ok256, value: "v" }]).ok).toBe(true);
    const r = validateHeaders([{ name: "a".repeat(257), value: "v" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeLessThan(100);
  });

  it("rejects header injection and oversized values", () => {
    expect(validateHeaders([{ name: "X-Api-Key", value: "a\r\nX-Evil: 1" }]).ok).toBe(false);
    expect(validateHeaders([{ name: "X-Api-Key", value: "a\nb" }]).ok).toBe(false);
    expect(validateHeaders([{ name: "X-Api-Key", value: "a\0b" }]).ok).toBe(false);
    expect(validateHeaders([{ name: "X-Api-Key", value: "x".repeat(4097) }]).ok).toBe(false);
  });

  it("rejects duplicate names case-insensitively", () => {
    expect(validateHeaders([{ name: "X-Api-Key", value: "a" }, { name: "x-api-key", value: "b" }]).ok).toBe(false);
  });

  it("requires a value on create", () => {
    expect(validateHeaders([{ name: "X-Api-Key", value: "" }]).ok).toBe(false);
    expect(validateHeaders([{ name: "X-Api-Key" }]).ok).toBe(false);
  });

  it("keeps the stored value on update when the value is blank, drops absent names", () => {
    const existing = [
      { name: "X-Api-Key", value: "tok-abc" },
      { name: "X-Tenant", value: "acme" },
    ];
    const r = validateHeaders([{ name: "x-api-key" }], existing);
    expect(r).toEqual({ ok: true, headers: [{ name: "X-Api-Key", value: "tok-abc" }] });
  });

  it("errors on update when a NEW name has no value", () => {
    const r = validateHeaders([{ name: "X-New" }], [{ name: "X-Api-Key", value: "tok-abc" }]);
    expect(r.ok).toBe(false);
  });

  it("never echoes a value in its error text", () => {
    const r = validateHeaders([{ name: "Host", value: "tok-secret-123" }]);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("tok-secret-123");
  });
});

describe("validateHeaders hardening", () => {
  it("rejects control chars, DEL, non-Latin1 and whitespace-only values without echoing them", () => {
    for (const value of ["a\x01b", "a\x7fb", "pay\u20ac", "   ", "\t "]) {
      const r = validateHeaders([{ name: "X-Api-Key", value }]);
      expect(r.ok, JSON.stringify(value)).toBe(false);
      expect(JSON.stringify(r)).not.toContain(value.trim() || "\u0000never");
      expect(JSON.stringify(r)).toContain("invalid value");
    }
  });

  it("accepts exactly 4096 bytes and rejects 4097", () => {
    expect(validateHeaders([{ name: "X-Api-Key", value: "x".repeat(4096) }]).ok).toBe(true);
    expect(validateHeaders([{ name: "X-Api-Key", value: "x".repeat(4097) }]).ok).toBe(false);
  });

  it("denies a padded deny-listed name", () => {
    expect(validateHeaders([{ name: " Host ", value: "v" }]).ok).toBe(false);
  });

  it("drops omitted names on update and keeps blank as keep-stored", () => {
    const existing = [
      { name: "X-A", value: "1" },
      { name: "X-B", value: "2" },
    ];
    expect(validateHeaders([{ name: "X-B", value: "" }], existing)).toEqual({
      ok: true,
      headers: [{ name: "X-B", value: "2" }],
    });
    expect(validateHeaders([{ name: "X-B", value: "   " }], existing).ok).toBe(false);
  });
});

describe("headersToRecord / fingerprint", () => {
  it("builds a record and fingerprints order-independently", () => {
    const a = headersToRecord([{ name: "X-A", value: "1" }, { name: "X-B", value: "2" }]);
    const b = headersToRecord([{ name: "X-B", value: "2" }, { name: "X-A", value: "1" }]);
    expect(a).toEqual({ "X-A": "1", "X-B": "2" });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a value changes and does not contain the plaintext", () => {
    const f1 = fingerprint({ "X-A": "tok-abc" });
    const f2 = fingerprint({ "X-A": "tok-new" });
    expect(f1).not.toBe(f2);
    expect(f1).not.toContain("tok-abc");
  });
});
