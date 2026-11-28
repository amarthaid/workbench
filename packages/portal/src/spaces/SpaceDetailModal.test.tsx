import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { screen, within } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import { SpaceDetailModal } from "./SpaceDetailModal";
import type { SpaceSummary } from "../spaces-api";

vi.mock("../spaces-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spaces-api")>()),
  fetchSpace: vi.fn(async () => ({ tools: [], users: [] })),
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

function open(s: SpaceSummary) {
  return renderWithClient(
    <MemoryRouter>
      <SpaceDetailModal
        space={s}
        onClose={() => {}}
        onToggleFavorite={() => {}}
        onEditDetails={() => {}}
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
    expect(hero()).toHaveTextContent("Everyone signed in");
    expect(hero()).toHaveTextContent("Delegated");
    expect(hero()).not.toHaveTextContent("paused");
  });

  it("shows Delegated, paused when the delegation is suspended", () => {
    open(space({ delegate_access: true, delegation_suspended: true }));
    expect(hero()).toHaveTextContent("Delegated, paused");
  });

  it("shows no chip for a Space without delegation", () => {
    open(space());
    expect(hero()).not.toHaveTextContent("Delegated");
  });
});

describe("SpaceDetailModal dialog name", () => {
  it("is named by the Space title", () => {
    open(space({ title: "PR timeline" }));
    expect(screen.getByRole("dialog", { name: "PR timeline" })).toBeInTheDocument();
  });
});

describe("SpaceDetailModal hero row", () => {
  it("puts the title first, then credit on the left and chips plus Open on the right", () => {
    open(space({ delegate_access: true, mine: true }));
    const text = hero().querySelector(".space-detail-hero-text") as HTMLElement;
    expect(text.firstElementChild?.tagName).toBe("H2");
    const row = text.querySelector(".space-detail-hero-row") as HTMLElement;
    expect(row).toHaveTextContent("by you");
    const side = row.querySelector(".space-detail-hero-side") as HTMLElement;
    expect(side).toHaveTextContent("Everyone signed in");
    expect(side).toHaveTextContent("Delegated");
    const link = within(side).getByRole("link", { name: "Open" });
    expect(link).toHaveAttribute("href", "/s/pr-timeline");
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("keeps Open out of the footer, and gives a viewer no footer at all", () => {
    open(space());
    expect(document.querySelector(".ui-modal-foot")).toBeNull();
    expect(screen.getAllByRole("link", { name: "Open" })).toHaveLength(1);
  });

  it("keeps Edit sharing and Delete Space in the owner footer", () => {
    open(space({ mine: true }));
    const foot = document.querySelector(".ui-modal-foot") as HTMLElement;
    expect(within(foot).getByRole("button", { name: "Edit sharing" })).toBeInTheDocument();
    expect(within(foot).getByRole("button", { name: "Delete Space" })).toBeInTheDocument();
    expect(within(foot).queryByRole("link", { name: "Open" })).toBeNull();
  });
});
