import { describe, it, expect, vi } from "vitest";
import type { PageHandle } from "../src/auth/browser-session";
import { waitForSelector, clickSelector, fillSelector, waitForUrl, StepError } from "../src/auth/reconnect/dom";

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

  // Fake: locate -> {x,y}; prepare (returnByValue:false) -> objectId or null;
  // callFunctionOn -> `deliver` (value, or a function that may throw).
  const fillPage = (opts: { prepare?: unknown; deliver?: unknown } = {}) =>
    page((m, params) => {
      if (m === "Runtime.evaluate") {
        if (params.returnByValue === false) return { result: opts.prepare === undefined ? { objectId: "obj-1" } : opts.prepare };
        return { result: { value: { x: 1, y: 1 } } };
      }
      if (m === "Runtime.callFunctionOn") {
        const d = opts.deliver === undefined ? "OK" : opts.deliver;
        if (typeof d === "function") return d();
        return { result: { value: d } };
      }
      return {};
    });
  const calls = (p: PageHandle) => (p.cdp.send as any).mock.calls as [string, any][];
  const sent = (p: PageHandle) => calls(p).map((c) => c[0]);
  const hosts = ["app.example.com"];

  it("fillSelector delivers the value only as a callFunctionOn argument", async () => {
    const p = fillPage();
    await fillSelector(p, "#pass", "pw-abc", 500, hosts);
    for (const [m, params] of calls(p)) {
      if (m === "Runtime.evaluate") expect(params.expression).not.toContain("pw-abc");
      if (m === "Runtime.callFunctionOn") {
        expect(params.functionDeclaration).not.toContain("pw-abc");
        expect(params.objectId).toBe("obj-1");
        expect(params.arguments).toEqual([{ value: "pw-abc" }, { value: hosts }]);
      }
    }
    expect(sent(p)).not.toContain("Input.insertText");
    expect(sent(p)).toContain("Runtime.callFunctionOn");
    expect(sent(p)).toContain("Runtime.releaseObject");
  });

  it("fillSelector rejects a non-editable/unfocused target (prepare null) without delivering", async () => {
    const p = fillPage({ prepare: { type: "object", subtype: "null", value: null } });
    const err = await fillSelector(p, "#x", "pw-abc", 300, hosts).catch((e) => e);
    expect(err.reason).toBe("SELECTOR_NOT_FOUND");
    expect(sent(p)).not.toContain("Runtime.callFunctionOn");
    expect(sent(p)).not.toContain("Input.insertText");
  });

  it("fillSelector rejects text= selectors without touching the page", async () => {
    const p = fillPage();
    const err = await fillSelector(p, "text=Login", "pw-abc", 300, hosts).catch((e) => e);
    expect(err.reason).toBe("SELECTOR_NOT_FOUND");
    expect(p.cdp.send).not.toHaveBeenCalled();
  });

  it("prepare expression focuses and clears via the native setter, without the value", async () => {
    const p = fillPage();
    await fillSelector(p, "#pass", "pw-abc", 300, hosts);
    const prep = calls(p).find(([m, a]) => m === "Runtime.evaluate" && a.returnByValue === false)![1].expression as string;
    expect(prep).toContain("focus()");
    expect(prep).toContain("getOwnPropertyDescriptor");
    expect(prep).not.toContain("pw-abc");
  });

  it("fillSelector maps a HOST result to HOST_NOT_ALLOWED", async () => {
    const p = fillPage({ deliver: "HOST" });
    const err = await fillSelector(p, "#x", "pw-abc", 300, hosts).catch((e) => e);
    expect(err.reason).toBe("HOST_NOT_ALLOWED");
    expect(sent(p)).not.toContain("Input.insertText");
  });

  it("fillSelector maps a destroyed context to BROWSER_ERROR", async () => {
    const p = fillPage({ deliver: () => { throw new Error("Cannot find context with specified id"); } });
    const err = await fillSelector(p, "#x", "pw-abc", 300, hosts).catch((e) => e);
    expect(err.reason).toBe("BROWSER_ERROR");
  });

  it("fillSelector maps an unexpected result to SELECTOR_NOT_FOUND", async () => {
    const p = fillPage({ deliver: "nope" });
    const err = await fillSelector(p, "#x", "pw-abc", 300, hosts).catch((e) => e);
    expect(err.reason).toBe("SELECTOR_NOT_FOUND");
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
