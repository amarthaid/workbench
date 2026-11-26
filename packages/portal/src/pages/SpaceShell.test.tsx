import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SpaceShell from "./SpaceShell";
import type { SpaceDetail } from "../spaces-api";

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u1", email: "dev@example.com" }, token: "t", isLoading: false, login: vi.fn(), logout: vi.fn() }),
}));

vi.mock("../spaces-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../spaces-api")>();
  return {
    ...real,
    fetchSpace: vi.fn(),
    grantSpaceConsent: vi.fn(async () => undefined),
    revokeSpaceConsent: vi.fn(async () => undefined),
    callSpaceTool: vi.fn(async () => ({ prs: ["#1"] })),
    fetchSpaceKvKeys: vi.fn(async () => []),
    fetchSpaceKv: vi.fn(async () => undefined),
    putSpaceKv: vi.fn(async () => undefined),
    deleteSpaceKv: vi.fn(async () => undefined),
    updateSpaceSharing: vi.fn(),
  };
});

import { SpaceApiError, callSpaceTool, fetchSpace, grantSpaceConsent, revokeSpaceConsent, updateSpaceSharing } from "../spaces-api";

function space(overrides: Partial<SpaceDetail> = {}): SpaceDetail {
  return {
    name: "pr-timeline",
    title: "PR timeline",
    description: "Open PRs in one place",
    ownerEmail: "owner@example.com",
    mine: false,
    visibility: "org",
    updatedAt: 1_700_000_000_000,
    consented: true,
    consent_hash: "h1",
    appUrl: "/s/pr-timeline/app/sig-abc/",
    tools: [
      { name: "github_list_prs", integration: "github", integrationName: "GitHub", effect: "read", connected: true, description: "List PRs" },
      { name: "github_comment", integration: "github", integrationName: "GitHub", effect: "write", connected: true },
      { name: "github_merge_pr", integration: "github", integrationName: "GitHub", effect: "destructive", connected: true },
      { name: "bitbucket_list_prs", integration: "bitbucket", integrationName: "Bitbucket", effect: "read", connected: false },
      { name: "bitbucket_old_tool", integration: "bitbucket", integrationName: "Bitbucket", effect: "read", missing: true },
    ],
    ...overrides,
  };
}

/** Not yet consented, with every integration the Space uses connected. */
function connectedSpace(): SpaceDetail {
  const base = space({ consented: false });
  return { ...base, tools: base.tools.map((t) => (t.missing ? t : { ...t, connected: true })) };
}

