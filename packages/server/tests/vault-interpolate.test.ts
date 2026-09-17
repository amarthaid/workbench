import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { putSecret } from "../src/vault/store";
import {
  findVaultRefs,
  substituteVaultRefs,
  scrubVaultValues,
  scrubString,
  resolveVaultRefs,
  VaultScrubError,
} from "../src/vault/interpolate";

describe("findVaultRefs", () => {
  it("collects distinct names from nested strings only", () => {
    const args = {
      a: "{{vault:pw}}",
      b: ["x", "Bearer {{vault:tok}} and {{vault:pw}}"],
      c: { d: { e: "{{vault:third.v2-x}}" }, n: 1, t: true, z: null },
      "{{vault:key_is_not_scanned}}": "v",
      bad: "{{vault:Upper}} {{vault:}} {{vault:a b}}",
    };
    expect(findVaultRefs(args)).toEqual(["pw", "third.v2-x", "tok"]);
  });
  it("handles non-object input", () => {
    expect(findVaultRefs(undefined)).toEqual([]);
    expect(findVaultRefs("{{vault:x}}")).toEqual(["x"]);
  });
});

describe("substituteVaultRefs", () => {
  const values = new Map([
    ["pw", "hunter2"],
    ["tok", "tok-abc"],
  ]);
  it("replaces whole, embedded and repeated refs", () => {
    const out = substituteVaultRefs(
      { a: "{{vault:pw}}", b: "Bearer {{vault:tok}}/{{vault:tok}}", c: [{ d: "{{vault:pw}}!" }] },
      values
    );
    expect(out).toEqual({ a: "hunter2", b: "Bearer tok-abc/tok-abc", c: [{ d: "hunter2!" }] });
  });
  it("does not mutate its input", () => {
    const input = { a: "{{vault:pw}}", nested: { b: ["{{vault:pw}}"] } };
    const snapshot = JSON.parse(JSON.stringify(input));
    substituteVaultRefs(input, values);
    expect(input).toEqual(snapshot);
  });
  it("leaves unknown refs and non-strings alone", () => {
    const out = substituteVaultRefs({ a: "{{vault:missing}}", n: 5, b: false }, values);
    expect(out).toEqual({ a: "{{vault:missing}}", n: 5, b: false });
  });
});

