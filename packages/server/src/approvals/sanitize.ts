// Free text a requester or a checker types (the request message, the decision
// note). It is shown to other people, so it is stored plain: capped, with
// control characters and the invisible format characters (bidi overrides,
// zero-width joiners) stripped, and runs of whitespace collapsed. The portal
// renders it as text only. It is never placed in an audit row or in describe().

export const TEXT_MAX = 280;

export function sanitizeText(input: unknown, max: number = TEXT_MAX): string {
  if (typeof input !== "string") return "";
  const cleaned = input
    // Line breaks and tabs become spaces first, so words do not run together
    // when the control characters are stripped below.
    .replace(/[\r\n\t\v\f]+/g, " ")
    // Cc: control characters. Cf: format characters, which includes the bidi
    // overrides, isolates, zero-width space/joiners and the BOM. Line and
    // paragraph separators (Zl, Zp) are whitespace and collapse below.
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  // Cap by code point so a surrogate pair is never cut in half.
  const points = Array.from(cleaned);
  return points.length > max ? points.slice(0, max).join("").trimEnd() : cleaned;
}
