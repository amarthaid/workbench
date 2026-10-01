import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import CustomAppsCard from "./CustomAppsCard";

const api = vi.hoisted(() => ({ fetchAdminCustomApps: vi.fn() }));
vi.mock("../../api", () => api);

const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => api.fetchAdminCustomApps.mockReset());

describe("CustomAppsCard", () => {
  it("lists apps with owner and URL", async () => {
    api.fetchAdminCustomApps.mockResolvedValue({
      apps: [{ id: "a1", name: "wiki", base_url: "https://mcp.example.com/wiki", owner_email: "dev@example.com", created_at: NOW }],
      total: 1,
    });
    renderWithClient(<CustomAppsCard />);
    const row = (await screen.findByText("wiki")).closest("tr")!;
    expect(row).toHaveTextContent("dev@example.com");
    expect(row).toHaveTextContent("https://mcp.example.com/wiki");
  });

  it("shows a dash for an app whose owner is gone", async () => {
    api.fetchAdminCustomApps.mockResolvedValue({
      apps: [{ id: "a1", name: "orphan", base_url: "https://mcp.example.com/o", owner_email: null, created_at: NOW }],
      total: 1,
    });
    renderWithClient(<CustomAppsCard />);
    expect((await screen.findByText("orphan")).closest("tr")).toHaveTextContent("—");
  });

  it("notes when the list is truncated", async () => {
    api.fetchAdminCustomApps.mockResolvedValue({
      apps: [{ id: "a1", name: "wiki", base_url: "https://mcp.example.com/w", owner_email: "dev@example.com", created_at: NOW }],
      total: 250,
    });
    renderWithClient(<CustomAppsCard />);
    expect(await screen.findByText("Showing the latest 1 of 250.")).toBeInTheDocument();
  });

  it("shows empty and error states", async () => {
    api.fetchAdminCustomApps.mockResolvedValueOnce({ apps: [], total: 0 });
    const { unmount } = renderWithClient(<CustomAppsCard />);
    expect(await screen.findByText("No custom apps.")).toBeInTheDocument();
    unmount();
    api.fetchAdminCustomApps.mockRejectedValueOnce(new Error("boom"));
    renderWithClient(<CustomAppsCard />);
    expect(await screen.findByText("Couldn't load custom apps.")).toBeInTheDocument();
  });
});
