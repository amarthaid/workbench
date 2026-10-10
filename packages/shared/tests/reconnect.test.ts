import { describe, it, expect } from "vitest";
import { validateCookieRecipe, credentialRefs } from "../src/reconnect";
import type { CookieConfig } from "../src/types";

const base: CookieConfig = {
  type: "cookie",
  loginUrl: "https://app.example.com/login",
  targetDomain: "app.example.com",
  cookieDomains: ["app.example.com"],
};

describe("validateCookieRecipe", () => {
  it("accepts a cookie config without recipe blocks", () => {
    expect(validateCookieRecipe(base)).toEqual([]);
  });

  it("accepts an SSO recipe", () => {
    expect(validateCookieRecipe({
      ...base,
      session: { probe: { path: "/api/me", alive: [200] }, dead: { status: [401, 302] } },
      reconnect: {
        allowHosts: ["idp.example.net"],
        steps: [
          { goto: "loginUrl" },
          { click: "text=Sign in with SSO" },
          { click: "[data-email]", optional: true, timeoutMs: 3000 },
          { waitUrl: "https://app.example.com/home" },
        ],
      },
    })).toEqual([]);
  });

  it("accepts a password recipe", () => {
    expect(validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: {
        credentials: [{ key: "username", label: "Username" }, { key: "password", label: "Password", secret: true }],
        steps: [
          { goto: "loginUrl" },
          { fill: "#user", value: "{{cred:username}}" },
          { fill: "#pass", value: "{{cred:password}}" },
          { press: "Enter" },
          { waitUrl: "/" },
        ],
      },
    })).toEqual([]);
  });

  it("rejects reconnect without session.dead", () => {
    const errs = validateCookieRecipe({ ...base, reconnect: { steps: [{ goto: "loginUrl" }] } });
    expect(errs.join()).toMatch(/session\.dead/);
  });

  it("rejects an empty step list", () => {
    const errs = validateCookieRecipe({ ...base, session: { dead: { status: [401] } }, reconnect: { steps: [] } });
    expect(errs.join()).toMatch(/steps/);
  });

  it("rejects {{cred:x}} outside a fill value", () => {
    const errs = validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: { credentials: [{ key: "u", label: "U" }], steps: [{ goto: "/login?u={{cred:u}}" }] },
    });
    expect(errs.join()).toMatch(/only allowed in fill/);
  });

  it("rejects an undeclared credential key", () => {
    const errs = validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: { steps: [{ fill: "#p", value: "{{cred:password}}" }] },
    });
    expect(errs.join()).toMatch(/undeclared credential "password"/);
  });

  it("rejects goto to an undeclared host", () => {
    const errs = validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: { steps: [{ goto: "https://evil.example.org/login" }] },
    });
    expect(errs.join()).toMatch(/evil\.example\.org/);
  });

  it("rejects timeoutMs above 120000", () => {
    const errs = validateCookieRecipe({
      ...base,
      session: { dead: { status: [401] } },
      reconnect: { timeoutMs: 500_000, steps: [{ goto: "loginUrl" }] },
    });
    expect(errs.join()).toMatch(/timeoutMs/);
  });
});

describe("credentialRefs", () => {
  it("lists referenced keys", () => {
    expect(credentialRefs("{{cred:a}}-{{cred:b_2}}")).toEqual(["a", "b_2"]);
  });
});
