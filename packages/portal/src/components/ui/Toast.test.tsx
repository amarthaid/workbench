import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast";

function Trigger({ onAction = vi.fn() }: { onAction?: () => void }) {
  const toast = useToast();
  return (
    <button onClick={() => toast.show({ message: "Report deleted.", actionLabel: "Undo", onAction })}>go</button>
  );
}

describe("Toast", () => {
  it("shows a message in a polite live region with its action", () => {
    const onAction = vi.fn();
    render(
      <ToastProvider>
        <Trigger onAction={onAction} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("go"));
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("Report deleted.");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Report deleted.")).toBeNull();
  });

  it("dismisses on its own after the duration when one is given", () => {
    vi.useFakeTimers();
    function T() {
      const toast = useToast();
      return <button onClick={() => toast.show({ message: "Saved.", durationMs: 3000 })}>go</button>;
    }
    render(
      <ToastProvider>
        <T />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("Saved.")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3001);
    });
    expect(screen.queryByText("Saved.")).toBeNull();
    vi.useRealTimers();
  });

  it("throws a clear error when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});
