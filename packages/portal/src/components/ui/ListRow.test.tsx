import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ListRow } from "./ListRow";
import { RowAction, RowActions } from "./RowActions";

describe("ListRow", () => {
  it("shows the icon tile, title, subtitle, chips and actions", () => {
    render(
      <ListRow
        icon={<svg data-testid="ico" />}
        title="report.csv"
        subtitle="12 KB, written 2h ago"
        chips={<span>expires in 3d</span>}
        actions={<RowAction>Download</RowAction>}
      />
    );
    expect(screen.getByTestId("ico").closest(".ui-list-row-tile")).not.toBeNull();
    expect(screen.getByText("report.csv")).toBeInTheDocument();
    expect(screen.getByText("12 KB, written 2h ago")).toBeInTheDocument();
    expect(screen.getByText("expires in 3d")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });

  it("renders a leading slot such as a checkbox before the tile", () => {
    render(<ListRow leading={<input type="checkbox" aria-label="Select report.csv" />} icon={<svg />} title="report.csv" />);
    const row = screen.getByText("report.csv").closest(".ui-list-row") as HTMLElement;
    const box = within(row).getByRole("checkbox", { name: "Select report.csv" });
    expect(box.closest(".ui-list-row-leading")).not.toBeNull();
    expect(box.compareDocumentPosition(screen.getByText("report.csv")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is not a click target: the row has no button role and each control is its own button", () => {
    const onOpen = vi.fn();
    const onDownload = vi.fn();
    render(<ListRow title="notes" onOpen={onOpen} actions={<RowAction onClick={onDownload}>Download</RowAction>} />);
    const row = screen.getByText("notes").closest(".ui-list-row") as HTMLElement;
    expect(row).not.toHaveAttribute("role");
    expect(row).not.toHaveAttribute("onclick");
    fireEvent.click(row);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "notes" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // No button holds another button.
    for (const b of screen.getAllByRole("button")) expect(within(b).queryByRole("button")).toBeNull();
  });

  it("keeps the title plain text when there is nothing to open", () => {
    render(<ListRow title="notes" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("RowAction", () => {
  it("is a native text button", () => {
    const onClick = vi.fn();
    render(<RowAction onClick={onClick}>Revoke</RowAction>);
    const b = screen.getByRole("button", { name: "Revoke" });
    expect(b).toHaveAttribute("type", "button");
    expect(b).toHaveClass("ui-row-action");
    expect(b).not.toHaveClass("ui-row-action-danger");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalled();
  });

  it("marks the danger variant as red text, not a filled button", () => {
    render(<RowAction danger>Delete</RowAction>);
    const b = screen.getByRole("button", { name: "Delete" });
    expect(b).toHaveClass("ui-row-action", "ui-row-action-danger");
    expect(b.className).not.toMatch(/ui-button/);
  });

  it("marks a group as revealed on hover so the stylesheet can also reveal it on focus", () => {
    render(
      <RowActions reveal>
        <RowAction>Delete</RowAction>
      </RowActions>
    );
    expect(screen.getByRole("button", { name: "Delete" }).parentElement).toHaveClass("ui-row-actions", "is-reveal");
  });

  it("keeps a revealed action in the tab order", () => {
    render(
      <RowActions reveal>
        <RowAction>Delete</RowAction>
      </RowActions>
    );
    const b = screen.getByRole("button", { name: "Delete" });
    b.focus();
    expect(b).toHaveFocus();
    expect(b).not.toHaveAttribute("tabindex", "-1");
    expect(b).not.toHaveAttribute("hidden");
  });
});
