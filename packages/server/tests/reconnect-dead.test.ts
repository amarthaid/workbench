import { describe, it, expect } from "vitest";
import { matchesDead } from "../src/auth/reconnect/dead";

const r = (status: number, location?: string) =>
  new Response(null, { status, headers: location ? { location } : {} });
const URL_ = "https://app.example.com/api/x";

describe("matchesDead", () => {
  it("matches a listed status", () => {
    expect(matchesDead(r(401), { status: [401] }, URL_)).toBe(true);
  });
  it("ignores an unlisted status", () => {
    expect(matchesDead(r(403), { status: [401] }, URL_)).toBe(false);
    expect(matchesDead(r(200), { status: [401] }, URL_)).toBe(false);
  });
  it("with redirectTo, a 3xx must point at that path", () => {
    const rule = { status: [302], redirectTo: "/login" };
    expect(matchesDead(r(302, "/login?next=/x"), rule, URL_)).toBe(true);
    expect(matchesDead(r(302, "https://app.example.com/login"), rule, URL_)).toBe(true);
    expect(matchesDead(r(302, "/dashboard"), rule, URL_)).toBe(false);
    expect(matchesDead(r(302), rule, URL_)).toBe(false);
  });
  it("redirectTo does not constrain non-3xx statuses", () => {
    expect(matchesDead(r(401), { status: [401, 302], redirectTo: "/login" }, URL_)).toBe(true);
  });
});
