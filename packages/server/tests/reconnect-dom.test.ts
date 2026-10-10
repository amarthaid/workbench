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

  it("fillSelector never puts the value into evaluated JS", async () => {
    const p = page((m) => (m === "Runtime.evaluate" ? { result: { value: { x: 1, y: 1 } } } : {}));
    await fillSelector(p, "#pass", "pw-abc", 500);
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
});
