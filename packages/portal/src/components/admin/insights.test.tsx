import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { renderWithClient } from "../../test-utils";
import StatsCard from "./StatsCard";
import TopToolsCard from "./TopToolsCard";
import FailuresCard from "./FailuresCard";
import VaultTab from "./VaultTab";
import FilesTab from "./FilesTab";

const api = vi.hoisted(() => ({
  fetchAdminStats: vi.fn(),
  fetchAdminTopTools: vi.fn(),
  fetchAdminActivity: vi.fn(),
  fetchAdminVault: vi.fn(),
  fetchAdminFiles: vi.fn(),
}));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

const STATS = {
  stored: true, calls_24h: 120, calls_prev_24h: 100, errors_24h: 12, active_users_7d: 3,
  total_users: 8, disabled_users: 1, needs_reconnect: 2,
};

describe("StatsCard", () => {
  it("shows calls, error rate, active users and the trend", async () => {
    api.fetchAdminStats.mockResolvedValue(STATS);
    renderWithClient(<StatsCard />);
    expect(await screen.findByText("120")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
    expect(screen.getByText("3 of 8")).toBeInTheDocument();
    expect(screen.getByText(/\+20% vs the 24h before/)).toBeInTheDocument();
  });

  it("keeps the user counts but dashes the usage figures when audit is not stored", async () => {
    api.fetchAdminStats.mockResolvedValue({ ...STATS, stored: false, calls_24h: 0, calls_prev_24h: 0, errors_24h: 0, active_users_7d: 0 });
    renderWithClient(<StatsCard />);
    expect(await screen.findByText("Disabled users")).toBeInTheDocument();
    expect(screen.getByText("Calls (24h)").nextSibling).toHaveTextContent("—");
    expect(screen.getByText("Needs reconnect").nextSibling).toHaveTextContent("2");
  });

  it("shows no error rate when there were no calls", async () => {
    api.fetchAdminStats.mockResolvedValue({ ...STATS, calls_24h: 0, errors_24h: 0, calls_prev_24h: 0 });
    renderWithClient(<StatsCard />);
    expect(await screen.findByText("Error rate (24h)")).toBeInTheDocument();
    expect(screen.getByText("Error rate (24h)").nextSibling).toHaveTextContent("—");
  });
});

describe("TopToolsCard", () => {
  it("lists tools with calls, errors and average time", async () => {
    api.fetchAdminTopTools.mockResolvedValue({
      stored: true,
      tools: [{ integration: "acme", tool: "acme_search", calls: 9, errors: 2, avg_ms: 1500 }],
    });
    renderWithClient(<TopToolsCard />);
    expect(await screen.findByText("acme_search")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("1.5s")).toBeInTheDocument();
  });

  it("says so when there is nothing", async () => {
    api.fetchAdminTopTools.mockResolvedValue({ stored: true, tools: [] });
    renderWithClient(<TopToolsCard />);
    expect(await screen.findByText("No tool calls in the last 7 days.")).toBeInTheDocument();
  });
});

describe("FailuresCard", () => {
  it("asks for the five newest errors and shows the message", async () => {
    api.fetchAdminActivity.mockResolvedValue({
      stored: true,
      next_cursor: null,
      events: [{ id: 1, user_id: "u1", user_email: "dev@example.com", integration: "acme", tool: "acme_get",
        action: "EXECUTE", success: false, error: "boom", duration_ms: 5, created_at: 1_700_000_000 }],
    });
    renderWithClient(<MemoryRouter><FailuresCard /></MemoryRouter>);
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(api.fetchAdminActivity).toHaveBeenCalledWith({ status: "error", limit: 5 });
    expect(screen.getByRole("link", { name: "All activity" })).toHaveAttribute("href", "/admin/activity");
  });

  it("shows an empty state when nothing failed", async () => {
    api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [], next_cursor: null });
    renderWithClient(<MemoryRouter><FailuresCard /></MemoryRouter>);
    expect(await screen.findByText("No failed calls.")).toBeInTheDocument();
  });
});

describe("VaultTab", () => {
  it("shows counts and top holders", async () => {
    api.fetchAdminVault.mockResolvedValue({
      secrets: 5, users_with_secrets: 2, stale: 1, stale_days: 90, pending_links: 3,
      top_holders: [{ email: "a@example.com", secrets: 4 }],
    });
    renderWithClient(<VaultTab />);
    expect(await screen.findByText("Unused 90+ days")).toBeInTheDocument();
    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(screen.getByText("Pending one-time links").nextSibling).toHaveTextContent("3");
  });
});

describe("FilesTab", () => {
  it("shows disk used, the oldest file and the biggest users", async () => {
    api.fetchAdminFiles.mockResolvedValue({
      files: 3, bytes: 2048, users: 1, oldest_age_seconds: 7200,
      top_users: [{ email: "a@example.com", files: 3, bytes: 2048 }],
      largest: [{ email: "a@example.com", bytes: 1024, age_seconds: 60 }],
    });
    renderWithClient(<FilesTab />);
    expect(await screen.findByText("2.0 KB", { selector: ".ui-stat-value" })).toBeInTheDocument();
    expect(screen.getByText("Oldest file").nextSibling).toHaveTextContent("2h");
    expect(screen.getByRole("table", { name: "Users holding the most file data" })).toBeInTheDocument();
  });

  it("shows an empty state when no files are stored", async () => {
    api.fetchAdminFiles.mockResolvedValue({ files: 0, bytes: 0, users: 0, oldest_age_seconds: null, top_users: [], largest: [] });
    renderWithClient(<FilesTab />);
    expect(await screen.findByText("No files stored.")).toBeInTheDocument();
  });
});
