import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import { SpaceDetailModal } from "./SpaceDetailModal";
import { SpaceApiError, updateSpaceDetails, type SpaceSummary } from "../spaces-api";

vi.mock("../spaces-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spaces-api")>()),
  fetchSpace: vi.fn(async () => ({ tools: [], users: [] })),
  updateSpaceDetails: vi.fn(),
}));

function space(over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    name: "pr-timeline",
    title: "PR timeline",
    description: null,
    ownerEmail: "owner@example.com",
    visibility: "org",
    updatedAt: Date.now(),
    mine: false,
    favorited: false,
    favorite_count: 0,
    last_opened_at: null,
    ...over,
  };
}

const onClose = vi.fn();
const onDetailsSaved = vi.fn();
beforeEach(() => {
  onClose.mockReset();
  onDetailsSaved.mockReset();
  vi.mocked(updateSpaceDetails).mockReset();
});

function open(s: SpaceSummary) {
  return renderWithClient(
    <MemoryRouter>
      <SpaceDetailModal
        space={s}
        onClose={onClose}
        onToggleFavorite={() => {}}
        onDetailsSaved={onDetailsSaved}
        onEditSharing={() => {}}
        onDeleted={() => {}}
      />
    </MemoryRouter>
  );
}

const hero = () => document.querySelector(".space-detail-hero") as HTMLElement;

describe("SpaceDetailModal delegation chip", () => {
  it("shows Delegated beside the audience chip in the header band", () => {
    open(space({ delegate_access: true }));
    expect(within(hero()).getByRole("img", { name: "Audience: Everyone signed in" })).toBeInTheDocument();
    expect(within(hero()).getByRole("img", { name: "Delegated" })).toBeInTheDocument();
    expect(within(hero()).queryByRole("img", { name: "Delegated, paused" })).toBeNull();
  });

  it("shows Delegated, paused when the delegation is suspended", () => {
    open(space({ delegate_access: true, delegation_suspended: true }));
    expect(within(hero()).getByRole("img", { name: "Delegated, paused" })).toBeInTheDocument();
  });

  it("shows no chip for a Space without delegation", () => {
    open(space());
    expect(within(hero()).queryByRole("img", { name: /Delegated/ })).toBeNull();
  });
});

describe("SpaceDetailModal dialog name", () => {
  it("is named by the Space title", () => {
    open(space({ title: "PR timeline" }));
    expect(screen.getByRole("dialog", { name: "PR timeline" })).toBeInTheDocument();
  });
});

