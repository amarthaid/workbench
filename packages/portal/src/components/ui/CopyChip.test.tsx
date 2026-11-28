import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CopyChip } from "./CopyChip";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("CopyChip", () => {
  it("shows the text in a monospace chip with a copy icon", () => {
    render(<CopyChip text="{{vault:tok}}" label="Copy reference" />);
    const b = screen.getByRole("button", { name: "Copy reference" });
    expect(b).toHaveTextContent("{{vault:tok}}");
    expect(b.querySelector("svg")).not.toBeNull();
    expect(b.querySelector(".wb-mono")).not.toBeNull();
  });

  it("copies exactly the given text, then says Copied for 1.5 seconds", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<CopyChip text="{{vault:tok}}" label="Copy reference" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy reference" }));
    });
    expect(writeText).toHaveBeenCalledWith("{{vault:tok}}");
    expect(screen.getByRole("button")).toHaveTextContent("Copied");
    expect(screen.getByRole("button")).not.toHaveTextContent("{{vault:tok}}");
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByRole("button")).toHaveTextContent("Copied");
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.getByRole("button")).toHaveTextContent("{{vault:tok}}");
  });

  it("explains itself in a tooltip when one is given", () => {
    render(<CopyChip text="x" label="Copy reference" tooltip="Copies the reference, never the value" />);
    fireEvent.mouseEnter(screen.getByRole("button").parentElement!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Copies the reference, never the value");
  });

  it("selects the text and does not claim a copy when the clipboard is unavailable", async () => {
    render(<CopyChip text="{{vault:tok}}" label="Copy reference" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy reference" }));
    });
    expect(screen.getByRole("button")).not.toHaveTextContent("Copied");
    expect(window.getSelection()?.toString()).toBe("{{vault:tok}}");
  });

  it("falls back the same way when the write is refused", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<CopyChip text="{{vault:tok}}" label="Copy reference" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy reference" }));
    });
    expect(screen.getByRole("button")).not.toHaveTextContent("Copied");
    expect(window.getSelection()?.toString()).toBe("{{vault:tok}}");
  });
});
