import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Spaces, { EXAMPLE_PROMPT } from "./Spaces";
import type { SpaceSummary } from "../spaces-api";

vi.mock("../spaces-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spaces-api")>()),
  fetchSpaces: vi.fn(),
  setSpaceFavorite: vi.fn(),
  updateSpaceDetails: vi.fn(),
  fetchSpace: vi.fn(),
}));
import { fetchSpaces, setSpaceFavorite, updateSpaceDetails, fetchSpace } from "../spaces-api";

const DAY = 86_400_000;

function space(over: Partial<SpaceSummary> & { name: string; title: string }): SpaceSummary {
  return {
    description: null,
    ownerEmail: "teammate@example.com",
    visibility: "org",
    updatedAt: Date.now() - 20 * DAY,
    mine: false,
    favorited: false,
    favorite_count: 0,
    last_opened_at: null,
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Spaces />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, ...view };
}

const tileOf = (title: string) => screen.getByRole("link", { name: title }).closest(".space-tile") as HTMLElement;
const titlesIn = (section: string) => {
  const heading = screen.getByRole("heading", { level: 2, name: section });
  return within(heading.closest("section")!)
    .getAllByRole("link")
    .map((a) => a.textContent);
};

beforeEach(() => vi.clearAllMocks());

describe("Spaces gallery", () => {
  it("shows each Space as a tile linking to its shell, with its details", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "pr-timeline", title: "PR timeline", description: "Open PRs in one place", ownerEmail: "dev@example.com", updatedAt: Date.now() - 2 * 3_600_000, mine: true }),
      space({ name: "drive-upload", title: "Drive upload", visibility: "users", updatedAt: Date.now() - 3 * DAY }),
    ]);
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Spaces" })).toBeInTheDocument();

    expect(await screen.findByRole("link", { name: "PR timeline" })).toHaveAttribute("href", "/s/pr-timeline");
    const first = tileOf("PR timeline");
    expect(first).toHaveTextContent("Open PRs in one place");
    expect(first).toHaveTextContent("You · updated 2h ago");
    expect(screen.getByRole("link", { name: "Drive upload" })).toHaveAttribute("href", "/s/drive-upload");
    expect(tileOf("Drive upload")).toHaveTextContent("teammate@example.com · updated 3d ago");

    expect(screen.getAllByText("Yours")).toHaveLength(1);
    expect(screen.getByText("Everyone signed in")).toBeInTheDocument();
    expect(screen.getByText("Shared")).toBeInTheDocument();
  });

  it("tags delegated Spaces, and paused ones, in the badge row", async () => {
    const base = { description: null, visibility: "org" as const, updatedAt: Date.now() };
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ ...base, name: "a", title: "Sprint Board", mine: true, delegate_access: true, delegation_suspended: false }),
      space({ ...base, name: "b", title: "Release Checklist", mine: true, delegate_access: true, delegation_suspended: true }),
      space({ ...base, name: "c", title: "Viewer view", delegate_access: false, delegation_suspended: true }),
      space({ ...base, name: "d", title: "PR Timeline", mine: true, delegate_access: false, delegation_suspended: false }),
    ]);
    renderPage();
    await screen.findByRole("link", { name: "Sprint Board" });
    const badges = (t: string) => tileOf(t).querySelector(".space-tile-badges")!;
    expect(badges("Sprint Board")).toHaveTextContent(/^YoursEveryone signed inDelegated$/);
    expect(badges("Release Checklist")).toHaveTextContent("Delegated, paused");
    expect(badges("Viewer view")).toHaveTextContent("Delegated, paused");
    expect(badges("PR Timeline")).not.toHaveTextContent("Delegated");
  });

  it("explains how to create one when there are none, and shows no search", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/You create one by asking an agent/)).toBeInTheDocument();
    expect(screen.getByText(`"${EXAMPLE_PROMPT}"`)).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("says so when the list fails to load", async () => {
    vi.mocked(fetchSpaces).mockRejectedValue(new Error("nope"));
    renderPage();
    expect(await screen.findByText("Could not load Spaces.")).toBeInTheDocument();
  });
});

