import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Admin from "./Admin";

describe("Admin page", () => {
  it("has a page title and an Overview tab selected", () => {
    render(<Admin />);
    expect(screen.getByRole("heading", { level: 1, name: "Admin" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  });
});
