import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { SpaceTile, type TileSize } from "./SpaceTile";
import type { SpaceSummary } from "../spaces-api";

const space: SpaceSummary = {
  name: "pr timeline",
  title: "PR timeline",
  description: null,
  ownerEmail: "owner@example.com",
  visibility: "org",
  updatedAt: Date.now(),
  mine: false,
  favorited: false,
  favorite_count: 0,
  last_opened_at: null,
};

function tile(size: TileSize, onOpen = vi.fn()) {
  render(
    <MemoryRouter>
      <SpaceTile space={space} size={size} isNew={false} onToggleFavorite={() => {}} onOpen={onOpen} onEditSharing={() => {}} />
    </MemoryRouter>
  );
  return onOpen;
}

describe("SpaceTile hover Open", () => {
  it.each<TileSize>(["large", "compact"])("has an icon Open link to the Space on a %s tile, without opening the detail", (size) => {
    const onOpen = tile(size);
    const link = screen.getByRole("link", { name: "Open PR timeline" });
    expect(link).toHaveAttribute("href", "/s/pr%20timeline");
    expect(link).toHaveAttribute("title", "Open");
    expect(link.closest(".space-tile-badges")).not.toBeNull();
    expect(link.closest(".space-tile-actions")).toBeNull();
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
