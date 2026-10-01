import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Admin from "./Admin";

vi.mock("../components/admin/OverviewTab", () => ({ default: () => <p>overview-body</p> }));
vi.mock("../components/admin/UsersTab", () => ({ default: () => <p>users-body</p> }));
vi.mock("../components/admin/ConfigTab", () => ({ default: () => <p>config-body</p> }));

describe("Admin page", () => {
  it("has a title and opens on the Overview tab", () => {
    render(<Admin />);
    expect(screen.getByRole("heading", { level: 1, name: "Admin" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("overview-body")).toBeInTheDocument();
  });

  it("switches between Overview, Users and Config", () => {
    render(<Admin />);
    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    expect(screen.getByText("users-body")).toBeInTheDocument();
    expect(screen.queryByText("overview-body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Config" }));
    expect(screen.getByText("config-body")).toBeInTheDocument();
  });
});
