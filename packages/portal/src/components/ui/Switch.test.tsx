import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Switch } from "./Switch";

function Harness({ disabled = false, onChange = vi.fn() }: { disabled?: boolean; onChange?: (v: boolean) => void }) {
  const [on, setOn] = useState(false);
  return (
    <>
      <span id="lbl">Delegate my access</span>
      <Switch
        checked={on}
        disabled={disabled}
        aria-labelledby="lbl"
        onChange={(v) => {
          setOn(v);
          onChange(v);
        }}
      />
    </>
  );
}

describe("Switch", () => {
  it("is a named switch that reports its state", () => {
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: "Delegate my access" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw).toHaveClass("is-on");
  });

  it("is a focusable native button, so Space and Enter toggle it", () => {
    render(<Harness />);
    const sw = screen.getByRole("switch");
    expect(sw.tagName).toBe("BUTTON");
    expect(sw).toHaveAttribute("type", "button");
    sw.focus();
    expect(sw).toHaveFocus();
  });

  it("does nothing when disabled", () => {
    const onChange = vi.fn();
    render(<Harness disabled onChange={onChange} />);
    const sw = screen.getByRole("switch");
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });
});
