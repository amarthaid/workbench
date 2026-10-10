import { describe, it, expect, vi } from "vitest";
import type { PageHandle } from "../src/auth/browser-session";
import { waitForSelector, clickSelector, fillSelector, waitForUrl, StepError } from "../src/auth/reconnect/dom";

const allow = (h: string) => h === "app.example.com";

function page(send: (method: string, params?: any) => any): PageHandle {
  return { cdp: { send: vi.fn(async (m: string, p?: any) => send(m, p)) } } as unknown as PageHandle;
}

describe("reconnect dom", () => {
  it("polls until the element appears", async () => {
    let calls = 0;
    const p = page((m) => {
      if (m !== "Runtime.evaluate") return {};
      calls += 1;
      return { result: { value: calls < 3 ? null : { x: 10, y: 20 } } };
    });
    await expect(waitForSelector(p, "#user", 2000)).resolves.toEqual({ x: 10, y: 20 });
    expect(calls).toBe(3);
  });

  it("throws SELECTOR_NOT_FOUND after the timeout", async () => {
    const p = page(() => ({ result: { value: null } }));
    const err = await waitForSelector(p, "#nope", 200).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.reason).toBe("SELECTOR_NOT_FOUND");
  });

  it("clickSelector dispatches a mouse press at the element centre", async () => {
    const p = page((m) => (m === "Runtime.evaluate" ? { result: { value: { x: 5, y: 6 } } } : {}));
    await clickSelector(p, "text=Sign in", 500);
    expect(p.cdp.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.objectContaining({ type: "mousePressed", x: 5, y: 6 }));
  });

  it("fillSelector never puts the value into evaluated JS", async () => {
    const p = page((m, params) =>
      m === "Runtime.evaluate"
        ? { result: { value: params.expression.includes("focus()") ? { ok: true, host: "app.example.com" } : { x: 1, y: 1 } } }
        : {}
    );
    await fillSelector(p, "#pass", "pw-abc", 500, allow);
    const calls = (p.cdp.send as any).mock.calls as [string, any][];
    for (const [m, params] of calls) {
      if (m === "Runtime.evaluate") expect(params.expression).not.toContain("pw-abc");
    }
    expect(calls).toContainEqual(["Input.insertText", { text: "pw-abc" }]);
  });

  it("waitForUrl resolves on prefix match and times out otherwise", async () => {
    const p = page(() => ({ result: { value: "https://app.example.com/home?x=1" } }));
    await expect(waitForUrl(p, "https://app.example.com/home", 300)).resolves.toBeUndefined();
    const err = await waitForUrl(p, "https://app.example.com/other", 200).catch((e) => e);
    expect(err.reason).toBe("TIMEOUT");
  });

  it("waitForUrl accepts a path prefix", async () => {
    const p = page(() => ({ result: { value: "https://app.example.com/home" } }));
    await expect(waitForUrl(p, "/home", 300)).resolves.toBeUndefined();
  });

  const fillPage = (prep: unknown) =>
    page((m, params) =>
      m === "Runtime.evaluate"
        ? { result: { value: params.expression.includes("focus()") ? prep : { x: 1, y: 1 } } }
        : {}
    );
  const sent = (p: PageHandle) => ((p.cdp.send as any).mock.calls as [string, any][]).map((c) => c[0]);

  it("fillSelector rejects a non-editable target and never inserts", async () => {
    const p = fillPage({ ok: false, why: "not-editable" });
    const err = await fillSelector(p, "#x", "pw-abc", 300, allow).catch((e) => e);
    expect(err.reason).toBe("SELECTOR_NOT_FOUND");
    expect(sent(p)).not.toContain("Input.insertText");
  });

  it("fillSelector rejects when focus was lost and never inserts", async () => {
    const p = fillPage({ ok: false });
    const err = await fillSelector(p, "#x", "pw-abc", 300, allow).catch((e) => e);
    expect(err.reason).toBe("SELECTOR_NOT_FOUND");
    expect(sent(p)).not.toContain("Input.insertText");
  });

  it("fillSelector rejects text= selectors without touching the page", async () => {
    const p = fillPage({ ok: true, host: "app.example.com" });
    const err = await fillSelector(p, "text=Login", "pw-abc", 300, allow).catch((e) => e);
    expect(err.reason).toBe("SELECTOR_NOT_FOUND");
    expect(p.cdp.send).not.toHaveBeenCalled();
  });

  it("prepare expression focuses and clears via the native setter, without the value", async () => {
    const p = fillPage({ ok: true, host: "app.example.com" });
    await fillSelector(p, "#pass", "pw-abc", 300, allow);
    const exprs = ((p.cdp.send as any).mock.calls as [string, any][])
      .filter(([m]) => m === "Runtime.evaluate")
      .map(([, a]) => a.expression as string);
    const prep = exprs.find((e) => e.includes("focus()"))!;
    expect(prep).toContain("getOwnPropertyDescriptor");
    expect(prep).not.toContain("pw-abc");
  });

  it("fillSelector refuses a disallowed host and never inserts", async () => {
    const p = fillPage({ ok: true, host: "evil.example.org" });
    const err = await fillSelector(p, "#x", "pw-abc", 300, allow).catch((e) => e);
    expect(err.reason).toBe("HOST_NOT_ALLOWED");
    expect(sent(p)).not.toContain("Input.insertText");
  });

  it("waitForUrl does not confuse look-alike origins with the prefix", async () => {
    for (const href of ["https://app.example.com.evil.org/", "https://app.example.com@evil.org/"]) {
      const p = page(() => ({ result: { value: href } }));
      const err = await waitForUrl(p, "https://app.example.com", 200).catch((e) => e);
      expect(err.reason).toBe("TIMEOUT");
    }
    const p = page(() => ({ result: { value: "https://app.example.com/home?x" } }));
    await expect(waitForUrl(p, "https://app.example.com/home", 200)).resolves.toBeUndefined();
    await expect(waitForUrl(p, "https://app.example.com", 200)).resolves.toBeUndefined();
  });
});
