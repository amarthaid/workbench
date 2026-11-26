import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

// Rules the geometry decision depends on. A future edit that reintroduces a
// pill button or a drop shadow on a static surface fails here rather than
// quietly drifting the whole interface back.
describe("portal stylesheet geometry", () => {
  it("uses one radius everywhere, with no capsule exception", () => {
    const users = css
      .split("}")
      .filter((block) => block.includes("--radius-full"))
      .map((block) => block.split("{")[0].trim());
    expect(users).toEqual([]);
  });

  it("casts a shadow only on the modal, the only thing that genuinely floats above the page", () => {
    const users = css
      .split("}")
      .filter((block) => /box-shadow\s*:/.test(block))
      .map((block) => block.split("{")[0].trim());
    expect(users.length).toBeGreaterThan(0);
    for (const selector of users) {
      expect(selector).toMatch(/ui-modal/);
    }
  });

  it("carries no leftover ornament rules", () => {
    for (const dead of [".eyebrow", ".headline", ".card-index", ".card-top", ".filter-chip", ".blinker", ".ticker"]) {
      expect(css).not.toContain(dead);
    }
  });
});

describe("switch and segmented control", () => {
  const blocks = (needle: string) =>
    css
      .split("}")
      .filter((block) => block.split("{")[0].includes(needle))
      .map((block) => block.split("{")[1] ?? "");

  it("draw their focus ring in the text colour, so it shows on an accent fill", () => {
    for (const sel of [".ui-switch:focus-visible", ".ui-segmented button:focus-visible"]) {
      const rules = blocks(sel).join(";");
      expect(rules).toMatch(/outline:\s*2px solid var\(--text\)/);
      expect(rules).not.toContain("var(--accent)");
    }
  });

  it("use the --on-accent token, not a literal white, on the accent fill", () => {
    for (const sel of [".ui-switch", ".ui-segmented"]) {
      for (const rules of blocks(sel)) expect(rules).not.toMatch(/#fff\b/i);
    }
    expect(blocks(".ui-segmented button[aria-pressed=\"true\"]").join(";")).toContain("var(--on-accent)");
  });
});

