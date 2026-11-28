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
  deleteSpace: vi.fn(),
}));
vi.mock("../approvals-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../approvals-api")>()),
  fetchApprovals: vi.fn(),
  approveApproval: vi.fn(),
  rejectApproval: vi.fn(),
}));
import { fetchApprovals, approveApproval } from "../approvals-api";
import { fetchSpaces, setSpaceFavorite, updateSpaceDetails, fetchSpace, deleteSpace } from "../spaces-api";

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

const tileOf = (title: string) => screen.getByRole("button", { name: title }).closest(".space-tile") as HTMLElement;
const tileTitles = () => Array.from(document.querySelectorAll(".space-tile-link")).map((a) => a.textContent);
const titlesIn = (section: string) => {
  const heading = screen.getByRole("heading", { level: 2, name: section });
  return Array.from(heading.closest("section")!.querySelectorAll(".space-tile-link")).map((a) => a.textContent);
};

beforeEach(() => vi.clearAllMocks());

describe("Spaces gallery", () => {
  it("shows each Space as a tile that opens its detail, with its details", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "pr-timeline", title: "PR timeline", description: "Open PRs in one place", ownerEmail: "dev@example.com", updatedAt: Date.now() - 2 * 3_600_000, mine: true }),
      space({ name: "drive-upload", title: "Drive upload", visibility: "users", updatedAt: Date.now() - 3 * DAY }),
    ]);
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Spaces" })).toBeInTheDocument();

    expect(await screen.findByRole("button", { name: "PR timeline" })).toBeInTheDocument();
    const first = tileOf("PR timeline");
    expect(first).toHaveTextContent("Open PRs in one place");
    expect(first).toHaveTextContent("You · updated 2h ago");
    expect(tileOf("Drive upload")).toHaveTextContent("teammate@example.com · updated 3d ago");

    expect(screen.getAllByText("Yours")).toHaveLength(1);
    // Own tile: the audience icon is the button that opens sharing. Someone else's: a labelled icon.
    expect(within(tileOf("PR timeline")).getByRole("button", { name: "Change who can open PR timeline. Now: Everyone signed in" })).toBeInTheDocument();
    expect(within(tileOf("Drive upload")).getByRole("img", { name: "Audience: Shared" })).toBeInTheDocument();
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
    await screen.findByRole("button", { name: "Sprint Board" });
    const badges = (t: string) => tileOf(t).querySelector(".space-tile-badges")!;
    const names = (t: string) => within(tileOf(t)).queryAllByRole("img").map((e) => e.getAttribute("aria-label"));
    expect(badges("Sprint Board")).toHaveTextContent(/^Yours/);
    expect(names("Sprint Board")).toEqual(["Delegated"]);
    expect(names("Release Checklist")).toEqual(["Delegated, paused"]);
    expect(names("Viewer view")).toEqual(["Audience: Everyone signed in", "Delegated, paused"]);
    expect(names("PR Timeline")).toEqual([]);
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
    await screen.findByRole("button", { name: "Brand new" });
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
    await screen.findByRole("button", { name: "Sprint board" });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Spaces" }), { target: { value: "deploy" } });
    expect(screen.queryByRole("button", { name: "Sprint board" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release checklist" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ops@" } });
    expect(screen.getByRole("button", { name: "Capacity" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("No Space matches that.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(tileTitles()).toEqual(["Sprint board"]);
    fireEvent.click(screen.getByRole("button", { name: "Shared with me" }));
    expect(tileTitles().sort()).toEqual(["Capacity", "Release checklist"]);
  });

  it("shows the owner how many people used a Space, in words, and a viewer nothing", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "a", title: "Mine A", mine: true, viewers_30d: 12 }),
      space({ name: "b", title: "Mine B", mine: true, viewers_30d: 1 }),
      space({ name: "c", title: "Theirs" }),
    ]);
    renderPage();
    await screen.findByRole("button", { name: "Mine A" });
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
    await screen.findByRole("button", { name: "Liked" });
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
    await screen.findByRole("button", { name: "Candidate" });
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
    await screen.findByRole("button", { name: "Candidate" });
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

