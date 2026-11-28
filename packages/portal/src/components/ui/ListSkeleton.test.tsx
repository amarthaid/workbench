import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ListSkeleton } from "./ListSkeleton";

describe("ListSkeleton", () => {
  it("renders the asked number of rows built on the real row class", () => {
    const { container } = render(<ListSkeleton rows={4} />);
    const rows = container.querySelectorAll(".ui-list-row.ui-list-skeleton-row");
    expect(rows).toHaveLength(4);
  });

  it("defaults to three rows and announces loading once", () => {
    const { container } = render(<ListSkeleton />);
    expect(container.querySelectorAll(".ui-list-skeleton-row")).toHaveLength(3);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveAccessibleName("Loading");
  });

  it("hides the placeholder bars from assistive technology", () => {
    const { container } = render(<ListSkeleton rows={1} />);
    for (const bar of container.querySelectorAll(".ui-list-skeleton-bar")) expect(bar).toHaveAttribute("aria-hidden", "true");
  });
});
