import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TypedNameConfirm } from "./TypedNameConfirm";

function setup(over: Partial<React.ComponentProps<typeof TypedNameConfirm>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <TypedNameConfirm
      title="Delete API_TOKEN?"
      name="API_TOKEN"
      nameLabel="secret name"
      confirmLabel="Delete secret"
      impact={<ul><li>Apps using it lose access.</li></ul>}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    >
      <p>This cannot be undone.</p>
    </TypedNameConfirm>
  );
  return { onConfirm, onCancel };
}

const button = () => screen.getByRole("button", { name: "Delete secret" });
const type = (v: string) => fireEvent.change(screen.getByLabelText(/Type the secret name/), { target: { value: v } });

describe("TypedNameConfirm", () => {
  it("shows the title, the body, the impact slot and the name to type", () => {
    setup();
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete API_TOKEN?");
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(screen.getByText("Apps using it lose access.")).toBeInTheDocument();
    expect(screen.getByText("API_TOKEN", { selector: "code" })).toBeInTheDocument();
  });

  it("keeps the danger button off until the exact name is typed, case-sensitively", () => {
    const { onConfirm } = setup();
    expect(button()).toBeDisabled();
    expect(button()).toHaveClass("ui-button-danger");
    type("api_token");
    expect(button()).toBeDisabled();
    type("API_TOKEN ");
    expect(button()).toBeDisabled();
    fireEvent.click(button());
    expect(onConfirm).not.toHaveBeenCalled();
    type("API_TOKEN");
    expect(button()).toBeEnabled();
    fireEvent.click(button());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms on Enter only when the name matches", () => {
    const { onConfirm } = setup();
    const input = screen.getByLabelText(/Type the secret name/);
    fireEvent.submit(input.closest("form")!);
    expect(onConfirm).not.toHaveBeenCalled();
    type("API_TOKEN");
    fireEvent.submit(input.closest("form")!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels from the Cancel button", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("while busy: shows the busy label, locks both buttons and ignores a second confirm", () => {
    const { onConfirm, onCancel } = setup({ busy: true, busyLabel: "Deleting..." });
    type("API_TOKEN");
    const b = screen.getByRole("button", { name: "Deleting..." });
    expect(b).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText(/Type the secret name/).closest("form")!);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows an error message", () => {
    setup({ error: "Could not delete. Try again." });
    expect(screen.getByText("Could not delete. Try again.")).toBeInTheDocument();
  });
});