const openDetail = async (title: string) => {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  return screen.findByRole("dialog");
};

describe("the Space detail modal", () => {
  beforeEach(() => {
    vi.mocked(fetchSpace).mockReturnValue(new Promise(() => {}));
  });

  it("opens on a click of the tile body and does not navigate", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Sprint board", description: "Every card", ownerEmail: "dev@example.com" })]);
    renderPage();
    const dialog = await openDetail("Sprint board");
    expect(within(dialog).getByRole("heading", { name: "Sprint board" })).toBeInTheDocument();
    expect(within(dialog).getByText("Every card")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/s/a");
  });

  it("opens from the keyboard: the tile body is a real button", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Sprint board" })]);
    renderPage();
    const body = await screen.findByRole("button", { name: "Sprint board" });
    expect(body.tagName).toBe("BUTTON");
  });

  it("the heart toggles without opening anything", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Sprint board" })]);
    vi.mocked(setSpaceFavorite).mockResolvedValue({ favorited: true, favorite_count: 1 });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Favorite Sprint board" }));
    await waitFor(() => expect(setSpaceFavorite).toHaveBeenCalledWith("a", true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no owner menu on the tile", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Mine tile", mine: true })]);
    renderPage();
    await screen.findByRole("button", { name: "Mine tile" });
    expect(screen.queryByRole("button", { name: /Manage/ })).not.toBeInTheDocument();
  });

  it("shows the owner Edit sharing and Delete Space, and a viewer only Open and the heart", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Owned", mine: true }), space({ name: "b", title: "Theirs" })]);
    renderPage();
    const own = await openDetail("Owned");
    for (const n of ["Edit sharing", "Delete Space"]) expect(within(own).getByRole("button", { name: n })).toBeInTheDocument();
    fireEvent.click(within(own).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const theirs = await openDetail("Theirs");
    expect(within(theirs).getByRole("link", { name: "Open" })).toBeInTheDocument();
    expect(within(theirs).getByRole("button", { name: "Favorite Theirs" })).toBeInTheDocument();
    for (const n of ["Edit sharing", "Delete Space"]) expect(within(theirs).queryByRole("button", { name: n })).not.toBeInTheDocument();
  });

  it("shows tool names grouped by app once the detail loads, and the rest at once", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Board", favorite_count: 3, ownerEmail: "dev@example.com" })]);
    let finish!: (v: never) => void;
    vi.mocked(fetchSpace).mockReturnValue(new Promise((r) => (finish = r as never)));
    renderPage();
    const dialog = await openDetail("Board");
    expect(dialog).toHaveTextContent("dev@example.com");
    expect(dialog).toHaveTextContent("Loading tools");
    finish({
      tools: [
        { name: "list_prs", integration: "github", integrationName: "GitHub" },
        { name: "create_issue", integration: "github", integrationName: "GitHub" },
        { name: "list_files", integration: "drive", integrationName: "Drive" },
      ],
    } as never);
    expect(await within(dialog).findByText("list_prs")).toBeInTheDocument();
    expect(within(dialog).getByText("GitHub")).toBeInTheDocument();
    expect(within(dialog).getByText("Drive")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/^(list_prs|create_issue|list_files)$/)).toHaveLength(3);
  });

  it("shows the opened text to the owner only when the count is present", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "a", title: "With count", mine: true, viewers_30d: 12 }),
      space({ name: "b", title: "No count", mine: true }),
      space({ name: "c", title: "Not mine", viewers_30d: 5 }),
    ]);
    renderPage();
    const first = await openDetail("With count");
    expect(first).toHaveTextContent("12 opened it in 30 days");
    fireEvent.click(within(first).getByRole("button", { name: "Close" }));
    const second = await openDetail("No count");
    expect(second).not.toHaveTextContent("opened it in");
    fireEvent.click(within(second).getByRole("button", { name: "Close" }));
    const third = await openDetail("Not mine");
    expect(third).not.toHaveTextContent("opened it in");
  });

  it("credits the owner on the hero, before the description", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "a", title: "Theirs", description: "Some words", ownerEmail: "owner@example.com" }),
      space({ name: "b", title: "Owned by me", description: "My words", ownerEmail: "me@example.com", mine: true }),
    ]);
    renderPage();
    const theirs = await openDetail("Theirs");
    const credit = within(theirs).getByText("by owner@example.com");
    expect(credit.closest(".space-detail-hero-text")).not.toBeNull();
    expect(credit.compareDocumentPosition(within(theirs).getByText("Some words")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(theirs).queryByText("Owner")).not.toBeInTheDocument();
    fireEvent.click(within(theirs).getByRole("button", { name: "Close" }));
    const mine = await openDetail("Owned by me");
    expect(within(mine).getByText("by you")).toBeInTheDocument();
    expect(mine).not.toHaveTextContent("me@example.com");
  });

  it("shows likes with their word, and Updated, on one line of facts", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "a", title: "Many", favorite_count: 4, updatedAt: Date.now() - 2 * 3600 * 1000 }),
      space({ name: "b", title: "One", favorite_count: 1 }),
    ]);
    renderPage();
    const many = await openDetail("Many");
    const heart = within(many).getByRole("button", { name: "Favorite Many" });
    expect(heart).toHaveTextContent("4 likes");
    expect(many).toHaveTextContent(/Updated 2h ago/);
    expect(heart.closest(".space-detail-facts-line")).toBe(within(many).getByText(/Updated/).closest(".space-detail-facts-line"));
    fireEvent.click(within(many).getByRole("button", { name: "Close" }));
    const one = await openDetail("One");
    expect(within(one).getByRole("button", { name: "Favorite One" })).toHaveTextContent("1 like");
    expect(within(one).getByRole("button", { name: "Favorite One" })).not.toHaveTextContent("1 likes");
  });

  describe("tools in the detail", () => {
    const tool = (i: number, over: Record<string, unknown> = {}) => ({
      name: `tool_${i}`,
      integration: "acme",
      integrationName: "Acme",
      effect: "read",
      description: `Does thing ${i}`,
      ...over,
    });
    const inApp = (app: string, i: number, over: Record<string, unknown> = {}) =>
      tool(i, { integration: app.toLowerCase(), integrationName: app, ...over });
    const openWith = async (tools: unknown[]) => {
      vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Board" })]);
      vi.mocked(fetchSpace).mockResolvedValue({ tools } as never);
      renderPage();
      return openDetail("Board");
    };
    const threeApps = () => [inApp("Acme", 1), inApp("Acme", 2, { effect: "write" }), inApp("Demo", 3), inApp("Other", 4, { effect: "delete" })];

    it("summarises the totals by effect and leaves out zero counts and missing tools", async () => {
      const dialog = await openWith([
        tool(1),
        tool(2),
        tool(3, { effect: "write" }),
        tool(4, { effect: "delete" }),
        tool(5, { missing: true, effect: undefined }),
      ]);
      await within(dialog).findByText("Acme");
      const summary = dialog.querySelector(".space-detail-tool-summary") as HTMLElement;
      expect(summary).toHaveTextContent("2 read");
      expect(summary).toHaveTextContent("1 write");
      expect(summary).toHaveTextContent("1 delete");
    });

    it("shows only the non-zero summary chips", async () => {
      const dialog = await openWith([tool(1), tool(2)]);
      await within(dialog).findByText("Acme");
      const summary = dialog.querySelector(".space-detail-tool-summary") as HTMLElement;
      expect(summary).toHaveTextContent("2 read");
      expect(summary).not.toHaveTextContent("write");
      expect(summary).not.toHaveTextContent("delete");
    });

    it("counts per app on the app header", async () => {
      const dialog = await openWith([tool(1), tool(2), tool(3, { effect: "write" }), tool(4, { effect: "delete" }), tool(5, { effect: "delete" }), inApp("Demo", 9)]);
      const head = await within(dialog).findByRole("button", { name: /Acme/ });
      expect(head).toHaveTextContent("2 reads");
      expect(head).toHaveTextContent("1 write");
      expect(head).not.toHaveTextContent("1 writes");
      expect(head).toHaveTextContent("2 deletes");
    });

    it("uses singular chip words for one and plural for more on the app header", async () => {
      const one = await openWith([tool(1), tool(2, { effect: "write" }), tool(3, { effect: "delete" }), inApp("Demo", 9)]);
      const oneHead = await within(one).findByRole("button", { name: /Acme/ });
      expect(oneHead).toHaveTextContent("1 read");
      expect(oneHead).not.toHaveTextContent("1 reads");
      expect(oneHead).toHaveTextContent("1 write");
      expect(oneHead).not.toHaveTextContent("1 writes");
      expect(oneHead).toHaveTextContent("1 delete");
      expect(oneHead).not.toHaveTextContent("1 deletes");
    });

    it("uses plural chip words for several on the app header", async () => {
      const dialog = await openWith([tool(1), tool(2), tool(3, { effect: "write" }), tool(4, { effect: "write" }), tool(5, { effect: "write" }), inApp("Demo", 9)]);
      const head = await within(dialog).findByRole("button", { name: /Acme/ });
      expect(head).toHaveTextContent("2 reads");
      expect(head).toHaveTextContent("3 writes");
    });

    it("names an app header with a space before its chips", async () => {
      const dialog = await openWith([tool(1), tool(2), tool(3, { effect: "write" }), inApp("Demo", 9)]);
      expect(await within(dialog).findByRole("button", { name: "Acme, 2 reads, 1 write" })).toBeInTheDocument();
    });

    it("leaves the per-app chips off the header when there is a single app", async () => {
      const dialog = await openWith([tool(1), tool(2, { effect: "write" })]);
      const head = await within(dialog).findByRole("button", { name: "Acme" });
      expect(head).not.toHaveTextContent("read");
      expect(head).not.toHaveTextContent("write");
      expect(dialog.querySelector(".space-detail-tool-summary")).toHaveTextContent("1 read");
    });

    it("opens the first app only when there are three apps", async () => {
      const dialog = await openWith(threeApps());
      const acme = await within(dialog).findByRole("button", { name: /Acme/ });
      expect(acme).toHaveAttribute("aria-expanded", "true");
      expect(within(dialog).getByRole("button", { name: /Demo/ })).toHaveAttribute("aria-expanded", "false");
      expect(within(dialog).getByRole("button", { name: /Other/ })).toHaveAttribute("aria-expanded", "false");
      expect(within(dialog).getByText("tool_1")).toBeInTheDocument();
      expect(within(dialog).queryByText("tool_3")).not.toBeInTheDocument();
      expect(within(dialog).queryByText("tool_4")).not.toBeInTheDocument();
    });

    it("opens every app when there are two or fewer", async () => {
      const dialog = await openWith([inApp("Acme", 1), inApp("Demo", 2)]);
      expect(await within(dialog).findByRole("button", { name: /Acme/ })).toHaveAttribute("aria-expanded", "true");
      expect(within(dialog).getByRole("button", { name: /Demo/ })).toHaveAttribute("aria-expanded", "true");
      expect(within(dialog).getByText("tool_2")).toBeInTheDocument();
    });

    it("toggles an app from its header", async () => {
      const dialog = await openWith(threeApps());
      const demo = await within(dialog).findByRole("button", { name: /Demo/ });
      expect(demo).toHaveAttribute("aria-controls");
      fireEvent.click(demo);
      expect(demo).toHaveAttribute("aria-expanded", "true");
      expect(within(dialog).getByText("tool_3")).toBeInTheDocument();
      fireEvent.click(demo);
      expect(demo).toHaveAttribute("aria-expanded", "false");
      expect(within(dialog).queryByText("tool_3")).not.toBeInTheDocument();
    });

    it("shows each tool with its effect badge", async () => {
      const dialog = await openWith([tool(1), tool(2, { effect: "write" }), tool(3, { effect: "delete" })]);
      const row = (await within(dialog).findByText("tool_2")).closest("button") as HTMLElement;
      expect(within(row).getByText("Writes")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /tool_1/ })).toHaveTextContent("Reads");
      expect(within(dialog).getByRole("button", { name: /tool_3/ })).toHaveTextContent("Deletes or changes");
    });

    it("reveals the description and the effect sentence on a click, and hides them on a second", async () => {
      const dialog = await openWith([tool(1), tool(2, { effect: "write", description: "Creates a record" }), tool(3, { effect: "delete" })]);
      const row = await within(dialog).findByRole("button", { name: /tool_2/ });
      expect(row).toHaveAttribute("aria-expanded", "false");
      expect(within(dialog).queryByText("Creates a record")).not.toBeInTheDocument();
      fireEvent.click(row);
      expect(row).toHaveAttribute("aria-expanded", "true");
      expect(within(dialog).getByText("Creates a record")).toBeInTheDocument();
      expect(within(dialog).getByText("Changes data in the connected app.")).toBeInTheDocument();
      fireEvent.click(row);
      expect(within(dialog).queryByText("Creates a record")).not.toBeInTheDocument();
      expect(within(dialog).queryByText("Changes data in the connected app.")).not.toBeInTheDocument();
    });

    it("has an effect sentence for each kind and lets several rows stay open", async () => {
      const dialog = await openWith([tool(1), tool(2, { effect: "delete" })]);
      fireEvent.click(await within(dialog).findByRole("button", { name: /tool_1/ }));
      fireEvent.click(within(dialog).getByRole("button", { name: /tool_2/ }));
      expect(within(dialog).getByText("Only reads data. Never changes anything.")).toBeInTheDocument();
      expect(within(dialog).getByText("Can delete or overwrite data.")).toBeInTheDocument();
    });

    it("shows a long description in full", async () => {
      const long = "word ".repeat(80).trim();
      const dialog = await openWith([tool(1, { description: long })]);
      fireEvent.click(await within(dialog).findByRole("button", { name: /tool_1/ }));
      expect(within(dialog).getByText(long)).toBeInTheDocument();
    });

    it("renders the description as markdown and the effect sentence as plain text", async () => {
      const dialog = await openWith([tool(1, { description: "**Note** use `id` first\n\n- one\n- two" })]);
      fireEvent.click(await within(dialog).findByRole("button", { name: /tool_1/ }));
      const panel = dialog.querySelector(".space-detail-tool-panel") as HTMLElement;
      expect(panel.querySelector("strong")).toHaveTextContent("Note");
      expect(panel.querySelector("code")).toHaveTextContent("id");
      expect(panel.querySelectorAll("li")).toHaveLength(2);
      expect(within(dialog).getByText("Only reads data. Never changes anything.").tagName).toBe("P");
    });

    it("treats a whitespace-only description as none", async () => {
      const dialog = await openWith([tool(1, { description: "   \n " })]);
      fireEvent.click(await within(dialog).findByRole("button", { name: /tool_1/ }));
      const panel = dialog.querySelector(".space-detail-tool-panel") as HTMLElement;
      expect(panel.children).toHaveLength(1);
      expect(panel).toHaveTextContent("Only reads data. Never changes anything.");
    });

    it("shows only the effect sentence for a tool with no description", async () => {
      const dialog = await openWith([tool(1, { description: undefined })]);
      fireEvent.click(await within(dialog).findByRole("button", { name: /tool_1/ }));
      expect(within(dialog).getByText("Only reads data. Never changes anything.")).toBeInTheDocument();
    });

    it("shows a missing tool as Missing, with nothing to expand", async () => {
      const dialog = await openWith([tool(1, { missing: true, effect: undefined, description: undefined })]);
      const name = await within(dialog).findByText("tool_1");
      expect(within(dialog).getByText("Missing")).toBeInTheDocument();
      expect(name.closest("button")).toBeNull();
      expect(within(dialog).queryByText("Deletes or changes")).not.toBeInTheDocument();
    });

    it("no longer has a Show all button", async () => {
      const dialog = await openWith([1, 2, 3, 4, 5, 6, 7].map((i) => tool(i)));
      await within(dialog).findByText("tool_1");
      expect(within(dialog).getAllByText(/^tool_\d$/)).toHaveLength(7);
      expect(within(dialog).queryByRole("button", { name: /Show/ })).not.toBeInTheDocument();
    });
  });

  it("the heart in the modal updates the count and the tile", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Board", favorite_count: 2 })]);
    vi.mocked(setSpaceFavorite).mockResolvedValue({ favorited: true, favorite_count: 3 });
    renderPage();
    const dialog = await openDetail("Board");
    fireEvent.click(within(dialog).getByRole("button", { name: "Favorite Board" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Favorite Board" })).toHaveAttribute("aria-pressed", "true"));
    expect(within(dialog).getByRole("button", { name: "Favorite Board" })).toHaveTextContent("3 likes");
    expect(setSpaceFavorite).toHaveBeenCalledWith("a", true);
  });

  it("edits the title in place in the detail, and the tile updates without a reload", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Old title", description: "Old words", mine: true })]);
    vi.mocked(updateSpaceDetails).mockResolvedValue({ title: "New title", description: null, updatedAt: 1 });
    renderPage();
    const detail = await openDetail("Old title");
    fireEvent.click(within(detail).getByRole("button", { name: "Edit title" }));
    fireEvent.change(within(detail).getByRole("textbox", { name: "Title" }), { target: { value: "  New title  " } });
    fireEvent.keyDown(within(detail).getByRole("textbox", { name: "Title" }), { key: "Enter" });

    await waitFor(() => expect(updateSpaceDetails).toHaveBeenCalledWith("a", { title: "New title", description: "Old words" }));
    expect(await within(detail).findByRole("button", { name: "Edit title" })).toHaveTextContent("New title");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(tileOf("New title")).getByRole("button", { name: "New title" })).toBeInTheDocument();
  });

  it("clears the description in place and the tile drops it", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Keep", description: "Old words", mine: true })]);
    vi.mocked(updateSpaceDetails).mockResolvedValue({ title: "Keep", description: null, updatedAt: 1 });
    renderPage();
    const detail = await openDetail("Keep");
    fireEvent.click(within(detail).getByRole("button", { name: "Edit description" }));
    fireEvent.change(within(detail).getByRole("textbox", { name: "Description" }), { target: { value: "" } });
    fireEvent.blur(within(detail).getByRole("textbox", { name: "Description" }));
    await waitFor(() => expect(updateSpaceDetails).toHaveBeenCalledWith("a", { title: "Keep", description: "" }));
    await waitFor(() => expect(tileOf("Keep")).not.toHaveTextContent("Old words"));
    expect(within(detail).getByRole("button", { name: "Edit description" })).toHaveTextContent("Add a description");
  });

  it("the audience badge on an owned tile opens Sharing, and on someone else's it is plain text", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([
      space({ name: "a", title: "Owned", mine: true, visibility: "users" }),
      space({ name: "b", title: "Theirs", visibility: "users" }),
    ]);
    renderPage();
    await screen.findByRole("button", { name: "Owned" });
    expect(within(tileOf("Theirs")).queryByRole("button", { name: /Change who can open/ })).not.toBeInTheDocument();
    fireEvent.click(within(tileOf("Owned")).getByRole("button", { name: "Change who can open Owned. Now: Shared" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Loading sharing settings");
    expect(fetchSpace).toHaveBeenCalledWith("a");
  });

  it("Edit sharing opens the sharing settings", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Owned", mine: true })]);
    renderPage();
    fireEvent.click(within(await openDetail("Owned")).getByRole("button", { name: "Edit sharing" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Loading sharing settings");
  });

  it("deletes a Space after the name is typed, closing both dialogs and dropping it from the list", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "Doomed", mine: true }), space({ name: "b", title: "Kept" })]);
    vi.mocked(deleteSpace).mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(within(await openDetail("Doomed")).getByRole("button", { name: "Delete Space" }));
    const confirm = (await screen.findAllByRole("dialog")).find((d) => d.textContent?.includes("cannot be undone"))!;
    const del = within(confirm).getByRole("button", { name: "Delete Space" });
    expect(del).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText(/Type the Space name/), { target: { value: "a" } });
    fireEvent.click(del);
    await waitFor(() => expect(deleteSpace).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Doomed" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kept" })).toBeInTheDocument();
  });

  describe("access requests", () => {
    const WARNING = "This Space runs with your connected apps. Approving lets this person use them.";
    const inboxItem = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      kind: "space.access" as const,
      subject: "pr-timeline",
      subject_label: "PR timeline",
      requester_email: `${id}@example.com`,
      message: `let me in ${id}`,
      status: "pending" as const,
      created_at: Math.floor(Date.now() / 1000) - 60,
      delegated: false,
      ...over,
    });

    it("shows a Requests chip summing the owner's open requests", async () => {
      vi.mocked(fetchSpaces).mockResolvedValue([
        space({ name: "a", title: "A", mine: true, pending_requests: 2 }),
        space({ name: "b", title: "B", mine: true, pending_requests: 1 }),
        space({ name: "c", title: "C", mine: false, pending_requests: 9 }),
      ]);
      renderPage();
      expect(await screen.findByRole("button", { name: /^Requests \(3\)/ })).toBeInTheDocument();
    });

    it("has no chip when nobody is waiting", async () => {
      vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "a", title: "A", mine: true, pending_requests: 0 }), space({ name: "b", title: "B" })]);
      renderPage();
      await screen.findByRole("button", { name: "A" });
      expect(screen.queryByRole("button", { name: /Requests/ })).not.toBeInTheDocument();
    });

    it("opens the list with requester, message, date and the delegated warning on the row that needs it", async () => {
      vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "pr-timeline", title: "PR timeline", mine: true, pending_requests: 2 })]);
      vi.mocked(fetchApprovals).mockResolvedValue([inboxItem("r1", { delegated: true }), inboxItem("r2")]);
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /^Requests \(2\)/ }));
      const dialog = await screen.findByRole("dialog", {}, { timeout: 2000 });
      expect(fetchApprovals).toHaveBeenCalledWith("inbox");
      expect(await within(dialog).findByText("r1@example.com")).toBeInTheDocument();
      expect(within(dialog).getByText("let me in r1")).toBeInTheDocument();
      expect(within(dialog).getAllByText(WARNING)).toHaveLength(1);
      expect(within(dialog).getByText("r1@example.com").closest("li")).toHaveTextContent(WARNING);
      expect(within(dialog).getByText("r2@example.com").closest("li")).not.toHaveTextContent(WARNING);
    });

    it("approving refreshes the gallery count", async () => {
      vi.mocked(fetchSpaces).mockResolvedValueOnce([space({ name: "pr-timeline", title: "PR timeline", mine: true, pending_requests: 1 })]);
      vi.mocked(fetchApprovals).mockResolvedValue([inboxItem("r1")]);
      vi.mocked(approveApproval).mockResolvedValue(undefined);
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /^Requests \(1\)/ }));
      vi.mocked(fetchSpaces).mockResolvedValue([space({ name: "pr-timeline", title: "PR timeline", mine: true, pending_requests: 0 })]);
      fireEvent.click(await screen.findByRole("button", { name: "Approve r1@example.com" }));
      await waitFor(() => expect(approveApproval).toHaveBeenCalledWith("r1"));
      await waitFor(() => expect(screen.queryByRole("button", { name: /^Requests \(/ })).not.toBeInTheDocument());
    });
  });
});
