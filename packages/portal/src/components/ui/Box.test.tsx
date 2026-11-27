import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Box, BoxRow } from "./Box";

describe("Box", () => {
  it("renders children without a header when no title or action is given", () => {
    render(<Box><BoxRow>only row</BoxRow></Box>);
    expect(screen.getByText("only row")).toHaveClass("ui-box-row");
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("renders the title as a heading and the action beside it", () => {
    render(
      <Box title="Recent activity" action={<a href="/activity">View all</a>}>
        <BoxRow>a row</BoxRow>
      </Box>
    );
    expect(screen.getByRole("heading", { name: "Recent activity" })).toHaveClass("ui-box-title");
    expect(screen.getByRole("link", { name: "View all" })).toBeInTheDocument();
  });

  it("puts titleAside next to the title, on the left, apart from the action, and out of the heading", () => {
    const { container } = render(
      <Box title="GitHub" titleAside={<span>Connected</span>} action={<button type="button">Allow all</button>}>
        <BoxRow>a row</BoxRow>
      </Box>
    );
    const heading = container.querySelector(".ui-box-heading") as HTMLElement;
    expect(within(heading).getByRole("heading", { name: "GitHub" })).toBeInTheDocument();
    expect(within(heading).getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "GitHub" })).not.toHaveTextContent("Connected");
    expect(heading).not.toContainElement(screen.getByRole("button", { name: "Allow all" }));
    expect(container.querySelector(".ui-box-action")).toContainElement(screen.getByRole("button", { name: "Allow all" }));
  });

  it("appends a caller className to the box element", () => {
    const { container } = render(<Box className="extra">body</Box>);
    expect(container.querySelector(".ui-box")).toHaveClass("extra");
  });
});
