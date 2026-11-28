import { describe, expect, it } from "vitest";
import { appTier, compareApps } from "./app-order";

const app = (name: string, extra: object = {}) => ({ name, displayName: name, ...extra });

describe("app order", () => {
  it("puts connectable apps, then custom apps, then built-ins", () => {
    const list = [app("vault"), app("custom:1", { custom: true }), app("slack"), app("browser"), app("github")];
    expect(list.sort(compareApps).map((a) => a.name)).toEqual(["github", "slack", "custom:1", "browser", "vault"]);
  });

  it("tiers", () => {
    expect(appTier(app("gmail"))).toBe(0);
    expect(appTier(app("x", { custom: true }))).toBe(1);
    for (const n of ["browser", "jots", "files", "vault", "spaces"]) expect(appTier(app(n))).toBe(2);
  });
});
