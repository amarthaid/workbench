import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tooltip } from "./Tooltip";

function setup(onClick = vi.fn()) {
  render(
    <Tooltip label="Register an MCP server">
      <button aria-label="New custom app" onClick={onClick}>+</button>
    </Tooltip>
  );
  return { onClick, trigger: screen.getByRole("button", { name: "New custom app" }) };
}

describe("Tooltip", () => {
  it("stays hidden until the pointer arrives, then describes the trigger", () => {
    const { trigger } = setup();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(trigger.parentElement!);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Register an MCP server");
    expect(trigger).toHaveAttribute("aria-describedby", tip.id);
    fireEvent.mouseLeave(trigger.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows on keyboard focus and hides on Escape", () => {
    const { trigger } = setup();
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("does not swallow the trigger's click", () => {
    const { onClick, trigger } = setup();
    fireEvent.mouseEnter(trigger.parentElement!);
    fireEvent.click(trigger);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
