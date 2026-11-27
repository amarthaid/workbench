import { describe, it, expect } from "vitest";
import { arrangeSpaces, isNewForMe, RECENT_LIMIT } from "./arrange";
import { coverFor, coverInitial, hash } from "./cover";
import type { SpaceSummary } from "../spaces-api";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function s(name: string, over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    name,
    title: name,
    description: null,
    ownerEmail: "o@example.com",
    visibility: "org",
    updatedAt: NOW - 30 * DAY,
    mine: false,
    favorited: false,
    favorite_count: 0,
    last_opened_at: null,
    ...over,
  };
}

describe("arrangeSpaces", () => {
  it("orders favorites by when I last opened them, never opened last", () => {
    const r = arrangeSpaces([
      s("never", { favorited: true }),
      s("old", { favorited: true, last_opened_at: NOW - 5 * DAY }),
      s("new", { favorited: true, last_opened_at: NOW - 1 * DAY }),
    ]);
    expect(r.favorites.map((x) => x.name)).toEqual(["new", "old", "never"]);
  });

  it("does not let popularity decide the order: a heavily favorited Space gains no place", () => {
    const r = arrangeSpaces([
      s("quiet", { updatedAt: NOW - 1 * DAY, favorite_count: 0 }),
      s("famous", { updatedAt: NOW - 9 * DAY, favorite_count: 400 }),
    ]);
    expect(r.rest.map((x) => x.name)).toEqual(["quiet", "famous"]);
  });

  it("limits Recently opened, and the overflow joins the rest in update order", () => {
    const many = Array.from({ length: RECENT_LIMIT + 2 }, (_, i) => s(`s${i}`, { last_opened_at: NOW - i * 1000, updatedAt: NOW - i * DAY }));
    const r = arrangeSpaces(many);
    expect(r.recent).toHaveLength(RECENT_LIMIT);
    expect(r.rest.map((x) => x.name)).toEqual([`s${RECENT_LIMIT}`, `s${RECENT_LIMIT + 1}`]);
  });

  it("a favorite is in Favorites only, never also in Recently opened", () => {
    const r = arrangeSpaces([s("a", { favorited: true, last_opened_at: NOW })]);
    expect(r.favorites).toHaveLength(1);
    expect(r.recent).toHaveLength(0);
  });

  it("matches every word of the search against title, description, owner and name", () => {
    const list = [s("sprint-board", { title: "Sprint", description: "team velocity", ownerEmail: "ana@example.com" }), s("other")];
    expect(arrangeSpaces(list, { query: "velocity ana" }).rest.map((x) => x.name)).toEqual(["sprint-board"]);
    expect(arrangeSpaces(list, { query: "velocity nobody" }).rest).toEqual([]);
    expect(arrangeSpaces(list, { query: "SPRINT-BOARD" }).rest).toHaveLength(1);
  });
});

describe("isNewForMe", () => {
  it("is someone else's, recently updated, never opened by me", () => {
    expect(isNewForMe(s("a", { updatedAt: NOW - DAY }), NOW)).toBe(true);
    expect(isNewForMe(s("a", { updatedAt: NOW - DAY, mine: true }), NOW)).toBe(false);
    expect(isNewForMe(s("a", { updatedAt: NOW - DAY, last_opened_at: NOW - 1000 }), NOW)).toBe(false);
    expect(isNewForMe(s("a", { updatedAt: NOW - 15 * DAY }), NOW)).toBe(false);
  });
});

describe("cover", () => {
  it("is the same for the same name and does not follow the title", () => {
    expect(coverFor("pr-timeline")).toEqual(coverFor("pr-timeline"));
  });

  it("differs between names, and uses every pattern across a spread of names", () => {
    expect(coverFor("a").from).not.toBe(coverFor("b").from);
    const patterns = new Set(Array.from({ length: 60 }, (_, i) => coverFor(`space-${i}`).pattern));
    expect(patterns.size).toBe(4);
  });

  it("keeps lightness in the band where white text reads", () => {
    for (let i = 0; i < 50; i++) {
      const c = coverFor(`n${i}`);
      expect(c.from).toMatch(/^hsl\(\d+ 52% 38%\)$/);
      expect(c.to).toMatch(/^hsl\(\d+ 58% 30%\)$/);
    }
  });

  it("never uses a muddy hue for either colour", () => {
    const hueOf = (c: string) => Number(/^hsl\((\d+) /.exec(c)![1]);
    for (let i = 0; i < 400; i++) {
      const c = coverFor(`space-${i}`);
      for (const h of [hueOf(c.from), hueOf(c.to)]) expect(h < 20 || h > 100).toBe(true);
    }
  });

  it("hash is stable", () => {
    expect(hash("abc")).toBe(hash("abc"));
  });

  it("takes the initial from the first letter or digit of the title", () => {
    expect(coverInitial("  pr timeline")).toBe("P");
    expect(coverInitial("[A+] Growth")).toBe("A");
    expect(coverInitial("2026 plan")).toBe("2");
    expect(coverInitial("!!!")).toBe("S");
  });
});
