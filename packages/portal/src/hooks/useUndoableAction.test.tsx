import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { ToastProvider } from "../components/ui/Toast";
import { useUndoableAction } from "./useUndoableAction";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Row({ run, delayMs }: { run: (id: string) => void; delayMs?: number }) {
  const undoable = useUndoableAction<string>({ run, delayMs });
  return <button onClick={() => undoable.schedule("report.csv", "f1")}>delete</button>;
}

function Page({ run, delayMs }: { run: (id: string) => void; delayMs?: number }) {
  const [shown, setShown] = useState(true);
  return (
    <ToastProvider>
      <button onClick={() => setShown(false)}>leave</button>
      {shown && <Row run={run} delayMs={delayMs} />}
    </ToastProvider>
  );
}

describe("useUndoableAction", () => {
  it("announces '<label> deleted.' with Undo and runs only after the delay", () => {
    const run = vi.fn();
    render(<Page run={run} />);
    fireEvent.click(screen.getByText("delete"));
    expect(screen.getByRole("status")).toHaveTextContent("report.csv deleted.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(run).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("f1");
    expect(screen.queryByText(/report.csv deleted/)).toBeNull();
  });

  it("honours a custom delay", () => {
    const run = vi.fn();
    render(<Page run={run} delayMs={1000} />);
    fireEvent.click(screen.getByText("delete"));
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("Undo cancels the action for good", () => {
    const run = vi.fn();
    render(<Page run={run} />);
    fireEvent.click(screen.getByText("delete"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByText(/report.csv deleted/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("leaving the page cancels a pending action without running it", () => {
    const run = vi.fn();
    render(<Page run={run} />);
    fireEvent.click(screen.getByText("delete"));
    fireEvent.click(screen.getByText("leave"));
    expect(screen.queryByText(/report.csv deleted/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("unmounting the provider cancels a pending action without running it", () => {
    const run = vi.fn();
    const { unmount } = render(<Page run={run} />);
    fireEvent.click(screen.getByText("delete"));
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps several pending actions apart", () => {
    const run = vi.fn();
    function Two() {
      const undoable = useUndoableAction<string>({ run });
      return (
        <>
          <button onClick={() => undoable.schedule("a.csv", "a")}>a</button>
          <button onClick={() => undoable.schedule("b.csv", "b")}>b</button>
        </>
      );
    }
    render(
      <ToastProvider>
        <Two />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("a"));
    fireEvent.click(screen.getByText("b"));
    fireEvent.click(screen.getAllByRole("button", { name: "Undo" })[0]);
    act(() => {
      vi.advanceTimersByTime(5001);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("b");
  });
});
