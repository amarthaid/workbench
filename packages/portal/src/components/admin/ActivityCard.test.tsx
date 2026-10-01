import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ActivityCard from "./ActivityCard";

const api = vi.hoisted(() => ({ fetchAdminActivity: vi.fn(), fetchIntegrations: vi.fn() }));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));

const NOW = Math.floor(Date.now() / 1000);

function ev(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: "u1",
    user_email: "dev@example.com",
    integration: "acme",
    tool: `tool_${id}`,
    action: "EXECUTE",
    success: true,
    error: null,
    duration_ms: 120,
    created_at: NOW,
    ...over,
  };
}

beforeEach(() => {
  api.fetchAdminActivity.mockReset();
  api.fetchIntegrations.mockReset();
  api.fetchIntegrations.mockResolvedValue({ integrations: [{ name: "acme", displayName: "Acme" }] });
});

describe("ActivityCard", () => {
  it("shows each event with the user's email and the app's display name", async () => {
    api.fetchAdminActivity.mockResolvedValue({
      stored: true,
      events: [ev(1, { tool: "acme_search" }), ev(2, { user_email: null, tool: "orphan_tool" })],
      next_cursor: null,
    });
    renderWithClient(<ActivityCard />);
    const row = (await screen.findByText("acme_search")).closest("tr")!;
    expect(row).toHaveTextContent("dev@example.com");
    expect(row).toHaveTextContent("Acme");
    expect(screen.getByText("orphan_tool").closest("tr")).toHaveTextContent("—");
  });

  it("says events are not stored, rather than that nothing ran", async () => {
    api.fetchAdminActivity.mockResolvedValue({ stored: false, events: [], next_cursor: null });
    renderWithClient(<ActivityCard />);
    expect(await screen.findByText(/somewhere other than its database/i)).toBeInTheDocument();
    expect(screen.queryByText("No tool calls recorded yet.")).not.toBeInTheDocument();
  });

  it("shows an empty state and an error state", async () => {
    api.fetchAdminActivity.mockResolvedValueOnce({ stored: true, events: [], next_cursor: null });
    const { unmount } = renderWithClient(<ActivityCard />);
    expect(await screen.findByText("No tool calls recorded yet.")).toBeInTheDocument();
    unmount();
    api.fetchAdminActivity.mockRejectedValueOnce(new Error("boom"));
    renderWithClient(<ActivityCard />);
    expect(await screen.findByText("Couldn't load activity.")).toBeInTheDocument();
  });

  it("the Errors tab refetches with status=error", async () => {
    api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [ev(1)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("tab", { name: "Errors" }));
    await waitFor(() =>
      expect(api.fetchAdminActivity).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }))
    );
  });

  it("filtering by email sends the trimmed email on submit", async () => {
    api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [ev(1)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.change(screen.getByLabelText("User email"), { target: { value: "  dev@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() =>
      expect(api.fetchAdminActivity).toHaveBeenLastCalledWith(expect.objectContaining({ email: "dev@example.com" }))
    );
  });

  it("Load more appends the next page using the cursor", async () => {
    api.fetchAdminActivity
      .mockResolvedValueOnce({ stored: true, events: [ev(1)], next_cursor: "c1" })
      .mockResolvedValueOnce({ stored: true, events: [ev(2)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("tool_2")).toBeInTheDocument();
    expect(screen.getByText("tool_1")).toBeInTheDocument();
    expect(api.fetchAdminActivity).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c1" }));
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("does not show the same event twice when two pages both contain it", async () => {
    api.fetchAdminActivity
      .mockResolvedValueOnce({ stored: true, events: [ev(1)], next_cursor: "c1" })
      .mockResolvedValueOnce({ stored: true, events: [ev(1), ev(2)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("tool_2");
    expect(screen.getAllByText("tool_1")).toHaveLength(1);
  });
});
