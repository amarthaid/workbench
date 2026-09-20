import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PopoverSelect } from "./PopoverSelect";

const OPTIONS = [
  { value: 60, label: "1 minute" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
];

function setup(onChange = vi.fn()) {
  render(
    <div>
      <PopoverSelect value={300} options={OPTIONS} onChange={onChange} label="Expires after" />
      <p>outside</p>
    </div>
  );
  return { onChange, trigger: screen.getByRole("button", { name: "Expires after: 5 minutes" }) };
}

describe("PopoverSelect", () => {
  it("shows the current value closed, opens a listbox with it selected and focused", () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const selected = screen.getByRole("option", { name: "5 minutes" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(selected).toHaveFocus();
  });

  it("picks an option, closes, and returns focus to the trigger", () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "10 minutes" }));
    expect(onChange).toHaveBeenCalledWith(600);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("moves with arrow keys and closes on Escape without changing the value", () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "10 minutes" })).toHaveFocus();
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: "1 minute" })).toHaveFocus();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes on an outside click", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
