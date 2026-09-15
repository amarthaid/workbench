import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(<Modal open={false} onClose={vi.fn()}>Body</Modal>);
    expect(screen.queryByText("Body")).not.toBeInTheDocument();
  });

  it("renders title, body, and footer when open", () => {
    render(
      <Modal open onClose={vi.fn()} title="Connect" footer={<button>Go</button>}>
        Body text
      </Modal>
    );
    expect(screen.getByText("Connect")).toBeInTheDocument();
    expect(screen.getByText("Body text")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose}>Body</Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on backdrop click but not on content click", () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose}>Body text</Modal>);
    fireEvent.click(screen.getByText("Body text"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves focus into the content panel on open", () => {
    render(<Modal open onClose={vi.fn()}>Body</Modal>);
    expect(document.activeElement).toHaveClass("ui-modal");
  });

  it("returns focus to the trigger on close", () => {
    // Matters for a dialog the page outlives — a delete confirmation that is
    // cancelled must not strand a keyboard user on document.body.
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">Delete</button>
          <Modal open={open} onClose={vi.fn()}>Body</Modal>
        </>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByRole("button", { name: "Delete" });
    trigger.focus();

    rerender(<Harness open />);
    expect(document.activeElement).toHaveClass("ui-modal");

    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(trigger);
  });

  it("does not throw when the trigger is gone by close time", () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          {open && <button type="button">Transient</button>}
          <Modal open={open} onClose={vi.fn()}>Body</Modal>
        </>
      );
    }
    const { rerender } = render(<Harness open />);
    expect(() => rerender(<Harness open={false} />)).not.toThrow();
  });
});
