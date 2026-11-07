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
  };
});

import { SpaceApiError, callSpaceTool, fetchSpace, grantSpaceConsent, revokeSpaceConsent } from "../spaces-api";

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

    it("Approve records consent and mounts the sandboxed frame", async () => {
      renderShell();
      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
      const iframe = await frame();
      expect(grantSpaceConsent).toHaveBeenCalledWith("pr-timeline");
      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      expect(iframe.getAttribute("allow")).toBe("");
      expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(iframe.getAttribute("src")).toBe("/s/pr-timeline/app/sig-abc/");
    });

    it("Cancel goes back to the gallery", async () => {
      renderShell();
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(await screen.findByRole("heading", { name: "Gallery" })).toBeInTheDocument();
      expect(grantSpaceConsent).not.toHaveBeenCalled();
    });
  });

  describe("running", () => {
    it("shows the top bar", async () => {
      renderShell();
      await frame();
      expect(screen.getByText("by owner@example.com")).toBeInTheDocument();
      expect(screen.getByText("Running as you")).toBeInTheDocument();
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
});
