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
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.getByText("Shared")).toBeInTheDocument();
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
