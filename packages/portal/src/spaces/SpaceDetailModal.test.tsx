import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { screen } from "@testing-library/react";
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
