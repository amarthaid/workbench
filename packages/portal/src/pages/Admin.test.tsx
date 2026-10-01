import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Admin from "./Admin";

vi.mock("../components/admin/OverviewTab", () => ({ default: () => <p>overview-body</p> }));

describe("Admin page", () => {
  it("has a page title and an Overview tab selected, showing the overview", () => {
    render(<Admin />);
    expect(screen.getByRole("heading", { level: 1, name: "Admin" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("overview-body")).toBeInTheDocument();
  });
});
