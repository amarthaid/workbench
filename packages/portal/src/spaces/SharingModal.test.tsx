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

/** Opens the dialog; `s` is what the server holds when it reads the Space again. */
async function open(s: SpaceDetail = space(), stale: SpaceDetail = s) {
  onSaved = vi.fn<(sharing: SpaceSharing) => void>();
  onClose = vi.fn<() => void>();
  vi.mocked(fetchSpace).mockResolvedValue(s);
  render(<SharingModal open space={stale} onClose={onClose} onSaved={onSaved} />);
  await screen.findByText("Who can open this Space");
  return screen.getByRole("dialog");
}

const primary = (root: HTMLElement = screen.getByRole("dialog")) =>
  within(root).getByRole("button", { name: /^(Save|Review and delegate)$/ });
const toTab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));
const theSwitch = () => screen.getByRole("switch", { name: "Delegate my access" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateSpaceSharing).mockResolvedValue(saved());
});

describe("SharingModal: Delegate my access", () => {
  it("is hidden without the admin permission", async () => {
    await open(space({ can_delegate: false }));
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText("Delegate my access")).not.toBeInTheDocument();
  });

  it("starts off, with what it means, and lists nothing until turned on", async () => {
    const dialog = await open();
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(theSwitch()).toBeEnabled();
    expect(dialog).toHaveTextContent(
      "People who open this Space use your connected apps, not theirs. Every call is logged under both names."
    );
    expect(within(dialog).queryByText("jira_search")).not.toBeInTheDocument();
  });

  it("is disabled on Only me, with a hint", async () => {
    const dialog = await open(space({ visibility: "private" }));
    expect(theSwitch()).toBeDisabled();
    expect(dialog).toHaveTextContent("Share with specific people or everyone signed in to delegate access.");
  });

  it("choosing Only me turns it off in the dialog too", async () => {
    const dialog = await open();
    fireEvent.click(theSwitch());
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    toTab(/^People/);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Only me/ }));
    toTab(/^Access/);
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(theSwitch()).toBeDisabled();
    expect(within(dialog).queryByText("jira_search")).not.toBeInTheDocument();
  });

  it("turning it on lists every declared tool with its effect, reads included", async () => {
    const dialog = await open();
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
    const dialog = await open();
    fireEvent.click(theSwitch());
    fireEvent.click(primary(dialog));
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
    const dialog = await open(space({ visibility: "private" }));
    fireEvent.click(within(dialog).getByLabelText(/Everyone signed in/));
    fireEvent.click(theSwitch());
    fireEvent.click(primary(dialog));
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

  it("names the people when shared with specific people", async () => {
    const dialog = await open(space({ visibility: "users", users: ["qa@example.com", "ops@example.com"] }));
    fireEvent.click(theSwitch());
    fireEvent.click(primary(dialog));
    expect(screen.getByRole("dialog")).toHaveTextContent("The 2 people you shared Sprint Board with will run its tools as you");
  });

  it("already on: a plain Save sends no mode, and turning it off sends false without a second step", async () => {
    let dialog = await open(space({ delegate_access: true }));
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
    fireEvent.click(primary(dialog));
    await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", {}));

    vi.clearAllMocks();
    document.body.innerHTML = "";
    dialog = await open(space({ delegate_access: true }));
    fireEvent.click(theSwitch());
    fireEvent.click(primary(dialog));
    await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", { delegate_access: false }));
  });

  it("on, then Only me: saves the private audience with the mode off", async () => {
    const dialog = await open(space({ delegate_access: true }));
    toTab(/^People/);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Only me/ }));
    toTab(/^Access/);
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(primary(dialog));
    await waitFor(() =>
      expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", { visibility: "private", delegate_access: false })
    );
  });

  describe("suspended after a tool change", () => {
    const paused = () => space({ delegate_access: true, delegation_suspended: true, tools_hash: "hash-2" });

    it("says so, lists the tools, and Confirm tools goes through the second step", async () => {
      const dialog = await open(paused());
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
      const dialog = await open(paused());
      fireEvent.click(primary(dialog));
      await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", {}));
    });
  });

  it("TOOLS_CHANGED: fetches the new list, shows it, and confirms the new hash next time", async () => {
    vi.mocked(updateSpaceSharing).mockRejectedValueOnce(
      new SpaceApiError(409, { code: "TOOLS_CHANGED", message: "The tool list changed. Review it again." })
    );
    const newTool = { name: "github_delete_repo", integration: "github", integrationName: "GitHub", effect: "destructive", connected: true, delegable: true };
    const dialog = await open();
    vi.mocked(fetchSpace).mockResolvedValue(space({ tools: [...TOOLS, newTool], tools_hash: "hash-3" }));
    fireEvent.click(theSwitch());
    fireEvent.click(primary(dialog));
    fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
    expect(await screen.findByText(/The tool list changed while you were reviewing it/)).toBeInTheDocument();
    expect(fetchSpace).toHaveBeenCalledTimes(2);
    const note = within(screen.getByRole("dialog")).getByRole("note");
    expect(within(note).getByText("github_delete_repo")).toBeInTheDocument();

    fireEvent.click(primary());
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
    const dialog = await open();
    fireEvent.click(theSwitch());
    fireEvent.click(primary(dialog));
    fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("permission revoked while on: no tabs, a muted line, and Turn off sends delegate_access:false", async () => {
    const dialog = await open(space({ delegate_access: true, can_delegate: true, delegation_blocked: "no_permission" }));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("Delegated access is off because an admin removed your permission.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    expect(within(dialog).queryByRole("button", { name: "Turn off" })).not.toBeInTheDocument();
    fireEvent.click(primary(dialog));
    await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", { delegate_access: false }));
  });

  it("blocked but never on: no tabs and no line, and a plain Save sends nothing about delegation", async () => {
    const dialog = await open(space({ delegation_blocked: "no_permission" }));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("admin removed your permission");
    expect(within(dialog).queryByRole("button", { name: "Turn off" })).not.toBeInTheDocument();
    fireEvent.click(primary(dialog));
    await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", {}));
  });

  it("reads the Space again on open, so a stale page copy is never what is confirmed", async () => {
    // The page still thinks delegation runs; the server says it is paused on a new list.
    const dialog = await open(
      space({ delegate_access: true, delegation_suspended: true, tools_hash: "hash-new" }),
      space({ delegate_access: true, tools_hash: "hash-old" })
    );
    expect(fetchSpace).toHaveBeenCalledWith("sprint-board");
    fireEvent.click(within(within(dialog).getByRole("note")).getByRole("button", { name: "Confirm tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
    await waitFor(() =>
      expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", { delegate_access: true, tools_hash: "hash-new" })
    );
  });

  it("says so when the Space cannot be read again", async () => {
    vi.mocked(fetchSpace).mockRejectedValue(new SpaceApiError(0, { code: "UPSTREAM_ERROR", message: "x" }));
    render(<SharingModal open space={space()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("Could not load the sharing settings. Close and try again.")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  describe("changing the audience while on", () => {
    it("widening to everyone signed in shows the warning again and asks a second time", async () => {
      const dialog = await open(space({ visibility: "users", users: ["qa@example.com"], delegate_access: true }));
      expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByLabelText(/Everyone signed in/));
      const note = within(dialog).getByRole("note");
      expect(note).toHaveTextContent("Viewers can call these with your access, with any input.");
      expect(note).toHaveTextContent("Everyone signed in will be able to use your access.");
      for (const t of TOOLS) expect(within(note).getByText(t.name)).toBeInTheDocument();
      fireEvent.click(primary(dialog));
      expect(screen.getByRole("heading", { name: "Delegate your access?" })).toBeInTheDocument();
      expect(updateSpaceSharing).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
      await waitFor(() =>
        expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", {
          visibility: "org",
          delegate_access: true,
          tools_hash: "hash-1",
        })
      );
    });

    it("narrowing from everyone signed in to specific people saves without a second step", async () => {
      vi.mocked(updateSpaceSharing).mockResolvedValue(saved({ visibility: "users", users: ["qa@example.com"] }));
      const dialog = await open(space({ visibility: "org", users: ["qa@example.com"], delegate_access: true }));
      fireEvent.click(within(dialog).getByLabelText(/Specific people/));
      expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
      fireEvent.click(primary(dialog));
      await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", { visibility: "users" }));
      expect(screen.queryByRole("heading", { name: "Delegate your access?" })).not.toBeInTheDocument();
    });
  });

  it("without a tools_hash in the detail, sends nothing and asks for a reload", async () => {
    const dialog = await open(space({ tools_hash: undefined }));
    fireEvent.click(theSwitch());
    fireEvent.click(primary(dialog));
    fireEvent.click(screen.getByRole("button", { name: "Delegate access" }));
    expect(await screen.findByText("Reload this Space and try again.")).toBeInTheDocument();
    expect(updateSpaceSharing).not.toHaveBeenCalled();
  });

  it("a reopen reads the Space again and never shows the old copy", async () => {
    vi.mocked(fetchSpace).mockResolvedValue(space({ visibility: "org" }));
    const props = { space: space(), onClose: vi.fn(), onSaved: vi.fn() };
    const { rerender } = render(<SharingModal open {...props} />);
    await screen.findByText("Who can open this Space");
    expect(screen.getByLabelText(/Everyone signed in/)).toBeChecked();
    rerender(<SharingModal open={false} {...props} />);
    let resolve: (d: SpaceDetail) => void = () => undefined;
    vi.mocked(fetchSpace).mockReturnValue(new Promise<SpaceDetail>((r) => (resolve = r)));
    rerender(<SharingModal open {...props} />);
    // Still reading: the form (with the old answer) is not on screen.
    expect(screen.getByText("Loading sharing settings...")).toBeInTheDocument();
    expect(screen.queryByText("Who can open this Space")).not.toBeInTheDocument();
    resolve(space({ visibility: "private" }));
    await screen.findByText("Who can open this Space");
    expect(screen.getByRole("radio", { name: /Only me/, hidden: true })).toBeChecked();
    expect(fetchSpace).toHaveBeenCalledTimes(2);
  });

  it("permission revoked while on: widening is blocked with a hint, narrowing and turning off still work", async () => {
    const dialog = await open(
      space({ visibility: "users", users: ["qa@example.com"], delegate_access: true, can_delegate: false })
    );
    fireEvent.click(within(dialog).getByLabelText(/Everyone signed in/));
    expect(
      within(dialog).getByText(
        "Turn off Delegate my access to change who can open this Space, or ask an admin to allow it again."
      )
    ).toBeInTheDocument();
    expect(primary(dialog)).toBeDisabled();
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
    expect(updateSpaceSharing).not.toHaveBeenCalled();

    // Turning it off lifts the block: the audience change saves with the mode off.
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    expect(within(dialog).queryByText(/Turn off Delegate my access/)).not.toBeInTheDocument();
    fireEvent.click(primary(dialog));
    await waitFor(() =>
      expect(updateSpaceSharing).toHaveBeenCalledWith("sprint-board", { visibility: "org", delegate_access: false })
    );
  });

  describe("tabs", () => {
    it("renders Access first and selected, People second, and switches with the arrow keys", async () => {
      await open(space({ visibility: "users", users: ["qa@example.com"] }));
      const access = screen.getByRole("tab", { name: /^Access/ });
      const people = screen.getByRole("tab", { name: /^People/ });
      expect(screen.getAllByRole("tab")).toEqual([access, people]);
      expect(access).toHaveAttribute("aria-selected", "true");
      expect(people).toHaveAttribute("aria-selected", "false");
      expect(screen.getByRole("tabpanel")).toHaveAccessibleName(/Access/);
      access.focus();
      fireEvent.keyDown(access, { key: "ArrowRight" });
      expect(people).toHaveAttribute("aria-selected", "true");
      expect(people).toHaveFocus();
      expect(screen.getByRole("tabpanel")).toHaveAccessibleName(/People/);
      expect(screen.getByRole("radio", { name: /Specific people/ })).toBeInTheDocument();
      fireEvent.keyDown(people, { key: "ArrowLeft" });
      expect(access).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("switch", { name: "Delegate my access" })).toBeInTheDocument();
    });

    it("badges: Access is empty when off, On when on, Paused, and Not saved after a local change", async () => {
      await open();
      const access = () => screen.getByRole("tab", { name: /^Access/ });
      expect(access()).toHaveTextContent(/^Access$/);
      fireEvent.click(theSwitch());
      expect(access()).toHaveTextContent("Not saved");
      document.body.innerHTML = "";
      await open(space({ delegate_access: true }));
      expect(access()).toHaveTextContent("On");
      document.body.innerHTML = "";
      await open(space({ delegate_access: true, delegation_suspended: true }));
      expect(access()).toHaveTextContent("Paused");
    });

    it("badges: People shows the count, Only me or Everyone", async () => {
      const people = () => screen.getByRole("tab", { name: /^People/ });
      await open(space({ visibility: "users", users: ["a@example.com", "b@example.com"] }));
      expect(people()).toHaveTextContent("2");
      document.body.innerHTML = "";
      await open(space({ visibility: "private" }));
      expect(people()).toHaveTextContent("Only me");
      document.body.innerHTML = "";
      await open(space({ visibility: "org" }));
      expect(people()).toHaveTextContent("Everyone");
    });

    it("off view says viewers use their own access and what turning on would lend", async () => {
      const dialog = await open();
      expect(dialog).toHaveTextContent("Viewers use their own access");
      expect(dialog).toHaveTextContent("Turning this on would lend 5 tools across 4 apps.");
    });

    it("on and saved: a status line and the lent tools grouped by app, no warning", async () => {
      const dialog = await open(space({ delegate_access: true }));
      expect(dialog).toHaveTextContent("Everyone signed in can use your access");
      expect(within(dialog).getByText("github_merge_pr")).toBeInTheDocument();
      expect(within(dialog).getByText("GitHub")).toBeInTheDocument();
    });

    it("has no tab strip when delegation is blocked, and shows the People content", async () => {
      await open(space({ delegation_blocked: "no_permission" }));
      expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
      expect(screen.queryByRole("tab")).not.toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /Everyone signed in/ })).toBeInTheDocument();
    });

    it("primary button: Save normally, Review and delegate when Save leads to the confirm step", async () => {
      const dialog = await open();
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
      fireEvent.click(theSwitch());
      expect(within(dialog).getByRole("button", { name: "Review and delegate" })).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
      fireEvent.click(theSwitch());
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    it("primary button says Review and delegate when widening, and Save while paused", async () => {
      let dialog = await open(space({ visibility: "users", users: ["qa@example.com"], delegate_access: true }));
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
      fireEvent.click(within(dialog).getByLabelText(/Everyone signed in/));
      expect(within(dialog).getByRole("button", { name: "Review and delegate" })).toBeInTheDocument();
      document.body.innerHTML = "";
      dialog = await open(space({ delegate_access: true, delegation_suspended: true }));
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    it("Only me: the switch is disabled and a link jumps to the People tab", async () => {
      await open(space({ visibility: "private" }));
      expect(theSwitch()).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Choose who can open it" }));
      expect(screen.getByRole("tab", { name: /^People/ })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("radio", { name: /Only me/ })).toBeChecked();
    });

    it("the confirm step is unchanged: its own dialog with Back and Delegate access", async () => {
      const dialog = await open();
      fireEvent.click(theSwitch());
      fireEvent.click(primary(dialog));
      const confirm = screen.getByRole("dialog");
      expect(within(confirm).getByRole("heading", { name: "Delegate your access?" })).toBeInTheDocument();
      expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
      expect(within(confirm).getByRole("button", { name: "Back" })).toBeInTheDocument();
      expect(within(confirm).getByRole("button", { name: "Delegate access" })).toBeInTheDocument();
    });
  });
});
