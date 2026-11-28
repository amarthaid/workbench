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

  describe("pending keys", () => {
    function Tracked({ run }: { run: (id: string) => void | Promise<unknown> }) {
      const undoable = useUndoableAction<string>({ run });
      return (
        <>
          <button onClick={() => undoable.schedule("report.csv", "f1", "key-1")}>delete</button>
          <button onClick={() => undoable.schedule("plain", "f2")}>plain</button>
          <span data-testid="pending">{[...undoable.pendingKeys].join(",")}</span>
          <span data-testid="is">{String(undoable.isPending("key-1"))}</span>
        </>
      );
    }
    const wrap = (run: (id: string) => void | Promise<unknown>) =>
      render(
        <ToastProvider>
          <Tracked run={run} />
        </ToastProvider>
      );

    it("marks the key pending at once and clears it on Undo", () => {
      wrap(vi.fn());
      fireEvent.click(screen.getByText("delete"));
      expect(screen.getByTestId("is")).toHaveTextContent("true");
      expect(screen.getByTestId("pending")).toHaveTextContent("key-1");
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getByTestId("is")).toHaveTextContent("false");
      expect(screen.getByTestId("pending")).toHaveTextContent("");
    });

    it("defaults the key to the label", () => {
      wrap(vi.fn());
      fireEvent.click(screen.getByText("plain"));
      expect(screen.getByTestId("pending")).toHaveTextContent("plain");
    });

    it("keeps the key pending while run is in flight and clears it once run settles", async () => {
      let finish!: () => void;
      const run = vi.fn(() => new Promise<void>((r) => (finish = r)));
      wrap(run);
      fireEvent.click(screen.getByText("delete"));
      await act(async () => {
        vi.advanceTimersByTime(5001);
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("is")).toHaveTextContent("true");
      await act(async () => {
        finish();
      });
      expect(screen.getByTestId("is")).toHaveTextContent("false");
    });

    it("clears the key when run rejects", async () => {
      wrap(vi.fn(async () => Promise.reject(new Error("nope"))));
      fireEvent.click(screen.getByText("delete"));
      await act(async () => {
        vi.advanceTimersByTime(5001);
      });
      expect(screen.getByTestId("is")).toHaveTextContent("false");
    });

    it("ignores a second schedule for a key that is already pending", () => {
      const run = vi.fn();
      wrap(run);
      fireEvent.click(screen.getByText("delete"));
      fireEvent.click(screen.getByText("delete"));
      expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(5001);
      });
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});
