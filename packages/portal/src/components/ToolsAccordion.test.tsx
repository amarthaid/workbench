import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolsAccordion } from "./ToolsAccordion";
import type { SpaceTool } from "../spaces-api";

const tool = (i: number, app = "Acme", over: Partial<SpaceTool> = {}): SpaceTool => ({
  name: `tool_${i}`,
  integration: app.toLowerCase(),
  integrationName: app,
  effect: "read",
  description: `Does thing ${i}`,
  ...over,
});

describe("ToolsAccordion", () => {
  it("puts a space before the chips in an app header's accessible name", () => {
    render(<ToolsAccordion tools={[tool(1), tool(2), tool(3, "Acme", { effect: "write" }), tool(4, "Demo")]} />);
    expect(screen.getByRole("button", { name: "Acme, 2 reads, 1 write" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Demo, 1 read" })).toBeInTheDocument();
  });

  it("puts a space before the effect badge in a tool row's accessible name", () => {
    render(<ToolsAccordion tools={[tool(1), tool(2, "Demo")]} />);
    expect(screen.getByRole("button", { name: "tool_1, Reads" })).toBeInTheDocument();
  });

  it("does not repeat the summary chips on the app header when there is a single app", () => {
    const { container } = render(<ToolsAccordion tools={[tool(1), tool(2, "Acme", { effect: "write" })]} />);
    const head = screen.getByRole("button", { name: "Acme" });
    expect(head).not.toHaveTextContent("read");
    expect(head).not.toHaveTextContent("write");
    expect(head.querySelector(".space-detail-chips")).toBeNull();
    expect(container.querySelector(".space-detail-tool-summary")).toHaveTextContent("1 read");
  });

  it("does not repeat them when singleApp is forced", () => {
    render(<ToolsAccordion singleApp tools={[tool(1), tool(2, "Demo")]} />);
    expect(screen.getByRole("button", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Demo" })).toBeInTheDocument();
  });

  it("keeps the per-app chips with two or more apps", () => {
    render(<ToolsAccordion tools={[tool(1), tool(2, "Demo")]} />);
    expect(screen.getByRole("button", { name: "Acme, 1 read" }).querySelector(".space-detail-chips")).not.toBeNull();
  });

  it("opens the first app of three or more only, and every app of two or fewer", () => {
    const { unmount } = render(<ToolsAccordion tools={[tool(1), tool(2, "Demo"), tool(3, "Other")]} />);
    expect(screen.getByRole("button", { name: /^Acme/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Demo/ })).toHaveAttribute("aria-expanded", "false");
    unmount();
    render(<ToolsAccordion tools={[tool(1), tool(2, "Demo")]} />);
    expect(screen.getByRole("button", { name: /^Demo/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("can open or close every app on request", () => {
    const three = [tool(1), tool(2, "Demo"), tool(3, "Other")];
    const { unmount } = render(<ToolsAccordion tools={three} defaultOpen="all" />);
    expect(screen.getByRole("button", { name: /^Other/ })).toHaveAttribute("aria-expanded", "true");
    unmount();
    render(<ToolsAccordion tools={three} defaultOpen="none" />);
    expect(screen.getByRole("button", { name: /^Acme/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("expands a tool row to its markdown description and effect sentence", () => {
    render(<ToolsAccordion tools={[tool(1, "Acme", { description: "**Note** first" })]} />);
    const row = screen.getByRole("button", { name: /tool_1/ });
    fireEvent.click(row);
    expect(screen.getByText("Note").tagName).toBe("STRONG");
    expect(screen.getByText("Only reads data. Never changes anything.")).toBeInTheDocument();
  });

  it("shows a missing tool as a static row", () => {
    render(<ToolsAccordion tools={[tool(1, "Acme", { missing: true, effect: undefined })]} />);
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tool_1/ })).toBeNull();
  });
});
