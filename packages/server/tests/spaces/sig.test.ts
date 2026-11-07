import { describe, it, expect } from "vitest";
import { mintSig, verifySig, SIG_TTL_MS } from "../../src/spaces/sig";

const USER = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

describe("spaces/sig", () => {
  it("round-trips the viewer id, including long ids", () => {
    const sig = mintSig("pr-timeline", USER, 1_000);
    expect(sig.split(".")).toHaveLength(3);
    const long = "u".repeat(200);
    expect(verifySig("pr-timeline", mintSig("pr-timeline", long, 1_000), 2_000)).toBe(long);
    expect(/^[A-Za-z0-9_.-]+$/.test(sig)).toBe(true);
    expect(verifySig("pr-timeline", sig, 2_000)).toBe(USER);
  });

  it("refuses another Space, expiry, tampering and junk", () => {
    const sig = mintSig("s1", USER, 1_000);
    expect(verifySig("s2", sig, 2_000)).toBeNull();
    expect(verifySig("s1", sig, 1_000 + SIG_TTL_MS)).toBeNull();
    const [e, u, m] = sig.split(".");
    expect(verifySig("s1", [e, Buffer.from("someone-else").toString("base64url"), m].join("."), 2_000)).toBeNull();
    expect(verifySig("s1", [Buffer.from(String(9e15)).toString("base64url"), u, m].join("."), 2_000)).toBeNull();
    expect(verifySig("s1", [e, u, m.slice(0, -2) + (m.endsWith("AA") ? "BB" : "AA")].join("."), 2_000)).toBeNull();
    for (const junk of ["", "a.b", "a.b.c.d", "...", "x".repeat(300)]) expect(verifySig("s1", junk, 2_000)).toBeNull();
  });
});