describe("scrub", () => {
  const sub = new Map([
    ["pw", "hunter2"],
    ["long", "hunter2-extended"],
  ]);
  it("replaces plaintext in strings, longest value first", () => {
    expect(scrubString("x hunter2-extended y hunter2", sub)).toBe("x {{vault:long}} y {{vault:pw}}");
  });
  it("walks JSON-shaped results", () => {
    const out = scrubVaultValues(
      { text: "pw is hunter2", arr: ["hunter2", 1, null], deep: { v: "hunter2-extended" } },
      sub
    );
    expect(out).toEqual({
      text: "pw is {{vault:pw}}",
      arr: ["{{vault:pw}}", 1, null],
      deep: { v: "{{vault:long}}" },
    });
  });
  it("is a no-op with nothing substituted", () => {
    const r = { a: "hunter2" };
    expect(scrubVaultValues(r, new Map())).toBe(r);
  });
  it("passes non-JSON values through", () => {
    const fn = () => 1;
    expect(scrubVaultValues(fn, sub)).toBe(fn);
    expect(scrubVaultValues(undefined, sub)).toBeUndefined();
  });
  it("scrubs error messages", () => {
    expect(scrubString("401 for token hunter2", sub)).toBe("401 for token {{vault:pw}}");
  });
  it("catches values with JSON-escaped characters", () => {
    const m = new Map([["q", 'say "hi"\\now']]);
    expect(scrubVaultValues({ t: 'x say "hi"\\now y' }, m)).toEqual({ t: "x {{vault:q}} y" });
  });

  it("scrubs a scalar-looking secret embedded inside a string with punctuation", () => {
    const m = new Map([["port", "5432"]]);
    expect(scrubVaultValues({ msg: "port: 5432, ok" }, m)).toEqual({ msg: "port: {{vault:port}}, ok" });
  });

  it("scrubs a scalar-looking secret that lands as a bare JSON number", () => {
    const m = new Map([["port", "5432"]]);
    expect(scrubVaultValues({ port: 5432 }, m)).toEqual({ port: "{{vault:port}}" });
  });

  it("matches a numeric secret exactly, never a longer number that merely contains it", () => {
    const m = new Map([["p", "12"]]);
    expect(scrubVaultValues({ n: 12, m: 1234, s: "x12y" }, m)).toEqual({
      n: "{{vault:p}}",
      m: 1234,
      s: "x{{vault:p}}y",
    });
  });

  it("scrubs a boolean-looking secret both as a bare boolean and inside a string", () => {
    const m = new Map([["flag", "true"]]);
    expect(scrubVaultValues({ ok: true, s: "true" }, m)).toEqual({
      ok: "{{vault:flag}}",
      s: "{{vault:flag}}",
    });
  });

  it("scrubs a secret that appears as an object key", () => {
    const m = new Map([["pw", "hunter2"]]);
    expect(scrubVaultValues({ hunter2: 1 }, m)).toEqual({ "{{vault:pw}}": 1 });
  });

  it("fails closed with VaultScrubError instead of returning the unscrubbed result", () => {
    const m = new Map([["pw", "x"]]);
    expect(() => scrubVaultValues({ big: 1n }, m)).toThrow(VaultScrubError);
    try {
      scrubVaultValues({ big: 1n }, m);
      throw new Error("expected scrubVaultValues to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultScrubError);
      expect((e as VaultScrubError).code).toBe("VAULT_SCRUB_FAILED");
    }
  });

  describe("single pass over a combined entry list", () => {
    // These entries model meta-tools.ts's merge of a call's own substitutions
    // with the recent-values ring: same name, two different values. Two
    // sequential `scrubString` passes (once per source) would let the SHORT
    // value eat part of the LONG one first if it happened to run first, or
    // leave a partial match behind — a single alternated regex over the
    // combined, longest-first list must not.
    it("replaces the longer value whole rather than leaving a partial match from a shorter one under the same name", () => {
      const entries: Array<[string, string]> = [
        ["pw", "abc"],
        ["pw", "abcdefghij"],
      ];
      expect(scrubString("page shows abcdefghij", entries)).toBe("page shows {{vault:pw}}");
    });

    it("replaces the longer value whole rather than leaving the shorter one's remainder under a different name", () => {
      const entries: Array<[string, string]> = [
        ["user", "alice"],
        ["email", "alice@example.com"],
      ];
      expect(scrubString("contact alice@example.com now", entries)).toBe("contact {{vault:email}} now");
    });

    it("does not corrupt a placeholder it just inserted with a later entry's value", () => {
      // "vault" is a substring of the "{{vault:pw}}" placeholder syntax
      // itself. A sequential per-entry pass that re-scans its own growing
      // output would find that "vault" and mangle the placeholder it just
      // produced. A single pass over the ORIGINAL string can't, because
      // "vault" never appears in the original text.
      const entries: Array<[string, string]> = [
        ["pw", "hunter2"],
        ["v", "vault"],
      ];
      const out = scrubString("saw hunter2 here", entries);
      expect(out).toBe("saw {{vault:pw}} here");
      expect(out).not.toContain("{{vault:v}}");
      expect(out.match(/\{\{vault:/g)).toHaveLength(1);
    });
  });

  describe("substringOk: whole-string-only entries", () => {
    it("replaces a whole-string-only value only when it is the entire string, never inside prose", () => {
      const entries: Array<[string, string]> = [["pin", "12"]];
      const substringOk = new Set<string>(); // "12" is not in it: whole-string only
      expect(scrubString("12", entries, substringOk)).toBe("{{vault:pin}}");
      expect(scrubString("there are 12 items", entries, substringOk)).toBe("there are 12 items");
    });

    it("still substring-scrubs a value that IS marked substring-eligible", () => {
      const entries: Array<[string, string]> = [["longpw", "hunter2-long-value"]];
      const substringOk = new Set(["hunter2-long-value"]);
      expect(scrubString("value is hunter2-long-value here", entries, substringOk)).toBe(
        "value is {{vault:longpw}} here"
      );
    });

    it("applies the same whole-string rule to scalar leaves and object structure via scrubVaultValues", () => {
      const entries: Array<[string, string]> = [["pin", "12"], ["longpw", "hunter2-long-value"]];
      const substringOk = new Set(["hunter2-long-value"]);
      const out = scrubVaultValues(
        { n: 12, s: "there are 12 items", t: "12", u: "value is hunter2-long-value here" },
        entries,
        substringOk
      );
      expect(out).toEqual({
        n: "{{vault:pin}}",
        s: "there are 12 items",
        t: "{{vault:pin}}",
        u: "value is {{vault:longpw}} here",
      });
    });
  });
});

describe("resolveVaultRefs", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM user_vaults");
    await putSecret("u1", "pw", "hunter2");
  });
  it("resolves from the store and reports what it substituted", async () => {
    const r = await resolveVaultRefs("u1", { text: "{{vault:pw}}" });
    expect(r.args).toEqual({ text: "hunter2" });
    expect([...r.substituted]).toEqual([["pw", "hunter2"]]);
  });
  it("returns the same args and empty map when there are no refs", async () => {
    const args = { text: "plain" };
    const r = await resolveVaultRefs("u1", args);
    expect(r.args).toBe(args);
    expect(r.substituted.size).toBe(0);
  });
  it("throws VAULT_SECRET_NOT_FOUND for an unknown name", async () => {
    await expect(resolveVaultRefs("u1", { text: "{{vault:nope}}" })).rejects.toMatchObject({
      code: "VAULT_SECRET_NOT_FOUND",
      secretName: "nope",
    });
  });
  it("does not resolve another user's secret", async () => {
    await expect(resolveVaultRefs("u2", { text: "{{vault:pw}}" })).rejects.toMatchObject({
      code: "VAULT_SECRET_NOT_FOUND",
    });
  });
});