describe("how the gallery is arranged for the person", () => {
  it("puts favorites first as large tiles, then what they opened lately, then the rest by update", async () => {
    const t = Date.now();
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "old", title: "Old one", updatedAt: t - 90 * DAY }),
      space({ name: "fresh", title: "Fresh one", updatedAt: t - 1 * DAY, last_opened_at: t - 60_000 }),
      space({ name: "loved", title: "Loved one", updatedAt: t - 40 * DAY, favorited: true, favorite_count: 7 }),
      space({ name: "mid", title: "Middle one", updatedAt: t - 30 * DAY }),
    ]);
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Favorites" });
    expect(titlesIn("Favorites")).toEqual(["Loved one"]);
    expect(tileOf("Loved one")).toHaveClass("space-tile-large");
    expect(titlesIn("Recently opened")).toEqual(["Fresh one"]);
    expect(tileOf("Fresh one")).toHaveClass("space-tile-compact");
    expect(titlesIn("All Spaces")).toEqual(["Middle one", "Old one"]);
  });

  it("marks a Space someone shared recently and I have not opened as New, and never my own", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "n", title: "Brand new", updatedAt: Date.now() - 2 * DAY }),
      space({ name: "m", title: "My new", updatedAt: Date.now() - 2 * DAY, mine: true }),
      space({ name: "o", title: "Opened already", updatedAt: Date.now() - 2 * DAY, last_opened_at: Date.now() - DAY }),
      space({ name: "s", title: "Stale", updatedAt: Date.now() - 60 * DAY }),
    ]);
    renderPage();
    await screen.findByRole("link", { name: "Brand new" });
    expect(tileOf("Brand new")).toHaveTextContent("New");
    expect(within(tileOf("My new")).queryByText("New")).not.toBeInTheDocument();
    expect(within(tileOf("Opened already")).queryByText("New")).not.toBeInTheDocument();
    expect(within(tileOf("Stale")).queryByText("New")).not.toBeInTheDocument();
  });

  it("filters by search and by Mine or Shared with me", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "a", title: "Sprint board", mine: true }),
      space({ name: "b", title: "Release checklist", description: "before each deploy" }),
      space({ name: "c", title: "Capacity", ownerEmail: "ops@example.com" }),
    ]);
    renderPage();
    await screen.findByRole("link", { name: "Sprint board" });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Spaces" }), { target: { value: "deploy" } });
    expect(screen.queryByRole("link", { name: "Sprint board" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release checklist" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ops@" } });
    expect(screen.getByRole("link", { name: "Capacity" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("No Space matches that.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["Sprint board"]);
    fireEvent.click(screen.getByRole("button", { name: "Shared with me" }));
    expect(screen.getAllByRole("link").map((a) => a.textContent).sort()).toEqual(["Capacity", "Release checklist"]);
  });

  it("shows the owner how many people used a Space, in words, and a viewer nothing", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "a", title: "Mine A", mine: true, viewers_30d: 12 }),
      space({ name: "b", title: "Mine B", mine: true, viewers_30d: 1 }),
      space({ name: "c", title: "Theirs" }),
    ]);
    renderPage();
    await screen.findByRole("link", { name: "Mine A" });
    expect(tileOf("Mine A")).toHaveTextContent("12 people this month");
    expect(tileOf("Mine B")).toHaveTextContent("1 person this month");
    expect(tileOf("Theirs")).not.toHaveTextContent("this month");
  });
});

