import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SharingModal } from "./SharingModal";
import type { SpaceDetail, SpaceSharing } from "../spaces-api";

vi.mock("../spaces-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../spaces-api")>();
  return { ...real, updateSpaceSharing: vi.fn(), fetchSpace: vi.fn() };
});

import { SpaceApiError, fetchSpace, updateSpaceSharing } from "../spaces-api";

const TOOLS: SpaceDetail["tools"] = [
  { name: "jira_search", integration: "jira", integrationName: "Jira", effect: "read", connected: true, description: "Search issues with JQL.", delegable: true },
  { name: "github_list_prs", integration: "github", integrationName: "GitHub", effect: "read", connected: true, delegable: true },
  { name: "github_merge_pr", integration: "github", integrationName: "GitHub", effect: "destructive", connected: true, delegable: true },
  { name: "sheets_append_row", integration: "sheets", integrationName: "Google Sheets", effect: "write", connected: true, delegable: true },
  { name: "acme_set_secret", integration: "acme", integrationName: "Acme", effect: "write", connected: true, delegable: false },
];

function space(over: Partial<SpaceDetail> = {}): SpaceDetail {
  return {
    name: "sprint-board",
    title: "Sprint Board",
    description: null,
    ownerEmail: "dev@example.com",
    mine: true,
    visibility: "org",
    users: [],
    updatedAt: 1,
    tools: TOOLS,
    consented: true,
    appUrl: "/s/sprint-board/app/sig/",
    delegate_access: false,
    delegation_suspended: false,
    delegation_off: null,
    tools_hash: "hash-1",
    can_delegate: true,
    ...over,
  };
}

const saved = (over: Record<string, unknown> = {}) => ({
  visibility: "org" as const,
  users: [],
  delegate_access: true,
  delegation_suspended: false,
  ...over,
});

let onSaved: Mock<(sharing: SpaceSharing) => void>;
let onClose: Mock<() => void>;

function open(s: SpaceDetail = space()) {
  onSaved = vi.fn<(sharing: SpaceSharing) => void>();
  onClose = vi.fn<() => void>();
  render(<SharingModal open space={s} onClose={onClose} onSaved={onSaved} />);
  return screen.getByRole("dialog");
}

const theSwitch = () => screen.getByRole("switch", { name: "Delegate my access" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateSpaceSharing).mockResolvedValue(saved());
});

