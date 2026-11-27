import { describe, it, expect } from "vitest";
import { bootConfigSchema, config, configSchema } from "../../src/config";

describe("REQUIRE_SIGNUP_APPROVAL", () => {
  it("is off by default", () => {
    expect(config.REQUIRE_SIGNUP_APPROVAL).toBe(false);
    expect(configSchema.parse({}).REQUIRE_SIGNUP_APPROVAL).toBe(false);
  });

  it("accepts true/false/1/0 and nothing else", () => {
    expect(configSchema.parse({ REQUIRE_SIGNUP_APPROVAL: "true" }).REQUIRE_SIGNUP_APPROVAL).toBe(true);
    expect(configSchema.parse({ REQUIRE_SIGNUP_APPROVAL: "1" }).REQUIRE_SIGNUP_APPROVAL).toBe(true);
    expect(configSchema.parse({ REQUIRE_SIGNUP_APPROVAL: "0" }).REQUIRE_SIGNUP_APPROVAL).toBe(false);
    expect(configSchema.safeParse({ REQUIRE_SIGNUP_APPROVAL: "yes" }).success).toBe(false);
  });

  it("is refused at boot with an empty ADMIN_EMAILS, so no signup is silently stranded", () => {
    for (const admins of [undefined, "", " , ,"]) {
      const result = bootConfigSchema.safeParse({ REQUIRE_SIGNUP_APPROVAL: "true", ...(admins === undefined ? {} : { ADMIN_EMAILS: admins }) });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].message).toContain("ADMIN_EMAILS");
    }
  });

  it("boots when someone can approve, or when the setting is off", () => {
    expect(bootConfigSchema.safeParse({ REQUIRE_SIGNUP_APPROVAL: "true", ADMIN_EMAILS: "admin@example.com" }).success).toBe(true);
    expect(bootConfigSchema.safeParse({ REQUIRE_SIGNUP_APPROVAL: "false" }).success).toBe(true);
    expect(bootConfigSchema.safeParse({}).success).toBe(true);
  });
});