describe("favorites", () => {
  it("shows the count only when someone has favorited it, and the state of my heart", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "a", title: "Liked", favorite_count: 5, favorited: true }),
      space({ name: "b", title: "Unliked" }),
    ]);
    renderPage();
    await screen.findByRole("link", { name: "Liked" });
    const liked = within(tileOf("Liked")).getByRole("button", { name: "Favorite Liked" });
    expect(liked).toHaveAttribute("aria-pressed", "true");
    expect(liked).toHaveTextContent("5");
    const unliked = within(tileOf("Unliked")).getByRole("button", { name: "Favorite Unliked" });
    expect(unliked).toHaveAttribute("aria-pressed", "false");
    expect(unliked).toHaveTextContent("");
  });

  it("moves a Space into Favorites at once, then settles on the count the server returns", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Candidate", favorite_count: 2 })]);
    let finish!: (v: { favorited: boolean; favorite_count: number }) => void;
    vi.mocked(setSpaceFavorite).mockReturnValue(new Promise((r) => (finish = r)));
    renderPage();
    await screen.findByRole("link", { name: "Candidate" });
    fireEvent.click(screen.getByRole("button", { name: "Favorite Candidate" }));

    // Before the server answers.
    await screen.findByRole("heading", { level: 2, name: "Favorites" });
    expect(tileOf("Candidate")).toHaveClass("space-tile-large");
    expect(within(tileOf("Candidate")).getByRole("button", { name: "Favorite Candidate" })).toHaveTextContent("3");
    expect(setSpaceFavorite).toHaveBeenCalledWith("a", true);

    finish({ favorited: true, favorite_count: 9 });
    await waitFor(() => expect(within(tileOf("Candidate")).getByRole("button", { name: "Favorite Candidate" })).toHaveTextContent("9"));
  });

  it("puts it back when the server refuses", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Candidate" })]);
    vi.mocked(setSpaceFavorite).mockRejectedValue(new Error("nope"));
    renderPage();
    await screen.findByRole("link", { name: "Candidate" });
    fireEvent.click(screen.getByRole("button", { name: "Favorite Candidate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Favorite Candidate" })).toHaveAttribute("aria-pressed", "false"));
    expect(screen.queryByRole("heading", { level: 2, name: "Favorites" })).not.toBeInTheDocument();
  });

  it("unfavoriting takes it out of Favorites", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Was loved", favorited: true, favorite_count: 1 })]);
    vi.mocked(setSpaceFavorite).mockResolvedValue({ favorited: false, favorite_count: 0 });
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Favorites" });
    fireEvent.click(screen.getByRole("button", { name: "Favorite Was loved" }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 2, name: "Favorites" })).not.toBeInTheDocument());
    expect(setSpaceFavorite).toHaveBeenCalledWith("a", false);
  });

  it("keeps the wall of large tiles to six, and shows the rest as compact ones", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => space({ name: `s${i}`, title: `Fav ${i}`, favorited: true, last_opened_at: Date.now() - i * 1000 }))
    );
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Favorites" });
    expect(document.querySelectorAll(".space-tile-large")).toHaveLength(6);
    expect(document.querySelectorAll(".space-tile-compact")).toHaveLength(2);
  });
});

describe("editing from the gallery", () => {
  it("offers the menu to the owner only", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Mine", mine: true }), space({ name: "b", title: "Theirs" })]);
    renderPage();
    await screen.findByRole("link", { name: "Mine" });
    expect(within(tileOf("Mine")).getByRole("button", { name: "Manage Mine" })).toBeInTheDocument();
    expect(within(tileOf("Theirs")).queryByRole("button", { name: /Manage/ })).not.toBeInTheDocument();
  });

  it("edits the title and description in a dialog and the tile updates without a reload", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Old title", description: "Old words", mine: true })]);
    vi.mocked(updateSpaceDetails).mockResolvedValue({ title: "New title", description: null, updatedAt: 1 });
    renderPage();
    await screen.findByRole("link", { name: "Old title" });
    fireEvent.click(screen.getByRole("button", { name: "Manage Old title" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit details" }));

    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled(); // nothing changed yet
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "  New title  " } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(updateSpaceDetails).toHaveBeenCalledWith("a", { title: "New title", description: "" });
    expect(screen.getByRole("link", { name: "New title" })).toBeInTheDocument();
    expect(tileOf("New title")).not.toHaveTextContent("Old words");
  });

  it("will not save an empty title, and shows the server's reason when it refuses", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Keep", mine: true })]);
    const { SpaceApiError } = await import("../spaces-api");
    vi.mocked(updateSpaceDetails).mockRejectedValue(new SpaceApiError(409, { code: "CONFLICT", message: "changed" }));
    renderPage();
    await screen.findByRole("link", { name: "Keep" });
    fireEvent.click(screen.getByRole("button", { name: "Manage Keep" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit details" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "   " } });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/changed while you were editing/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("the audience badge on an owned tile opens Sharing, and on someone else's it is plain text", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "a", title: "Mine", mine: true, visibility: "users" }),
      space({ name: "b", title: "Theirs", visibility: "users" }),
    ]);
    vi.mocked(fetchSpace).mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByRole("link", { name: "Mine" });
    expect(within(tileOf("Theirs")).queryByRole("button", { name: /Change who can open/ })).not.toBeInTheDocument();
    const badge = within(tileOf("Mine")).getByRole("button", { name: "Change who can open Mine. Now: Shared" });
    fireEvent.click(badge);
    expect(await screen.findByRole("dialog")).toHaveTextContent("Loading sharing settings");
    expect(fetchSpace).toHaveBeenCalledWith("a");
  });

  it("opens the sharing settings from the same menu, without opening the Space", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Mine", mine: true })]);
    vi.mocked(fetchSpace).mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByRole("link", { name: "Mine" });
    fireEvent.click(screen.getByRole("button", { name: "Manage Mine" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sharing" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Loading sharing settings");
    expect(fetchSpace).toHaveBeenCalledWith("a");
  });
});