describe("SharingModal: Delegate my access", () => {
  it("is hidden without the admin permission", () => {
    open(space({ can_delegate: false }));
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText("Delegate my access")).not.toBeInTheDocument();
  });

  it("starts off, with what it means, and lists nothing until turned on", () => {
    const dialog = open();
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(theSwitch()).toBeEnabled();
    expect(dialog).toHaveTextContent(
      "People who open this Space use your connected apps, not theirs. Every call is logged under both names."
    );
    expect(within(dialog).queryByText("jira_search")).not.toBeInTheDocument();
  });

  it("is disabled on Only me, with a hint", () => {
    const dialog = open(space({ visibility: "private" }));
    expect(theSwitch()).toBeDisabled();
    expect(dialog).toHaveTextContent("Share with specific people or everyone signed in to delegate access.");
  });

  it("choosing Only me turns it off in the dialog too", () => {
    const dialog = open();
    fireEvent.click(theSwitch());
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(dialog).getByLabelText(/Only me/));
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(theSwitch()).toBeDisabled();
    expect(within(dialog).queryByText("jira_search")).not.toBeInTheDocument();
  });

  it("turning it on lists every declared tool with its effect, reads included", () => {
    const dialog = open();
    fireEvent.click(theSwitch());
    const warning = within(dialog).getByRole("note");
    expect(warning).toHaveTextContent("Viewers can call these with your access, with any input.");
    expect(warning).toHaveTextContent("This is every tool the Space declares, reads included.");
    for (const t of TOOLS) expect(within(warning).getByText(t.name)).toBeInTheDocument();
    const row = (name: string) => within(warning).getByText(name).closest(".ui-box-row")!;
    expect(row("jira_search")).toHaveTextContent("Reads");
    expect(row("github_merge_pr")).toHaveTextContent("Asks first");
    expect(row("sheets_append_row")).toHaveTextContent("Writes");
    expect(row("acme_set_secret")).toHaveTextContent("Owner only");
    expect(row("jira_search")).not.toHaveTextContent("Owner only");
  });

  it("Save asks a second time, and Back returns without saving", async () => {
    const dialog = open();
    fireEvent.click(theSwitch());
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    const confirm = screen.getByRole("dialog");
    expect(within(confirm).getByRole("heading", { name: "Delegate your access?" })).toBeInTheDocument();
    expect(confirm).toHaveTextContent(
      "Everyone signed in who opens Sprint Board will run its tools as you, with your connected apps."
    );
    expect(confirm).toHaveTextContent("Viewers can call these with your access, with any input.");
    expect(within(confirm).getByText("github_merge_pr")).toBeInTheDocument();
    expect(confirm).toHaveTextContent("Every call is logged under both names.");
    expect(updateSpaceSharing).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Back" }));
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    expect(updateSpaceSharing).not.toHaveBeenCalled();
  });

  it("Delegate access saves the mode with the reviewed tools_hash, with the audience change", async () => {
    const dialog = open(space({ visibility: "private" }));
    fireEvent.click(within(dialog).getByLabelText(/Everyone signed in/));
    fireEvent.click(theSwitch());
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
    await waitFor(() =>
      expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", {
        visibility: "org",
        delegate_access: true,
        tools_hash: "hash-1",
      })
    );
    expect(onSaved).toHaveBeenCalledWith(saved());
    expect(onClose).toHaveBeenCalled();
  });

  it("names the people when shared with specific people", () => {
    const dialog = open(space({ visibility: "users", users: ["qa@example.com", "ops@example.com"] }));
    fireEvent.click(theSwitch());
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("The 2 people you shared Sprint Board with will run its tools as you");
  });

  it("already on: a plain Save sends no mode, and turning it off sends false without a second step", async () => {
    let dialog = open(space({ delegate_access: true }));
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", {}));

    vi.clearAllMocks();
    document.body.innerHTML = "";
    dialog = open(space({ delegate_access: true }));
    fireEvent.click(theSwitch());
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", { delegate_access: false }));
  });

  it("on, then Only me: saves the private audience with the mode off", async () => {
    const dialog = open(space({ delegate_access: true }));
    fireEvent.click(within(dialog).getByLabelText(/Only me/));
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", { visibility: "private", delegate_access: false })
    );
  });

  describe("suspended after a tool change", () => {
    const paused = () => space({ delegate_access: true, delegation_suspended: true, tools_hash: "hash-2" });

    it("says so, lists the tools, and Confirm tools goes through the second step", async () => {
      const dialog = open(paused());
      const box = within(dialog).getByRole("note");
      expect(box).toHaveTextContent("The tool list changed. Review and confirm to resume.");
      expect(box).toHaveTextContent("Delegation is paused. Viewers can call these with your access, with any input.");
      expect(within(box).getByText("sheets_append_row")).toBeInTheDocument();
      fireEvent.click(within(box).getByRole("button", { name: "Confirm tools" }));
      fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
      await waitFor(() =>
        expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", { delegate_access: true, tools_hash: "hash-2" })
      );
    });

    it("a plain Save leaves it paused", async () => {
      const dialog = open(paused());
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", {}));
    });
  });

  it("TOOLS_CHANGED: fetches the new list, shows it, and confirms the new hash next time", async () => {
    vi.mocked(updateSpaceSharing).mockRejectedValueOnce(
      new SpaceApiError(409, { code: "TOOLS_CHANGED", message: "The tool list changed. Review it again." })
    );
    const newTool = { name: "github_delete_repo", integration: "github", integrationName: "GitHub", effect: "destructive", connected: true, delegable: true };
    vi.mocked(fetchSpace).mockResolvedValue(space({ tools: [...TOOLS, newTool], tools_hash: "hash-3" }));
    const dialog = open();
    fireEvent.click(theSwitch());
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
    expect(await screen.findByText(/The tool list changed while you were reviewing it/)).toBeInTheDocument();
    expect(fetchSpace).toHaveBeenCalledWith("sprint-board");
    const note = within(screen.getByRole("dialog")).getByRole("note");
    expect(within(note).getByText("github_delete_repo")).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
    await waitFor(() =>
      expect(updateSpaceSharing).toHaveBeenLastCalledWith("sprint-board", { delegate_access: true, tools_hash: "hash-3" })
    );
  });

  it.each([
    ["CONFLICT", 409, "This Space changed while you were editing. Try again."],
    ["DELEGATION_NOT_ALLOWED", 403, "An admin has not allowed you to delegate access. Ask an admin to allow it."],
  ])("%s shows a clear message and keeps the dialog open", async (code, status, text) => {
    vi.mocked(updateSpaceSharing).mockRejectedValueOnce(new SpaceApiError(status, { code, message: "server text" }));
    const dialog = open();
    fireEvent.click(theSwitch());
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("permission revoked while on: shown so it can be turned off, but not back on", () => {
    const dialog = open(space({ delegate_access: true, can_delegate: false }));
    expect(dialog).toHaveTextContent("An admin removed your permission to delegate access");
    expect(theSwitch()).toBeEnabled();
    fireEvent.click(theSwitch());
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(theSwitch()).toBeDisabled();
  });
});
