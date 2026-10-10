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

describe("validateCookieRecipe url and malformed input", () => {
  const withStep = (step: unknown) =>
    ({ ...base, session: { dead: { status: [401] } }, reconnect: { steps: [step] } }) as unknown as CookieConfig;

  it.each([
    ["protocol-relative goto", { goto: "//evil.example.org/login" }],
    ["backslash goto", { goto: "/\\evil.example.org" }],
    ["javascript: goto", { goto: "javascript:alert(1)" }],
    ["file: goto", { goto: "file:///etc/passwd" }],
    ["data: goto", { goto: "data:text/html,x" }],
    ["malformed absolute goto", { goto: "http://" }],
    ["bare host/path waitUrl", { waitUrl: "app.example.com/x" }],
    ["protocol-relative waitUrl", { waitUrl: "//evil.example.org/" }],
    ["loginUrl as waitUrl", { waitUrl: "loginUrl" }],
  ])("rejects %s", (_n, step) => {
    expect(validateCookieRecipe(withStep(step)).length).toBeGreaterThan(0);
  });

  it.each([
    ["tab smuggled host", { goto: "/\t/evil.example.org/x" }],
    ["newline smuggled host", { goto: "/\n/evil.example.org" }],
    ["space in path", { goto: "/ /x" }],
    ["waitUrl absolute undeclared host", { waitUrl: "https://evil.example.org/x" }],
  ])("rejects %s", (_n, step) => {
    expect(validateCookieRecipe(withStep(step)).length).toBeGreaterThan(0);
  });

  it.each([
    ["missing targetDomain", { targetDomain: undefined }],
    ["numeric targetDomain", { targetDomain: 5 }],
    ["non-array cookieDomains", { cookieDomains: "a.example.com" }],
    ["non-array allowHosts", {}, { allowHosts: "x" }],
    ["non-array credentials", {}, { credentials: "x" }],
    ["null credential entry", {}, { credentials: [null] }],
    ["non-string credential key", {}, { credentials: [{ key: 1, label: "x" }] }],
    ["string timeoutMs", {}, { timeoutMs: "5" }],
    ["NaN timeoutMs", {}, { timeoutMs: NaN }],
  ])("returns errors without throwing: %s", (_n, authPatch, reconnectPatch) => {
    const auth = {
      ...base,
      session: { dead: { status: [401] } },
      ...authPatch,
      reconnect: { steps: [{ goto: "/x" }], ...(reconnectPatch ?? {}) },
    } as unknown as CookieConfig;
    let errs: string[] = [];
    expect(() => { errs = validateCookieRecipe(auth); }).not.toThrow();
    expect(errs.length).toBeGreaterThan(0);
  });

  it("accepts a single-slash path and an allowed absolute URL", () => {
    expect(validateCookieRecipe(withStep({ goto: "/login" }))).toEqual([]);
    expect(validateCookieRecipe(withStep({ waitUrl: "https://app.example.com/x" }))).toEqual([]);
  });

  it("returns errors instead of throwing on malformed input", () => {
    const run = (r: unknown) =>
      validateCookieRecipe({ ...base, session: { dead: { status: [401] } }, reconnect: r } as unknown as CookieConfig);
    expect(run({ steps: "x" }).join()).toMatch(/steps/);
    expect(run({ steps: [null] }).length).toBeGreaterThan(0);
    expect(run({ steps: [{ fill: "#p" }] }).length).toBeGreaterThan(0);
  });
});

describe("credentialRefs", () => {
  it("lists referenced keys", () => {
    expect(credentialRefs("{{cred:a}}-{{cred:b_2}}")).toEqual(["a", "b_2"]);
  });
});
