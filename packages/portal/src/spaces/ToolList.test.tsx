import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SpaceToolList, defaultApproval, effectLabel } from "./ToolList";
import type { SpaceTool } from "../spaces-api";

const tool = (over: Partial<SpaceTool> & { name: string }): SpaceTool => ({
  integration: "github",
  integrationName: "GitHub",
  connected: true,
  ...over,
});

const READ = tool({ name: "github_list_prs", effect: "read" });
const WRITE = tool({ name: "github_create_issue", effect: "write", approval: "auto", approvalEditable: true });
const DESTROY = tool({ name: "github_merge_pr", effect: "destructive", approval: "ask", approvalEditable: true });
const SHEET_WRITE = tool({
  name: "sheets_append_row",
  integration: "sheets",
  integrationName: "Sheets",
  effect: "write",
  approval: "auto",
  approvalEditable: true,
});
const MISSING = tool({ name: "github_gone", effect: "destructive", missing: true, approval: "ask", approvalEditable: false });

describe("effectLabel", () => {
  it("is a pure effect label", () => {
    expect(effectLabel(READ).label).toBe("Reads");
    expect(effectLabel(WRITE).label).toBe("Writes");
    expect(effectLabel(DESTROY).label).toBe("Deletes or changes");
    expect(effectLabel(tool({ name: "x", effect: "sideways" })).label).toBe("Deletes or changes");
    expect(effectLabel(tool({ name: "x" })).label).toBe("Deletes or changes");
  });
});

describe("defaultApproval", () => {
  it("is auto for a write and ask for anything else that is not a read", () => {
    expect(defaultApproval(WRITE)).toBe("auto");
    expect(defaultApproval(DESTROY)).toBe("ask");
    expect(defaultApproval(tool({ name: "x" }))).toBe("ask");
  });
});

