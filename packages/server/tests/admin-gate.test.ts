import { describe, it, expect, beforeEach } from "vitest";
import { config, parseAdminEmails } from "../src/config";
import { isAdminEmail } from "../src/auth/admin";

describe("parseAdminEmails", () => {
  it("splits on commas, trims, and lowercases", () => {
    expect(parseAdminEmails(" Admin@Example.com , ops@example.com ")).toEqual([
      "admin@example.com",
      "ops@example.com",
    ]);
  });

  it("drops empty entries", () => {
    expect(parseAdminEmails("")).toEqual([]);
    expect(parseAdminEmails(",, ,")).toEqual([]);
  });
});

describe("config.ADMIN_EMAILS", () => {
  it("defaults to an empty list, so admin is off", () => {
    expect(config.ADMIN_EMAILS).toEqual([]);
  });
});

describe("isAdminEmail", () => {
  beforeEach(() => {
    config.ADMIN_EMAILS = ["admin@example.com"];
  });

  it("matches case-insensitively", () => {
    expect(isAdminEmail("Admin@Example.com")).toBe(true);
  });

  it("rejects an email that is not listed", () => {
    expect(isAdminEmail("dev@example.com")).toBe(false);
  });

  it("rejects null, undefined and empty even when the list is empty", () => {
    config.ADMIN_EMAILS = [];
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });

  it("tolerates a config object with no ADMIN_EMAILS at all", () => {
    (config as { ADMIN_EMAILS?: string[] }).ADMIN_EMAILS = undefined;
    expect(isAdminEmail("admin@example.com")).toBe(false);
  });
});