const ports: MessagePort[] = [];
afterEach(() => {
  for (const p of ports.splice(0)) p.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchSpace).mockResolvedValue(space());
});

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/s/pr-timeline"]}>
        <Routes>
          <Route path="/s/:name" element={<SpaceShell />} />
          <Route path="/spaces" element={<h1>Gallery</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function frame(): Promise<HTMLIFrameElement> {
  return (await screen.findByTitle("PR timeline")) as HTMLIFrameElement;
}

// Fire the frame's first load and return the Space's end of the channel.
async function handshake() {
  const iframe = await frame();
  const post = vi.spyOn(iframe.contentWindow!, "postMessage");
  fireEvent.load(iframe);
  expect(post).toHaveBeenCalledTimes(1);
  const [msg, origin, transfer] = post.mock.calls[0] as unknown as [unknown, string, MessagePort[]];
  expect(msg).toEqual({ __wb: 1, type: "port" });
  expect(origin).toBe("*");
  const port = transfer[0];
  ports.push(port);
  const replies = new Map<string, (r: Record<string, unknown>) => void>();
  port.onmessage = (e: MessageEvent) => replies.get(e.data.id)?.(e.data);
  let n = 0;
  const send = (type: string, payload?: unknown, extra: Record<string, unknown> = {}) => {
    const id = `q${++n}`;
    const reply = new Promise<Record<string, unknown>>((resolve) => replies.set(id, resolve));
    port.postMessage({ __wb: 1, id, type, payload, ...extra });
    return reply;
  };
  return { iframe, post, send };
}

describe("SpaceShell", () => {
  it("shows a loading state first", () => {
    vi.mocked(fetchSpace).mockReturnValue(new Promise(() => {}));
    renderShell();
    expect(screen.getByText("Loading Space...")).toBeInTheDocument();
  });

  it("shows the not-found copy on a 404", async () => {
    vi.mocked(fetchSpace).mockRejectedValue(new SpaceApiError(404, { code: "NOT_FOUND", message: "x" }));
    renderShell();
    expect(await screen.findByText("This Space does not exist or was not shared with you.")).toBeInTheDocument();
    expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
  });

  describe("consent screen", () => {
    beforeEach(() => {
      vi.mocked(fetchSpace).mockResolvedValue(space({ consented: false }));
    });

    it("groups tools by integration with their effects and connection state", async () => {
      renderShell();
      expect(await screen.findByRole("heading", { name: "PR timeline" })).toBeInTheDocument();
      expect(screen.getByText("by owner@example.com")).toBeInTheDocument();

      const github = screen.getByRole("heading", { name: "GitHub" }).closest("section")!;
      expect(within(github).getByText("github_list_prs").closest(".ui-box-row")).toHaveTextContent("Reads");
      expect(within(github).getByText("github_comment").closest(".ui-box-row")).toHaveTextContent("Writes");
      expect(within(github).getByText("github_merge_pr").closest(".ui-box-row")).toHaveTextContent("Asks first");
      expect(within(github).queryByText("Not connected")).not.toBeInTheDocument();

      const bitbucket = screen.getByRole("heading", { name: "Bitbucket" }).closest("section")!;
      expect(within(bitbucket).getByText("Not connected")).toBeInTheDocument();
      const missing = within(bitbucket).getByText("bitbucket_old_tool").closest(".ui-box-row")!;
      expect(missing).toHaveTextContent("Missing");
      expect(missing).toHaveTextContent("Asks first");

      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
    });

    it("blocks Approve and offers Connect while an integration is not connected", async () => {
      renderShell();
      const approve = await screen.findByRole("button", { name: "Approve" });
      expect(approve).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("Connect Bitbucket to continue");

      const bitbucket = screen.getByRole("heading", { name: "Bitbucket" }).closest("section")!;
      const connect = within(bitbucket).getByRole("link", { name: "Connect" });
      expect(connect).toHaveAttribute("href", "/apps/bitbucket");
      expect(connect).toHaveAttribute("target", "_blank");
      const github = screen.getByRole("heading", { name: "GitHub" }).closest("section")!;
      expect(within(github).getByText("Connected")).toBeInTheDocument();
      expect(within(github).queryByRole("link", { name: "Connect" })).not.toBeInTheDocument();

      fireEvent.click(approve);
      expect(grantSpaceConsent).not.toHaveBeenCalled();
    });

    it("re-checks when the window regains focus", async () => {
      renderShell();
      await screen.findByRole("button", { name: "Approve" });
      expect(fetchSpace).toHaveBeenCalledTimes(1);
      vi.mocked(fetchSpace).mockResolvedValue(connectedSpace());
      fireEvent.focus(window);
      await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
      expect(fetchSpace).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("ignores a Missing tool when deciding whether everything is connected", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(connectedSpace());
      renderShell();
      expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
      expect(screen.getByText("bitbucket_old_tool")).toBeInTheDocument();
    });

    it("Approve records consent and mounts the sandboxed frame", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(connectedSpace());
      renderShell();
      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
      const iframe = await frame();
      expect(grantSpaceConsent).toHaveBeenCalledWith("pr-timeline", "h1");
      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      expect(iframe.getAttribute("allow")).toBe("");
      expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(iframe.getAttribute("src")).toBe("/s/pr-timeline/app/sig-abc/");
    });

    it("a Space that changed before Approve: says so and shows the new list to approve", async () => {
      vi.mocked(grantSpaceConsent).mockRejectedValueOnce(
        new SpaceApiError(409, { code: "CONSENT_CHANGED", message: "This Space changed. Review it again." })
      );
      vi.mocked(fetchSpace).mockResolvedValue(connectedSpace());
      renderShell();
      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
      const changed = space({
        consented: false,
        consent_hash: "h2",
        tools: [...connectedSpace().tools, { name: "github_delete_repo", integration: "github", integrationName: "GitHub", effect: "destructive", connected: true }],
      });
      vi.mocked(fetchSpace).mockResolvedValue(changed);
      expect(await screen.findByText("This Space changed. Review it again.")).toBeInTheDocument();
      expect(await screen.findByText("github_delete_repo")).toBeInTheDocument();
      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(grantSpaceConsent).toHaveBeenLastCalledWith("pr-timeline", "h2"));
      expect(await frame()).toBeInTheDocument();
    });

    it("a delegated Space shows no connection state at all, and Approve is enabled", async () => {
      // The detail's flags are the owner's; one of them is not connected.
      vi.mocked(fetchSpace).mockResolvedValue(space({ consented: false, delegate_access: true, delegation_off: null }));
      renderShell();
      const approve = await screen.findByRole("button", { name: "Approve" });
      expect(approve).toBeEnabled();
      expect(screen.getByText(/These tools run with owner@example.com's access, not yours/)).toBeInTheDocument();
      const github = screen.getByRole("heading", { name: "GitHub" }).closest("section")!;
      expect(within(github).getByText("github_list_prs").closest(".ui-box-row")).toHaveTextContent("Reads");
      expect(within(github).getByText("github_merge_pr").closest(".ui-box-row")).toHaveTextContent("Asks first");
      expect(screen.queryByText("Connected")).not.toBeInTheDocument();
      expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Connect" })).not.toBeInTheDocument();
      expect(screen.queryByText(/reconnect/)).not.toBeInTheDocument();
      expect(screen.queryByText(/to continue/)).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      fireEvent.click(approve);
      await waitFor(() => expect(grantSpaceConsent).toHaveBeenCalledWith("pr-timeline", "h1"));
    });

    it("Cancel goes back to the gallery", async () => {
      renderShell();
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(await screen.findByRole("heading", { name: "Gallery" })).toBeInTheDocument();
      expect(grantSpaceConsent).not.toHaveBeenCalled();
    });
  });

  describe("sharing", () => {
    const openSharing = async () => {
      await frame();
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Sharing" }));
      // The dialog reads the Space again before it shows the form.
      await screen.findByText("Who can open this Space");
      return screen.getByRole("dialog");
    };

    it("is offered to the owner only", async () => {
      renderShell();
      await frame();
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      expect(screen.queryByRole("menuitem", { name: "Sharing" })).not.toBeInTheDocument();
    });

    it("opens a Space to everyone signed in", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(space({ mine: true, visibility: "private", users: [] }));
      vi.mocked(updateSpaceSharing).mockResolvedValue({ visibility: "org", users: [], delegate_access: false, delegation_suspended: false });
      renderShell();
      const dialog = await openSharing();
      expect(within(dialog).getByLabelText(/Only me/)).toBeChecked();
      fireEvent.click(within(dialog).getByLabelText(/Everyone signed in/));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("pr-timeline", { visibility: "org" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("adds and removes people, sending only the difference", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(
        space({ mine: true, visibility: "users", users: ["ops@example.com", "qa@example.com"] })
      );
      vi.mocked(updateSpaceSharing).mockResolvedValue({ visibility: "users", users: ["new@example.com", "two@example.com", "qa@example.com"], delegate_access: false, delegation_suspended: false });
      renderShell();
      const dialog = await openSharing();
      const input = within(dialog).getByLabelText("Email addresses to add");
      fireEvent.change(input, { target: { value: "New@Example.com, two@example.com" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(within(dialog).getByText("new@example.com")).toBeInTheDocument();
      expect(within(dialog).getByText("two@example.com")).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove ops@example.com" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(updateSpaceSharing).toHaveBeenCalledWith("pr-timeline", {
          add_users: ["new@example.com", "two@example.com"],
          remove_users: ["ops@example.com"],
        })
      );
    });

    it("rejects a bad address and an empty people list without calling the server", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(space({ mine: true, visibility: "users", users: ["qa@example.com"] }));
      renderShell();
      const dialog = await openSharing();
      const input = within(dialog).getByLabelText("Email addresses to add");
      fireEvent.change(input, { target: { value: "not-an-email" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
      expect(within(dialog).getByText(/Not an email address: not-an-email/)).toBeInTheDocument();
      // The bad pill has to go before anything else can be added.
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove not-an-email from the addresses to add" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove qa@example.com" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(within(dialog).getByText(/Add at least one person/)).toBeInTheDocument();
      expect(updateSpaceSharing).not.toHaveBeenCalled();
    });

    it("turns comma-separated input into pills, and Backspace drops the last one", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(space({ mine: true, visibility: "users", users: ["qa@example.com"] }));
      vi.mocked(updateSpaceSharing).mockResolvedValue({ visibility: "users", users: ["a@example.com", "qa@example.com"], delegate_access: false, delegation_suspended: false });
      renderShell();
      const dialog = await openSharing();
      const input = within(dialog).getByLabelText("Email addresses to add") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "a@example.com, b@example.com, c@exa" } });
      expect(input.value).toBe("c@exa");
      expect(within(dialog).getByRole("button", { name: "Remove a@example.com from the addresses to add" })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Remove b@example.com from the addresses to add" })).toBeInTheDocument();
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Backspace" });
      expect(within(dialog).queryByRole("button", { name: "Remove b@example.com from the addresses to add" })).not.toBeInTheDocument();
      // Save refuses while a pill is waiting to be added.
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(within(dialog).getByText(/Press Add to include/)).toBeInTheDocument();
      expect(updateSpaceSharing).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
      expect(within(dialog).getByText("a@example.com")).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(updateSpaceSharing).toHaveBeenCalledWith("pr-timeline", { add_users: ["a@example.com"] }));
    });

    it("reads the Space again when Sharing opens, and again after a save", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(space({ mine: true, visibility: "private", users: [] }));
      vi.mocked(updateSpaceSharing).mockResolvedValue({ visibility: "org", users: [], delegate_access: false, delegation_suspended: false });
      renderShell();
      await frame();
      expect(fetchSpace).toHaveBeenCalledTimes(1);
      const dialog = await openSharing();
      expect(fetchSpace).toHaveBeenCalledTimes(2);
      fireEvent.click(within(dialog).getByLabelText(/Everyone signed in/));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      // The detail is invalidated, not patched with the save's partial answer.
      await waitFor(() => expect(fetchSpace).toHaveBeenCalledTimes(3));
    });

    it("shows the server's error and keeps the dialog open", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(space({ mine: true, visibility: "private", users: [] }));
      vi.mocked(updateSpaceSharing).mockRejectedValue(new SpaceApiError(403, { code: "FORBIDDEN", message: "Only the owner can change who can open this Space." }));
      renderShell();
      const dialog = await openSharing();
      fireEvent.click(within(dialog).getByLabelText(/Everyone signed in/));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(await within(dialog).findByText("Only the owner can change who can open this Space.")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  describe("running", () => {
    it("shows the top bar", async () => {
      renderShell();
      await frame();
      expect(screen.getByText("by owner@example.com")).toBeInTheDocument();
      expect(screen.getByText("Running as you")).toBeInTheDocument();
    });

    it("shows the workbench mark before Spaces, linking home", async () => {
      renderShell();
      await frame();
      const home = screen.getByRole("link", { name: "workbench home" });
      expect(home).toHaveAttribute("href", "/");
      expect(home.querySelector(".brand-mark")).not.toBeNull();
      const spaces = screen.getByRole("link", { name: "All Spaces" });
      expect(home.compareDocumentPosition(spaces) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("hands the frame a port and round-trips a call", async () => {
      renderShell();
      const { send, post } = await handshake();
      const reply = await send("call", { integration: "github", tool: "list_prs", args: { state: "open" } });
      expect(callSpaceTool).toHaveBeenCalledWith("pr-timeline", { tool: "github_list_prs", args: { state: "open" } });
      expect(reply).toMatchObject({ ok: true, result: { prs: ["#1"] } });
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("answers me with the signed-in viewer", async () => {
      renderShell();
      const { send } = await handshake();
      expect((await send("me")).result).toEqual({ email: "dev@example.com" });
    });

    it("confirms a destructive call: Allow sends confirmed", async () => {
      renderShell();
      const { send } = await handshake();
      const reply = send("call", { integration: "github", tool: "merge_pr", args: { repo: "acme/demo-repo", id: 7 } });
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("github_merge_pr")).toBeInTheDocument();
      expect(within(dialog).getByText("GitHub")).toBeInTheDocument();
      expect(within(dialog).getByText("acme/demo-repo")).toBeInTheDocument();
      expect(within(dialog).getByText("Raw arguments")).toBeInTheDocument();
      expect(callSpaceTool).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
      expect(await reply).toMatchObject({ ok: true });
      expect(callSpaceTool).toHaveBeenCalledWith("pr-timeline", {
        tool: "github_merge_pr",
        args: { repo: "acme/demo-repo", id: 7 },
        confirmed: true,
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("confirms a destructive call: Deny answers DENIED", async () => {
      renderShell();
      const { send } = await handshake();
      const reply = send("call", { integration: "github", tool: "merge_pr" });
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Deny" }));
      const r = await reply;
      expect(r.ok).toBe(false);
      expect((r.error as { code: string }).code).toBe("DENIED");
      expect(callSpaceTool).not.toHaveBeenCalled();
    });

    it("ignores a confirmed flag supplied by the Space", async () => {
      renderShell();
      const { send } = await handshake();
      const reply = send("call", { integration: "github", tool: "merge_pr", confirmed: true }, { confirmed: true });
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(callSpaceTool).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
      expect(((await reply).error as { code: string }).code).toBe("DENIED");
    });

    it("on a 428 shows the modal, then retries with confirmed", async () => {
      vi.mocked(callSpaceTool)
        .mockRejectedValueOnce(new SpaceApiError(428, { code: "CONFIRMATION_REQUIRED", message: "confirm" }))
        .mockResolvedValueOnce({ ok: 1 });
      renderShell();
      const { send } = await handshake();
      const reply = send("call", { integration: "github", tool: "comment" });
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Allow" }));
      expect(await reply).toMatchObject({ ok: true, result: { ok: 1 } });
      expect(vi.mocked(callSpaceTool).mock.calls[1][1]).toEqual({ tool: "github_comment", confirmed: true });
    });

    it("NOT_CONNECTED shows a Connect banner and replies NOT_CONNECTED", async () => {
      vi.mocked(callSpaceTool).mockRejectedValueOnce(
        new SpaceApiError(409, { code: "NOT_CONNECTED", message: "not connected", integration: "bitbucket" })
      );
      renderShell();
      const { send, iframe } = await handshake();
      const r = await send("call", { integration: "bitbucket", tool: "list_prs" });
      expect(r.error).toMatchObject({ code: "NOT_CONNECTED", integration: "bitbucket" });
      const link = await screen.findByRole("link", { name: "Connect Bitbucket" });
      expect(link).toHaveAttribute("href", "/apps/bitbucket");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener");
      // Non-blocking: the Space keeps running.
      expect(iframe).toBeInTheDocument();
    });

    it("CONSENT_REQUIRED unmounts the frame and returns to the consent screen", async () => {
      vi.mocked(callSpaceTool).mockRejectedValueOnce(
        new SpaceApiError(403, { code: "CONSENT_REQUIRED", message: "consent" })
      );
      renderShell();
      const { send } = await handshake();
      vi.mocked(fetchSpace).mockResolvedValue(space({ consented: false }));
      const r = await send("call", { integration: "github", tool: "list_prs" });
      expect((r.error as { code: string }).code).toBe("CONSENT_REQUIRED");
      expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
    });

    it("a second load unmounts the frame and shows the navigated-away notice", async () => {
      renderShell();
      const { iframe, post } = await handshake();
      fireEvent.load(iframe);
      expect(await screen.findByText("This Space navigated away and was stopped.")).toBeInTheDocument();
      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("Reload Space after a stop mounts a fresh frame", async () => {
      renderShell();
      const { iframe } = await handshake();
      fireEvent.load(iframe);
      fireEvent.click(await screen.findByRole("button", { name: "Reload Space" }));
      expect(await frame()).not.toBe(iframe);
    });

    it("pauses after too many confirmations", async () => {
      renderShell();
      const { send } = await handshake();
      for (let i = 0; i < 5; i++) {
        const reply = send("call", { integration: "github", tool: "merge_pr", args: { i } });
        fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Allow" }));
        await reply;
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      }
      send("call", { integration: "github", tool: "merge_pr" });
      expect(await screen.findByText(/asked for too many confirmations/)).toBeInTheDocument();
      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
      expect(callSpaceTool).toHaveBeenCalledTimes(5);
    });

    it("View tools lists the declared tools", async () => {
      renderShell();
      await frame();
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "View tools" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("github_merge_pr")).toBeInTheDocument();
    });

    it("Revoke access deletes consent and returns to the consent screen", async () => {
      renderShell();
      await frame();
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Revoke access" }));
      expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
      expect(revokeSpaceConsent).toHaveBeenCalledWith("pr-timeline");
      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
    });
  });

  describe("delegated access", () => {
    const delegated = (over: Partial<SpaceDetail> = {}) =>
      space({
        delegate_access: true,
        delegation_off: null,
        tools: [
          ...space().tools.map((t) => ({ ...t, delegable: true })),
          { name: "github_set_token", integration: "github", integrationName: "GitHub", effect: "write", connected: true, delegable: false },
        ],
        ...over,
      });

    it("the consent screen says whose access the tools run with", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated({ consented: false }));
      renderShell();
      expect(await screen.findByText("These tools run with owner@example.com's access, not yours.")).toBeInTheDocument();
      expect(screen.getByText(/Every call is logged under your name and theirs/)).toBeInTheDocument();
      expect(screen.queryByText(/This Space runs as you/)).not.toBeInTheDocument();
    });

    it("the bar says whose access is used, instead of Running as you", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated());
      renderShell();
      await frame();
      expect(screen.getByText("Using owner@example.com's delegated access")).toBeInTheDocument();
      expect(screen.queryByText("Running as you")).not.toBeInTheDocument();
    });

    it("the owner of a delegated Space still runs as themselves", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated({ mine: true, users: [], can_delegate: true, tools_hash: "h" }));
      renderShell();
      await frame();
      expect(screen.getByText("Running as you")).toBeInTheDocument();
    });

    it("the destructive dialog names the owner and says it is logged under both names", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated());
      renderShell();
      const { send } = await handshake();
      const reply = send("call", { integration: "github", tool: "merge_pr", args: { repo: "acme/demo-repo" } });
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("heading", { name: "Run github_merge_pr as owner@example.com?" })).toBeInTheDocument();
      expect(dialog).toHaveTextContent("with owner@example.com's access, not yours");
      expect(dialog).toHaveTextContent("logged under both names");
      fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
      expect(await reply).toMatchObject({ ok: true });
    });

    it.each([
      ["turned_off", "Shared access is off", "This Space's shared access was turned off."],
      ["tools_changed", "Space paused", "This Space's tools changed. The owner needs to confirm them again."],
    ] as const)("opening it while off (%s) shows a full-page card, not the Space", async (reason, title, message) => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated({ delegate_access: false, delegation_off: { reason, message } }));
      renderShell();
      expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to Spaces" })).toHaveAttribute("href", "/spaces");
      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    });

    const WAITING = "owner@example.com needs to reconnect Bitbucket before this Space can be used.";
    const waiting = (over: Partial<SpaceDetail> = {}) =>
      delegated({ delegation_off: { reason: "owner_not_connected", message: WAITING }, ...over });

    it.each([false, true])("the owner missing a connection holds the viewer at a card (consented: %s)", async (consented) => {
      vi.mocked(fetchSpace).mockResolvedValue(waiting({ consented }));
      renderShell();
      expect(await screen.findByRole("heading", { name: "Waiting for the owner" })).toBeInTheDocument();
      expect(screen.getByText(WAITING)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
    });

    it("Try again on the waiting card refetches and goes on to consent once the owner has connected", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(waiting({ consented: false }));
      renderShell();
      await screen.findByRole("heading", { name: "Waiting for the owner" });

      // Still missing: the card stays.
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(fetchSpace).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("heading", { name: "Waiting for the owner" })).toBeInTheDocument();

      vi.mocked(fetchSpace).mockResolvedValue(delegated({ consented: false }));
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
      expect(screen.queryByRole("heading", { name: "Waiting for the owner" })).not.toBeInTheDocument();
    });

    it("OWNER_NOT_CONNECTED during a call replaces the running Space with the waiting card", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated());
      vi.mocked(callSpaceTool).mockRejectedValueOnce(
        new SpaceApiError(409, { code: "OWNER_NOT_CONNECTED", reason: "owner_not_connected", message: WAITING })
      );
      renderShell();
      const { send } = await handshake();
      const r = await send("call", { integration: "github", tool: "list_prs" });
      expect((r.error as { code: string }).code).toBe("OWNER_NOT_CONNECTED");
      expect(await screen.findByRole("heading", { name: "Waiting for the owner" })).toBeInTheDocument();
      expect(screen.getByText(WAITING)).toBeInTheDocument();
      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
    });

    it("a 409 OWNER_NOT_CONNECTED on Approve shows the waiting card", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated({ consented: false }));
      vi.mocked(grantSpaceConsent).mockRejectedValueOnce(new SpaceApiError(409, { code: "OWNER_NOT_CONNECTED", message: WAITING }));
      renderShell();
      vi.mocked(fetchSpace).mockResolvedValue(waiting({ consented: false }));
      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
      expect(await screen.findByRole("heading", { name: "Waiting for the owner" })).toBeInTheDocument();
      vi.mocked(fetchSpace).mockResolvedValue(delegated({ consented: false }));
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
      expect(screen.queryByText("Could not record your approval. Try again.")).not.toBeInTheDocument();
    });

    it("View tools in a running delegated Space shows no connection state", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated());
      renderShell();
      await frame();
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "View tools" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("bitbucket_list_prs")).toBeInTheDocument();
      expect(within(dialog).queryByText("Not connected")).not.toBeInTheDocument();
    });

    it("DELEGATION_OFF during a call replaces the running Space with the card", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated());
      vi.mocked(callSpaceTool).mockRejectedValueOnce(
        new SpaceApiError(403, { code: "DELEGATION_OFF", reason: "turned_off", message: "This Space's shared access was turned off." })
      );
      renderShell();
      const { send } = await handshake();
      const r = await send("call", { integration: "github", tool: "list_prs" });
      expect((r.error as { code: string }).code).toBe("DELEGATION_OFF");
      expect(await screen.findByRole("heading", { name: "Shared access is off" })).toBeInTheDocument();
      expect(screen.queryByTitle("PR timeline")).not.toBeInTheDocument();
    });

    it("Try again on the card runs the Space again once delegation is back", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated());
      vi.mocked(callSpaceTool).mockRejectedValueOnce(
        new SpaceApiError(403, { code: "DELEGATION_OFF", reason: "turned_off", message: "This Space's shared access was turned off." })
      );
      renderShell();
      const { send } = await handshake();
      await send("call", { integration: "github", tool: "list_prs" });
      await screen.findByRole("heading", { name: "Shared access is off" });

      // Still off: the card stays, with the server's message.
      vi.mocked(fetchSpace).mockResolvedValue(
        delegated({ delegate_access: false, delegation_off: { reason: "turned_off", message: "This Space's shared access was turned off." } })
      );
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(fetchSpace).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("heading", { name: "Shared access is off" })).toBeInTheDocument();

      // Back on: the Space runs again.
      vi.mocked(fetchSpace).mockResolvedValue(delegated());
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      expect(await frame()).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Shared access is off" })).not.toBeInTheDocument();
    });

    it("a tool that cannot be delegated shows a banner and never asks or calls", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated());
      renderShell();
      const { send, iframe } = await handshake();
      const r = await send("call", { integration: "github", tool: "set_token" });
      expect((r.error as { code: string }).code).toBe("TOOL_NOT_DELEGABLE");
      expect(await screen.findByText("github_set_token cannot run with someone else's access.")).toBeInTheDocument();
      expect(callSpaceTool).not.toHaveBeenCalled();
      expect(iframe).toBeInTheDocument();
    });

    it("the owner not connected: a banner naming the owner, with no Connect link", async () => {
      vi.mocked(fetchSpace).mockResolvedValue(delegated());
      vi.mocked(callSpaceTool).mockRejectedValueOnce(
        new SpaceApiError(409, {
          code: "NOT_CONNECTED",
          delegated: true,
          message: "owner@example.com needs to reconnect GitHub.",
          integration: "github",
        })
      );
      renderShell();
      const { send } = await handshake();
      await send("call", { integration: "github", tool: "list_prs" });
      const banner = (await screen.findByText("owner@example.com needs to reconnect GitHub.")).closest(".space-banner")!;
      expect(within(banner as HTMLElement).queryByRole("link")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Connect/ })).not.toBeInTheDocument();
      fireEvent.click(within(banner as HTMLElement).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText("owner@example.com needs to reconnect GitHub.")).not.toBeInTheDocument();
    });
  });
});