describe("editable mode", () => {
  it("shows a control on each non-read row, reflecting the mode", () => {
    render(<SpaceToolList tools={[READ, WRITE, DESTROY]} approvals={{}} onApprovalChange={vi.fn()} />);
    const w = screen.getByRole("group", { name: "Approval for github_create_issue" });
    expect(within(w).getByRole("button", { name: "Always allow" })).toHaveAttribute("aria-pressed", "true");
    const d = screen.getByRole("group", { name: "Approval for github_merge_pr" });
    expect(within(d).getByRole("button", { name: "Ask first" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("group", { name: "Approval for github_list_prs" })).toBeNull();
  });

  it("uses the local choice over the tool's mode", () => {
    render(
      <SpaceToolList tools={[WRITE]} approvals={{ github_create_issue: "ask" }} onApprovalChange={vi.fn()} />
    );
    const w = screen.getByRole("group", { name: "Approval for github_create_issue" });
    expect(within(w).getByRole("button", { name: "Ask first" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reports a change for that tool", () => {
    const onChange = vi.fn();
    render(<SpaceToolList tools={[WRITE, DESTROY]} approvals={{}} onApprovalChange={onChange} />);
    fireEvent.click(
      within(screen.getByRole("group", { name: "Approval for github_merge_pr" })).getByRole("button", { name: "Always allow" })
    );
    expect(onChange).toHaveBeenCalledWith({ github_merge_pr: "auto" });
  });

  it("has no control on a missing tool", () => {
    render(<SpaceToolList tools={[MISSING]} approvals={{}} onApprovalChange={vi.fn()} />);
    expect(screen.queryByRole("group", { name: /Approval for/ })).toBeNull();
  });

  it("box Allow all: on when every editable non-read tool is auto, turning on sends all auto", () => {
    const onChange = vi.fn();
    render(<SpaceToolList tools={[READ, WRITE, DESTROY]} approvals={{}} onApprovalChange={onChange} />);
    const sw = screen.getByRole("switch", { name: "Allow all for GitHub" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith({ github_create_issue: "auto", github_merge_pr: "auto" });
  });

  it("box Allow all off restores each tool's default, not all ask", () => {
    const onChange = vi.fn();
    render(
      <SpaceToolList
        tools={[WRITE, DESTROY]}
        approvals={{ github_create_issue: "auto", github_merge_pr: "auto" }}
        onApprovalChange={onChange}
      />
    );
    const sw = screen.getByRole("switch", { name: "Allow all for GitHub" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith({ github_create_issue: "auto", github_merge_pr: "ask" });
  });

  it("shows the hint with a single box's own Allow all, and no top-level switch", () => {
    render(<SpaceToolList tools={[WRITE, DESTROY]} approvals={{}} onApprovalChange={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "Allow all for GitHub" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Allow all" })).toBeNull();
    expect(screen.getByText("Actions run without asking you, even after this Space's page changes.")).toBeInTheDocument();
  });

  it("shows the hint only once with several boxes", () => {
    render(<SpaceToolList tools={[WRITE, SHEET_WRITE]} approvals={{}} onApprovalChange={vi.fn()} />);
    expect(screen.getAllByText("Actions run without asking you, even after this Space's page changes.")).toHaveLength(1);
  });

  it("top-level Allow all spans boxes, with its hint, only when there is more than one box", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SpaceToolList tools={[WRITE, DESTROY]} approvals={{}} onApprovalChange={onChange} />);
    expect(screen.queryByRole("switch", { name: "Allow all" })).toBeNull();
    rerender(<SpaceToolList tools={[WRITE, DESTROY, SHEET_WRITE]} approvals={{}} onApprovalChange={onChange} />);
    expect(screen.getByText("Actions run without asking you, even after this Space's page changes.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Allow all" }));
    expect(onChange).toHaveBeenCalledWith({
      github_create_issue: "auto",
      github_merge_pr: "auto",
      sheets_append_row: "auto",
    });
    onChange.mockClear();
    rerender(
      <SpaceToolList
        tools={[WRITE, DESTROY, SHEET_WRITE]}
        approvals={{ github_create_issue: "auto", github_merge_pr: "auto", sheets_append_row: "auto" }}
        onApprovalChange={onChange}
      />
    );
    const top = screen.getByRole("switch", { name: "Allow all" });
    expect(top).toHaveAttribute("aria-checked", "true");
    fireEvent.click(top);
    expect(onChange).toHaveBeenCalledWith({
      github_create_issue: "auto",
      github_merge_pr: "ask",
      sheets_append_row: "auto",
    });
  });

  it("shows no Allow all when no tool can be changed", () => {
    render(<SpaceToolList tools={[READ, MISSING]} approvals={{}} onApprovalChange={vi.fn()} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/Actions run without asking you/)).toBeNull();
  });
});

describe("read-only mode", () => {
  it("shows badges and the owner line, no controls", () => {
    const ro = (t: SpaceTool): SpaceTool => ({ ...t, approvalEditable: false });
    render(<SpaceToolList tools={[READ, ro(WRITE), ro(DESTROY), MISSING]} hideConnection />);
    expect(screen.getByText("The owner decides which actions ask first.")).toBeInTheDocument();
    expect(screen.getByText("Runs without asking")).toBeInTheDocument();
    expect(screen.getAllByText("Asks first")).toHaveLength(2);
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows no approval badge on a tool the server gave no mode (never runs for this viewer)", () => {
    const NEVER = tool({ name: "github_set_secret", effect: "write", delegable: false });
    render(<SpaceToolList tools={[NEVER, { ...WRITE, approvalEditable: false }]} hideConnection />);
    const row = screen.getByText("github_set_secret").closest(".space-tool-row") as HTMLElement;
    expect(within(row).queryByText("Runs without asking")).toBeNull();
    expect(within(row).queryByText("Asks first")).toBeNull();
    expect(within(row).getByText("Writes")).toBeInTheDocument();
  });

  it("omits the viewer wording in the owner's lending review", () => {
    const ro = (t: SpaceTool): SpaceTool => ({ ...t, approvalEditable: false });
    render(<SpaceToolList tools={[READ, ro(WRITE), ro(DESTROY)]} delegation />);
    expect(screen.queryByText("The owner decides which actions ask first.")).toBeNull();
    expect(screen.getByText("Runs without asking")).toBeInTheDocument();
  });

  it("omits the owner line when no tool carries an approval", () => {
    render(<SpaceToolList tools={[READ]} />);
    expect(screen.queryByText("The owner decides which actions ask first.")).toBeNull();
  });
});
