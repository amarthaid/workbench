import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApprovalRow, DELEGATED_WARNING } from "./ApprovalRow";

const NOW = Math.floor(Date.now() / 1000);

function setup(over: Partial<React.ComponentProps<typeof ApprovalRow>> = {}) {
  const onApprove = vi.fn();
  const onReject = vi.fn();
  render(
    <ul>
      <ApprovalRow who="ana@example.com" createdAt={NOW} message="Hello" onApprove={onApprove} onReject={onReject} {...over} />
    </ul>
  );
  return { onApprove, onReject };
}

describe("ApprovalRow", () => {
  it("renders the requester's message as plain text, never as markup", () => {
    const evil = '<img src=x onerror="alert(1)"> **bold** <b>hi</b>';
    const { container } = render(
      <ul>
        <ApprovalRow who="ana@example.com" createdAt={NOW} message={evil} onApprove={vi.fn()} onReject={vi.fn()} />
      </ul>
    );
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("says so when there is no message", () => {
    setup({ message: null });
    expect(screen.getByText("No message.")).toBeInTheDocument();
  });

  it("approves in one click", () => {
    const { onApprove } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Approve ana@example.com" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("uses the label it is given", () => {
    setup({ approveLabel: "Enable" });
    expect(screen.getByRole("button", { name: "Enable ana@example.com" })).toBeInTheDocument();
  });

  it("rejects only after an optional note step, and Cancel puts the row back", () => {
    const { onReject } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Reject ana@example.com" }));
    expect(onReject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Approve ana@example.com" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reject ana@example.com" }));
    const note = screen.getByLabelText("Note for ana@example.com (optional)");
    expect(note).toHaveFocus();
    fireEvent.change(note, { target: { value: "not this time" } });
    fireEvent.click(screen.getByRole("button", { name: "Send rejection to ana@example.com" }));
    expect(onReject).toHaveBeenCalledWith("not this time");
  });

  it("rejects with Enter in the note field and allows an empty note", () => {
    const { onReject } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Reject ana@example.com" }));
    fireEvent.keyDown(screen.getByLabelText(/Note for/), { key: "Enter" });
    expect(onReject).toHaveBeenCalledWith("");
  });

  it("shows the warning next to the buttons and ties it to Approve", () => {
    setup({ warning: DELEGATED_WARNING });
    const warn = screen.getByText("This Space runs with your connected apps. Approving lets this person use them.");
    expect(warn).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve ana@example.com" })).toHaveAttribute("aria-describedby", warn.id);
  });

  it("disables both decisions while busy", () => {
    setup({ busy: true });
    expect(screen.getByRole("button", { name: "Approve ana@example.com" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject ana@example.com" })).toBeDisabled();
  });
});
