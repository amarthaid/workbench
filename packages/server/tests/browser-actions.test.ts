import { describe, it, expect, vi } from "vitest";
import {
  navigate,
  screenshot,
  click,
  typeText,
  pressKey,
  scroll,
  readText,
  evaluate,
  EVALUATE_MAX_CHARS,
  type WarmSession,
} from "../src/auth/browser-session";

function sessionWithCdp(send: ReturnType<typeof vi.fn>): WarmSession {
  return { cdp: { send } } as unknown as WarmSession;
}

describe("browser actions", () => {
  it("navigate issues Page.navigate and returns url + title", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") return { result: { value: "Example" } };
      return {};
    });
    const out = await navigate(sessionWithCdp(send), "https://example.com");
    expect(send).toHaveBeenCalledWith("Page.navigate", { url: "https://example.com" });
    expect(out).toEqual({ url: "https://example.com", title: "Example" });
  });

  it("screenshot downscales via clip.scale and returns a jpeg image", async () => {
    const send = vi.fn(async (m: string) => {
      if (m === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 2000, clientHeight: 1000 } };
      return { data: "JPEGDATA" };
    });
    const s = { cdp: { send } } as any;
    const out = await screenshot(s, { maxWidth: 1000 });
    expect(send).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        format: "jpeg",
        quality: 60,
        clip: expect.objectContaining({ x: 0, y: 0, width: 2000, height: 1000, scale: 0.5 }),
      })
    );
    expect(out).toEqual({ _mcpImage: { data: "JPEGDATA", mimeType: "image/jpeg" } });
  });

  it("screenshot returns { unchanged: true } when bytes are identical", async () => {
    const send = vi.fn(async (m: string) =>
      m === "Page.getLayoutMetrics" ? { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } } : { data: "SAME" }
    );
    const s = { cdp: { send } } as any;
    const a = await screenshot(s);
    const b = await screenshot(s);
    expect(a).toHaveProperty("_mcpImage");
    expect(b).toEqual({ unchanged: true });
  });

  it("screenshot never upscales (scale capped at 1)", async () => {
    const send = vi.fn(async (m: string) =>
      m === "Page.getLayoutMetrics" ? { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } } : { data: "X" }
    );
    const s = { cdp: { send } } as any;
    await screenshot(s, { maxWidth: 1000 });
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", expect.objectContaining({ clip: expect.objectContaining({ scale: 1 }) }));
  });

  it("screenshot honors format:png (no quality, png mime)", async () => {
    const send = vi.fn(async (m: string) =>
      m === "Page.getLayoutMetrics" ? { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } } : { data: "PNGDATA" }
    );
    const s = { cdp: { send } } as any;
    const out = await screenshot(s, { format: "png" });
    const call = send.mock.calls.find((c: any[]) => c[0] === "Page.captureScreenshot")!;
    expect(call[1].format).toBe("png");
    expect(call[1].quality).toBeUndefined();
    expect(out).toEqual({ _mcpImage: { data: "PNGDATA", mimeType: "image/png" } });
  });

  it("click dispatches press + release at coords", async () => {
    const send = vi.fn(async () => ({}));
    await click(sessionWithCdp(send), 100, 200, "left");
    expect(send).toHaveBeenNthCalledWith(1, "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 100, y: 200, button: "left", clickCount: 1 }));
    expect(send).toHaveBeenNthCalledWith(2, "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseReleased", x: 100, y: 200, button: "left" }));
  });

  it("typeText inserts text", async () => {
    const send = vi.fn(async () => ({}));
    await typeText(sessionWithCdp(send), "hello");
    expect(send).toHaveBeenCalledWith("Input.insertText", { text: "hello" });
  });

  it("pressKey sends keyDown + keyUp with modifiers for a chord", async () => {
    const send = vi.fn(async () => ({}));
    await pressKey(sessionWithCdp(send), "ctrl+a");
    expect(send).toHaveBeenNthCalledWith(1, "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "rawKeyDown", modifiers: 2 }));
    expect(send).toHaveBeenNthCalledWith(2, "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyUp", modifiers: 2 }));
  });

  it("pressKey types a bare printable char via keyDown+text", async () => {
    const send = vi.fn(async () => ({}));
    await pressKey(sessionWithCdp(send), "a");
    expect(send).toHaveBeenNthCalledWith(1, "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyDown", text: "a" }));
  });

  it("scroll sends a mouseWheel with downward delta", async () => {
    const send = vi.fn(async () => ({}));
    await scroll(sessionWithCdp(send), "down", 600);
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseWheel", deltaY: 600 }));
  });

  it("readText returns innerText", async () => {
    const send = vi.fn(async () => ({ result: { value: "Hello world" } }));
    const out = await readText({ cdp: { send } } as any);
    expect(send).toHaveBeenCalledWith("Runtime.evaluate", expect.objectContaining({ expression: "document.body.innerText", returnByValue: true }));
    expect(out).toEqual({ text: "Hello world", truncated: false });
  });

  it("readText truncates past maxChars and flags it", async () => {
    const send = vi.fn(async () => ({ result: { value: "abcdefghij" } }));
    const out = await readText({ cdp: { send } } as any, 4);
    expect(out).toEqual({ text: "abcd", truncated: true });
  });

  it("evaluate returns the expression's value by value, awaiting promises", async () => {
    const send = vi.fn(async () => ({ result: { type: "number", value: 42 } }));
    const out = await evaluate({ cdp: { send } } as any, "Promise.resolve(42)");
    expect(send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: "Promise.resolve(42)", returnByValue: true, awaitPromise: true })
    );
    expect(out).toEqual({ value: 42, type: "number" });
  });

  it("evaluate reports a thrown exception instead of a value", async () => {
    const send = vi.fn(async () => ({
      result: { type: "object", subtype: "error" },
      exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is not a function\n  at <anonymous>" } },
    }));
    const out = await evaluate({ cdp: { send } } as any, "x()");
    expect(out).toEqual({ error: "EVALUATION_FAILED", detail: "TypeError: x is not a function\n  at <anonymous>" });
  });

  it("evaluate refuses a result too large to hand back rather than truncating it", async () => {
    const send = vi.fn(async () => ({ result: { type: "string", value: "x".repeat(EVALUATE_MAX_CHARS + 1) } }));
    const out = await evaluate({ cdp: { send } } as any, "document.documentElement.outerHTML");
    expect(out).toMatchObject({ error: "RESULT_TOO_LARGE" });
    expect(out).not.toHaveProperty("value");
  });
});
