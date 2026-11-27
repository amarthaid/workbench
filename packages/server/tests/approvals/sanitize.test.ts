import { describe, it, expect } from "vitest";
import { sanitizeText, TEXT_MAX } from "../../src/approvals/sanitize";

describe("sanitizeText", () => {
  it("returns an empty string for anything that is not a string", () => {
    expect(sanitizeText(undefined)).toBe("");
    expect(sanitizeText(null)).toBe("");
    expect(sanitizeText(42)).toBe("");
    expect(sanitizeText({ a: 1 })).toBe("");
  });

  it("strips control characters and collapses whitespace runs, newlines included", () => {
    expect(sanitizeText("a\u0000b\u0007c")).toBe("abc");
    expect(sanitizeText("line one\r\nline two\t\tend")).toBe("line one line two end");
    expect(sanitizeText("  padded  ")).toBe("padded");
  });

  it("strips bidi overrides, isolates and zero-width characters", () => {
    expect(sanitizeText("a‮b‬c")).toBe("abc"); // right-to-left override and pop
    expect(sanitizeText("a⁦b⁩c")).toBe("abc"); // isolates
    expect(sanitizeText("a​b‍c﻿d")).toBe("abcd");
  });

  it("keeps ordinary text, accents and emoji-free symbols", () => {
    expect(sanitizeText("Please add me, thanks (urgent) & café")).toBe("Please add me, thanks (urgent) & café");
  });

  it("caps by code point so a surrogate pair is never cut in half", () => {
    const long = "x".repeat(TEXT_MAX + 50);
    expect(sanitizeText(long)).toHaveLength(TEXT_MAX);
    const astral = "\u{1D11E}".repeat(TEXT_MAX + 5); // a musical symbol outside the BMP
    const out = sanitizeText(astral);
    expect(Array.from(out)).toHaveLength(TEXT_MAX);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
  });

  it("honours a smaller cap", () => {
    expect(sanitizeText("abcdef", 3)).toBe("abc");
  });
});
