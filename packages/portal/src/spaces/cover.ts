// A Space has no picture of its own, and a screenshot would show one viewer's
// private data to everyone, so each gets a generated cover. It is derived from
// the Space's name, not its title: renaming a Space must not change how people
// recognise it.

export type CoverPattern = "dots" | "lines" | "rings" | "grid";

export interface Cover {
  /** Two colours for a diagonal gradient. */
  from: string;
  to: string;
  angle: number;
  pattern: CoverPattern;
}

const PATTERNS: readonly CoverPattern[] = ["dots", "lines", "rings", "grid"];

/** FNV-1a: small, stable, and spreads similar names apart. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** FNV leaves its high bits weak for short strings, so finish with a murmur-style mix before slicing bits off. */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// Hues that stay clean at this lightness. Orange through olive (about 20 to
// 100 degrees) goes to brown and mud when darkened enough for white text, so
// neither colour of a cover may land there.
const HUES = [345, 158, 172, 188, 202, 216, 232, 250, 268, 286, 304, 324] as const;
const MUDDY_FROM = 20;
const MUDDY_TO = 100;

const muddy = (hue: number) => hue >= MUDDY_FROM && hue <= MUDDY_TO;

export function coverFor(name: string): Cover {
  const h = mix(hash(name));
  const hue = HUES[h % HUES.length];
  // The second colour sits 18 to 42 degrees round the wheel: related, never
  // the same. If that lands in the muddy band, go the other way round.
  const shift = 18 + ((h >>> 9) % 25);
  let hue2 = (hue + shift) % 360;
  if (muddy(hue2)) hue2 = (hue - shift + 360) % 360;
  return {
    // Lightness stays in a band where white text reads at 4.5:1 or better.
    from: `hsl(${hue} 52% 38%)`,
    to: `hsl(${hue2} 58% 30%)`,
    angle: 110 + ((h >>> 14) % 80),
    pattern: PATTERNS[(h >>> 20) % PATTERNS.length],
  };
}

/** The letter shown on a cover: the first letter or digit of the title. */
export function coverInitial(title: string): string {
  const m = title.match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : "S").toUpperCase();
}
