import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Spaces, { EXAMPLE_PROMPT } from "./Spaces";

vi.mock("../spaces-api", () => ({ fetchSpaces: vi.fn() }));
import { fetchSpaces } from "../spaces-api";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Spaces />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => vi.clearAllMocks());

describe("Spaces gallery", () => {
  it("lists every Space as a card linking to its shell", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      {
        name: "pr-timeline",
        title: "PR timeline",
        description: "Open PRs in one place",
        ownerEmail: "dev@example.com",
        visibility: "org",
        updatedAt: Date.now() - 2 * 3_600_000,
        mine: true,
      },
      {
        name: "drive-upload",
        title: "Drive upload",
        description: null,
        ownerEmail: "teammate@example.com",
        visibility: "users",
        updatedAt: Date.now() - 3 * 86_400_000,
        mine: false,
      },
    ]);
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Spaces" })).toBeInTheDocument();

    const first = await screen.findByRole("link", { name: /PR timeline/ });
    expect(first).toHaveAttribute("href", "/s/pr-timeline");
    expect(first).toHaveTextContent("Open PRs in one place");
    expect(first).toHaveTextContent("dev@example.com");
    expect(first).toHaveTextContent("updated 2h ago");

    const second = screen.getByRole("link", { name: /Drive upload/ });
    expect(second).toHaveAttribute("href", "/s/drive-upload");
    expect(second).toHaveTextContent("updated 3d ago");

    expect(screen.getAllByText("Yours")).toHaveLength(1);
    expect(screen.getByText("Everyone signed in")).toBeInTheDocument();
    expect(screen.getByText("Shared")).toBeInTheDocument();
  });

  it("tags delegated Spaces, and paused ones, in the badge row", async () => {
    const base = { description: null, ownerEmail: "dev@example.com", visibility: "org" as const, updatedAt: Date.now(), mine: true };
    vi.mocked(fetchSpaces).mockResolvedValue([
      { ...base, name: "a", title: "Sprint Board", delegate_access: true, delegation_suspended: false },
      { ...base, name: "b", title: "Release Checklist", delegate_access: true, delegation_suspended: true },
      // A viewer of a paused Space: not in effect, but paused.
      { ...base, name: "c", title: "Viewer view", mine: false, delegate_access: false, delegation_suspended: true },
      { ...base, name: "d", title: "PR Timeline", delegate_access: false, delegation_suspended: false },
    ]);
    renderPage();
    const badges = async (title: string) =>
      (await screen.findByRole("link", { name: new RegExp(title) })).closest(".space-gallery-cell")!.querySelector(".space-gallery-badges")!;
    expect(await badges("Sprint Board")).toHaveTextContent(/^YoursEveryone signed inDelegated$/);
    expect(await badges("Release Checklist")).toHaveTextContent("Delegated, paused");
    expect(await badges("Viewer view")).toHaveTextContent("Delegated, paused");
    expect(await badges("PR Timeline")).not.toHaveTextContent("Delegated");
  });

  it("explains how to create one when there are none", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/You create one by asking an agent/)).toBeInTheDocument();
    expect(screen.getByText(`"${EXAMPLE_PROMPT}"`)).toBeInTheDocument();
  });

  it("says so when the list fails to load", async () => {
    vi.mocked(fetchSpaces).mockRejectedValue(new Error("nope"));
    renderPage();
    expect(await screen.findByText("Could not load Spaces.")).toBeInTheDocument();
  });
});
