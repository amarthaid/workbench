import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import SpacesTab from "./SpacesTab";

const api = vi.hoisted(() => ({ fetchAdminSpaces: vi.fn() }));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));

const NOW_MS = 1_800_000_000_000;

function item(over: Record<string, unknown> = {}) {
  return {
    name: "release-desk",
    title: "Release desk",
    description: "Tracks the release train.",
    owner_email: "owner@example.com",
    visibility: "org",
    updated_at: NOW_MS - 3 * 86_400_000,
    share_count: 0,
    favorite_count: 4,
    openers_30d: 2,
    openers: [
      { email: "viewer@example.com", last_opened_at: NOW_MS - 2 * 86_400_000 },
      { email: "ana@example.com", last_opened_at: NOW_MS - 5 * 86_400_000 },
    ],
    ...over,
  };
}

const page = (spaces: unknown[], next: string | null = null) => ({ spaces, has_more: next !== null, next_cursor: next });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  api.fetchAdminSpaces.mockReset();
  api.fetchAdminSpaces.mockResolvedValue(page([item()]));
});
afterEach(() => vi.useRealTimers());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SpacesTab", () => {
  it("renders a card per Space with title, name, owner, audience, age, description, likes and openers", async () => {
    api.fetchAdminSpaces.mockResolvedValue(
      page([
        item(),
        item({ name: "secret", title: "Secret", visibility: "private", openers_30d: 0, openers: [], favorite_count: 0, description: null }),
        item({ name: "team", title: "Team", visibility: "users", share_count: 3, openers_30d: 1, openers: [{ email: "viewer@example.com", last_opened_at: NOW_MS - 3600_000 }] }),
      ])
    );
    renderWithClient(<SpacesTab />);
    const card = (await screen.findByText("Release desk")).closest("article")!;
    expect(card).toHaveTextContent("release-desk");
    expect(card).toHaveTextContent("owner@example.com");
    expect(card).toHaveTextContent("Everyone signed in");
    expect(card).toHaveTextContent("3d ago");
    expect(card).toHaveTextContent("Tracks the release train.");
    expect(within(card).getByText("Tracks the release train.")).toHaveClass("admin-space-desc");
    expect(card).toHaveTextContent("4 likes");
    expect(card).toHaveTextContent("2 people opened it in 30 days");
    expect(screen.getByText("Secret").closest("article")).toHaveTextContent("Only me");
    expect(screen.getByText("Secret").closest("article")).toHaveTextContent("No one opened it in 30 days");
    expect(screen.getByText("Team").closest("article")).toHaveTextContent("Specific people (3)");
    expect(screen.getByText("Team").closest("article")).toHaveTextContent("1 person opened it in 30 days");
    expect(api.fetchAdminSpaces).toHaveBeenCalledWith({ q: "", cursor: undefined });
  });

  it("expand lists who opened it and when, with and N more beyond the list", async () => {
    api.fetchAdminSpaces.mockResolvedValue(page([item({ openers_30d: 57 })]));
    renderWithClient(<SpacesTab />);
    const card = (await screen.findByText("Release desk")).closest("article")!;
    expect(within(card).queryByText("viewer@example.com")).not.toBeInTheDocument();
    const toggle = within(card).getByRole("button", { name: /57 people opened it in 30 days/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const row = within(card).getByText("viewer@example.com").closest("li")!;
    expect(row).toHaveTextContent("2d ago");
    expect(within(card).getByText("ana@example.com").closest("li")).toHaveTextContent("5d ago");
    expect(card).toHaveTextContent("and 55 more");
    fireEvent.click(toggle);
    expect(within(card).queryByText("viewer@example.com")).not.toBeInTheDocument();
  });

  it("does not say and N more when every opener is listed", async () => {
    renderWithClient(<SpacesTab />);
    const card = (await screen.findByText("Release desk")).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: /2 people opened it/ }));
    expect(card).not.toHaveTextContent(/and \d+ more/);
  });

  it("Load more fetches the next page with the cursor and appends it", async () => {
    api.fetchAdminSpaces
      .mockResolvedValueOnce(page([item()], "cur-1"))
      .mockResolvedValueOnce(page([item({ name: "second", title: "Second" })]));
    renderWithClient(<SpacesTab />);
    await screen.findByText("Release desk");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second")).toBeInTheDocument();
    expect(screen.getByText("Release desk")).toBeInTheDocument();
    expect(api.fetchAdminSpaces).toHaveBeenLastCalledWith({ q: "", cursor: "cur-1" });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("has no Load more on a single page", async () => {
    renderWithClient(<SpacesTab />);
    await screen.findByText("Release desk");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("searches after a pause with at least 2 characters, one request for fast typing", async () => {
    renderWithClient(<SpacesTab />);
    await screen.findByText("Release desk");
    const box = screen.getByRole("searchbox", { name: "Search Spaces" });
    for (const v of ["r", "re", "rel", "rele"]) fireEvent.change(box, { target: { value: v } });
    await sleep(400);
    await waitFor(() => expect(api.fetchAdminSpaces).toHaveBeenCalledTimes(2));
    expect(api.fetchAdminSpaces).toHaveBeenLastCalledWith({ q: "rele", cursor: undefined });
  });

  it("one character sends no search and keeps the full list", async () => {
    renderWithClient(<SpacesTab />);
    await screen.findByText("Release desk");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Spaces" }), { target: { value: "r" } });
    await sleep(400);
    expect(api.fetchAdminSpaces).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Release desk")).toBeInTheDocument();
  });

  it("clearing the search goes back to the full list from cache", async () => {
    renderWithClient(<SpacesTab />);
    await screen.findByText("Release desk");
    const box = screen.getByRole("searchbox", { name: "Search Spaces" });
    fireEvent.change(box, { target: { value: "zz" } });
    await sleep(400);
    await waitFor(() => expect(api.fetchAdminSpaces).toHaveBeenCalledTimes(2));
    fireEvent.change(box, { target: { value: "" } });
    await sleep(400);
    expect(await screen.findByText("Release desk")).toBeInTheDocument();
    expect(api.fetchAdminSpaces).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state, distinct for a search", async () => {
    api.fetchAdminSpaces.mockResolvedValue(page([]));
    renderWithClient(<SpacesTab />);
    expect(await screen.findByText("No Spaces yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Spaces" }), { target: { value: "zz" } });
    await sleep(400);
    expect(await screen.findByText("No Space matches this search.")).toBeInTheDocument();
  });

  it("shows an error state", async () => {
    api.fetchAdminSpaces.mockRejectedValue(new Error("boom"));
    renderWithClient(<SpacesTab />);
    expect(await screen.findByText("Couldn't load Spaces.")).toBeInTheDocument();
  });

  it("puts the generated cover on the card as a thin left band", async () => {
    renderWithClient(<SpacesTab />);
    const card = (await screen.findByText("Release desk")).closest("article")!;
    expect(card).toHaveClass("admin-space");
    const cover = card.querySelector(".admin-space-cover .space-cover");
    expect(cover).not.toBeNull();
    // A band, not a tile: no initial letter on it.
    expect(cover!.querySelector(".space-cover-initial")).toBeNull();
  });
});
