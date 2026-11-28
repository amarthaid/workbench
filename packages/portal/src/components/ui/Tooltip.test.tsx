import { describe, it, expect, vi, afterEach } from "vitest";
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

function rectAt(left: number, width = 100) {
  return () => ({ left, right: left + width, top: 0, bottom: 20, width, height: 20, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
}

describe("Tooltip placement", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is centered, with no shift when it fits", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(rectAt(200));
    render(
      <Tooltip label="Hello" placement="top">
        <button type="button">x</button>
      </Tooltip>
    );
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("tooltip").style.getPropertyValue("--tip-shift")).toBe("0px");
    fireEvent.blur(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shifts right when it would spill past the left edge", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(rectAt(-30));
    render(
      <Tooltip label="Hello" placement="top">
        <button type="button">x</button>
      </Tooltip>
    );
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("tooltip").style.getPropertyValue("--tip-shift")).toBe("38px");
  });

  it("shifts left when it would spill past the right edge", () => {
    const w = document.documentElement.clientWidth || window.innerWidth;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(rectAt(w - 50));
    render(
      <Tooltip label="Hello" placement="top">
        <button type="button">x</button>
      </Tooltip>
    );
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("tooltip").style.getPropertyValue("--tip-shift")).toBe("-58px");
  });
});