describe("SpaceDetailModal hero row", () => {
  it("puts the title first, then credit on the left and the icon indicators on the right", () => {
    open(space({ delegate_access: true, mine: true }));
    const text = hero().querySelector(".space-detail-hero-text") as HTMLElement;
    expect(text.firstElementChild?.tagName).toBe("H2");
    const row = text.querySelector(".space-detail-hero-row") as HTMLElement;
    expect(row).toHaveTextContent("by you");
    const side = row.querySelector(".space-detail-hero-side") as HTMLElement;
    expect(within(side).getByRole("img", { name: "Audience: Everyone signed in" })).toBeInTheDocument();
    expect(within(side).getByRole("img", { name: "Delegated" })).toBeInTheDocument();
    expect(side).not.toHaveTextContent("Everyone signed in");
    expect(within(hero()).queryByRole("link", { name: "Open" })).toBeNull();
  });

  it("gives a viewer a footer with just Open", () => {
    open(space());
    const foot = document.querySelector(".ui-modal-foot") as HTMLElement;
    const link = within(foot).getByRole("link", { name: "Open" });
    expect(link).toHaveAttribute("href", "/s/pr-timeline");
    expect(link.querySelector("svg")).not.toBeNull();
    expect(within(foot).queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps Edit sharing and Delete Space in the owner footer", () => {
    open(space({ mine: true }));
    const foot = document.querySelector(".ui-modal-foot") as HTMLElement;
    expect(within(foot).queryByRole("button", { name: "Edit details" })).toBeNull();
    expect(within(foot).getByRole("button", { name: "Edit sharing" })).toBeInTheDocument();
    expect(within(foot).getByRole("button", { name: "Delete Space" })).toBeInTheDocument();
    expect(within(foot).getByRole("link", { name: "Open" })).toBe(foot.lastElementChild);
  });
});

describe("SpaceDetailModal inline edit", () => {
  const mine = (over: Partial<SpaceSummary> = {}) => space({ mine: true, description: "Old words", ...over });

  it("shows plain text and no edit affordance to a viewer", () => {
    open(space({ description: "Old words" }));
    expect(screen.queryByRole("button", { name: "Edit title" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
    expect(screen.getByText("Old words")).toBeInTheDocument();
    expect(screen.queryByText(/set by the agent that built it/)).toBeNull();
  });

  it("offers an Add a description button to the owner when there is none", () => {
    open(mine({ description: null }));
    expect(screen.getByRole("button", { name: "Edit description" })).toHaveTextContent("Add a description");
    expect(screen.getByText(/set by the agent that built it/)).toBeInTheDocument();
  });

  it("saves the title on Enter, calls onDetailsSaved, and keeps the modal open", async () => {
    vi.mocked(updateSpaceDetails).mockResolvedValue({ title: "New title", description: "Old words", updatedAt: 1 });
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(updateSpaceDetails).toHaveBeenCalledWith("pr-timeline", { title: "New title", description: "Old words" }));
    await waitFor(() => expect(onDetailsSaved).toHaveBeenCalledWith("pr-timeline", { title: "New title", description: "Old words", updatedAt: 1 }));
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves the title on blur", async () => {
    vi.mocked(updateSpaceDetails).mockResolvedValue({ title: "Blurred", description: "Old words", updatedAt: 1 });
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.blur(input);
    await waitFor(() => expect(updateSpaceDetails).toHaveBeenCalledTimes(1));
  });

  it("Escape cancels the title edit without saving and without closing the modal", () => {
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(updateSpaceDetails).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit title" })).toHaveTextContent("PR timeline");
  });

  it("does not save an unchanged title", () => {
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: " PR timeline " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateSpaceDetails).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  });

  it("rejects an empty title and stays in edit", () => {
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateSpaceDetails).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("cannot be empty");
    expect(screen.getByRole("textbox", { name: "Title" })).toBeInTheDocument();
  });

  it("shows the conflict message and stays in edit when the save fails", async () => {
    vi.mocked(updateSpaceDetails).mockRejectedValue(new SpaceApiError(409, { code: "CONFLICT", message: "changed" }));
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed while you were editing/);
    expect(screen.getByRole("textbox", { name: "Title" })).toBeInTheDocument();
    expect(onDetailsSaved).not.toHaveBeenCalled();
  });

  it("saves the description on blur, with a counter", async () => {
    vi.mocked(updateSpaceDetails).mockResolvedValue({ title: "PR timeline", description: "Fresh", updatedAt: 1 });
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const area = screen.getByRole("textbox", { name: "Description" });
    expect(area).toHaveFocus();
    fireEvent.change(area, { target: { value: "Fresh" } });
    expect(screen.getByText("5/1000")).toBeInTheDocument();
    fireEvent.blur(area);
    await waitFor(() => expect(updateSpaceDetails).toHaveBeenCalledWith("pr-timeline", { title: "PR timeline", description: "Fresh" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves the description on Ctrl+Enter, and Enter alone only adds a line", async () => {
    vi.mocked(updateSpaceDetails).mockResolvedValue({ title: "PR timeline", description: "Two", updatedAt: 1 });
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const area = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(area, { target: { value: "Two" } });
    fireEvent.keyDown(area, { key: "Enter" });
    expect(updateSpaceDetails).not.toHaveBeenCalled();
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(updateSpaceDetails).toHaveBeenCalledTimes(1));
  });

  it("Escape cancels the description edit and does not close the modal", () => {
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const area = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(area, { target: { value: "Nope" } });
    fireEvent.keyDown(area, { key: "Escape" });
    fireEvent.blur(area);
    expect(updateSpaceDetails).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Old words")).toBeInTheDocument();
  });

  it("rejects a description over the limit", () => {
    open(mine());
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const area = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(area, { target: { value: "x".repeat(1001) } });
    fireEvent.keyDown(area, { key: "Enter", metaKey: true });
    expect(updateSpaceDetails).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("at most 1000");
  });
});

describe("audience and delegation indicators", () => {
  it("is focusable and opens a tooltip with the full meaning on focus", () => {
    open(space({ visibility: "private", delegate_access: true }));
    const aud = screen.getByRole("img", { name: "Audience: Private" });
    expect(aud).toHaveAttribute("tabindex", "0");
    fireEvent.focus(aud);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Only you can open this");
  });

  it("explains delegation and its pause", () => {
    open(space({ delegate_access: true, delegation_suspended: true }));
    const d = screen.getByRole("img", { name: "Delegated, paused" });
    fireEvent.mouseEnter(d.parentElement!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Delegation is paused until the owner confirms");
  });
});
