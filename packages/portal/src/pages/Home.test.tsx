import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Home from "./Home";
import type { SpaceSummary } from "../spaces-api";

vi.mock("../api", () => ({
  fetchStats: vi.fn(),
  fetchActivity: vi.fn(),
  fetchIntegrations: vi.fn(),
  fetchConnections: vi.fn(),
  fetchVaultSecrets: vi.fn(),
  UNSTORED_MESSAGE: "This deployment sends audit events somewhere other than its database, so there is nothing to show here. Add db to AUDIT_LOG_DEST (the default) to record them.",
}));

vi.mock("../spaces-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spaces-api")>()),
  fetchSpaces: vi.fn(),
  fetchSpace: vi.fn(),
  setSpaceFavorite: vi.fn(),
}));
import { fetchSpaces, fetchSpace } from "../spaces-api";
import { fetchStats, fetchActivity, fetchIntegrations, fetchConnections, fetchVaultSecrets } from "../api";

const NOW = Math.floor(Date.now() / 1000);

const INTEGRATIONS = [
  { name: "acme", displayName: "Acme", version: "1.0.0", toolCount: 4, logo: "/logos/acme.svg" },
  { name: "demo-repo", displayName: "Demo Repo", version: "1.0.0", toolCount: 9 },
];

function space(over: Partial<SpaceSummary> & { name: string; title: string }): SpaceSummary {
  return {
    description: null,
    ownerEmail: "teammate@example.com",
    visibility: "org",
    updatedAt: Date.now() - 20 * 86_400_000,
    mine: false,
    favorited: false,
    favorite_count: 0,
    last_opened_at: null,
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/vault" element={<div>VAULT PAGE</div>} />
          <Route path="/vault/one-time" element={<div>ONE-TIME PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchSpaces).mockResolvedValue([
    space({ name: "pr-timeline", title: "PR timeline", favorited: true, mine: true, ownerEmail: "owner@example.com" }),
    space({ name: "drive-upload", title: "Drive upload", last_opened_at: Date.now() - 3_600_000 }),
    space({ name: "old-board", title: "Old board" }),
  ]);
  vi.mocked(fetchSpace).mockResolvedValue({ tools: [], users: [] } as never);
  vi.mocked(fetchIntegrations).mockResolvedValue({ integrations: INTEGRATIONS });
  vi.mocked(fetchConnections).mockResolvedValue({ connections: [{ name: "acme", connected: true }] });
  vi.mocked(fetchVaultSecrets).mockResolvedValue([
    { name: "db_url", description: null, created_at: NOW, updated_at: NOW, last_used_at: null },
    { name: "api_token", description: null, created_at: NOW, updated_at: NOW, last_used_at: null },
  ]);
  vi.mocked(fetchStats).mockResolvedValue({
    stored: true, window_days: 30, tool_calls: 1284, success_rate: 0.97, most_used_integration: "acme",
  });
  vi.mocked(fetchActivity).mockResolvedValue({
    stored: true,
    events: [{ id: 1, integration: "acme", tool: "acme_search", action: "EXECUTE", success: true, error: null, duration_ms: 412, created_at: NOW }],
    next_cursor: null,
  });
});

describe("Home", () => {
  // Read a stat by its label rather than by its value: "Acme" and "1" both
  // appear elsewhere on this page, so a bare getByText would be ambiguous or,
  // worse, pass against the wrong element.
  function statValue(label: string): string {
    const cell = screen.getByText(label).closest(".ui-stat");
    return cell?.querySelector(".ui-stat-value")?.textContent ?? "";
  }

  it("badges the most-used app with its logo", async () => {
    renderPage();
    // Two queries feed this cell — the stat and the registry that carries the
    // logo — so wait for the mark itself rather than the label beside it.
    await waitFor(() => {
      const cell = screen.getByText("Most used app").closest(".ui-stat");
      const logo = cell?.querySelector("img");
      expect(logo).toHaveAttribute("src", "/logos/acme.svg");
      expect(logo).toHaveAttribute("alt", "Acme logo");
    });
  });

  it("shows the four headline numbers", async () => {
    renderPage();
    await screen.findByText("1,284");
    expect(statValue("Tool calls (30d)")).toBe("1,284");
    expect(statValue("Success rate (30d)")).toBe("97%");
    expect(statValue("Most used app")).toBe("Acme");
  });

  it("counts connected apps from the connections endpoint", async () => {
    renderPage();
    // Wait for the connected app itself, not the always-present label — the
    // label renders before /api/connections and /api/integrations resolve,
    // so waiting on it would read the pre-load default instead of "1".
    await screen.findByRole("button", { name: /^Acme/ });
    expect(statValue("Connected apps")).toBe("1");
  });

  it("lists connected apps and links to the registry", async () => {
    renderPage();
    expect(await screen.findByText(/4 tools/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse all" })).toHaveAttribute("href", "/apps");
  });

  it("invites the human to connect something when nothing is connected", async () => {
    vi.mocked(fetchConnections).mockResolvedValue({ connections: [] });
    renderPage();
    expect(await screen.findByText("No apps connected yet.")).toBeInTheDocument();
  });

  it("shows the MCP endpoint and points at the agents page", async () => {
    renderPage();
    expect(await screen.findByText(`${window.location.origin}/mcp`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up an agent" })).toHaveAttribute("href", "/agents");
  });

  it("copies the MCP endpoint from an icon button beside it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Copy MCP URL" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/mcp`);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("shows recent activity with a link to the full log", async () => {
    renderPage();
    expect(await screen.findByText("acme_search")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/activity");
  });

  it("dashes out the activity-derived numbers when nothing is stored", async () => {
    vi.mocked(fetchStats).mockResolvedValue({
      stored: false, window_days: 30, tool_calls: 0, success_rate: null, most_used_integration: null,
    });
    vi.mocked(fetchActivity).mockResolvedValue({ stored: false, events: [], next_cursor: null });
    renderPage();

    // Wait for the unstored note itself, not the always-present label — the
    // label renders before /api/stats resolves, so waiting on it would read
    // the pre-load default instead of the settled "stored: false" state.
    await screen.findAllByText(/somewhere other than its database/);
    // The three activity-derived cells go blank; the connected count does not,
    // because it comes from /api/connections rather than the audit log.
    expect(statValue("Tool calls (30d)")).toBe("—");
    expect(statValue("Success rate (30d)")).toBe("—");
    expect(statValue("Most used app")).toBe("—");
    expect(statValue("Connected apps")).toBe("1");
    expect(screen.getAllByText(/somewhere other than its database/).length).toBeGreaterThan(0);
  });

  it("reports a null success rate as a dash rather than 0%", async () => {
    // tool_calls is deliberately non-zero against a null rate. The live
    // endpoint only returns a null rate when the window is empty, but that
    // pairing is exactly what makes the zero-calls case untestable here: the
    // component's pre-fetch defaults render "—" and "0" too, so the assertions
    // would hold against a component that never fetched. A non-zero count
    // isolates the null-rate branch and gives the test something to wait on
    // that cannot exist before the query resolves.
    vi.mocked(fetchStats).mockResolvedValue({
      stored: true, window_days: 30, tool_calls: 12, success_rate: null, most_used_integration: null,
    });
    renderPage();
    await screen.findByText("12");
    expect(statValue("Success rate (30d)")).toBe("—");
    expect(statValue("Tool calls (30d)")).toBe("12");
  });
  it("shows a vault box with the secret count and quick links", async () => {
    renderPage();
    const box = (await screen.findByRole("heading", { name: "Vault" })).closest("section")!;
    await waitFor(() => expect(box).toHaveTextContent("2 stored"));
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("href", "/vault");
    expect(screen.getByRole("link", { name: "Add secret" })).toHaveAttribute("href", "/vault/new");
    fireEvent.click(screen.getByRole("link", { name: "Create" }));
    expect(await screen.findByText("ONE-TIME PAGE")).toBeInTheDocument();
  });

  it("says so when the vault is empty or fails to load", async () => {
    vi.mocked(fetchVaultSecrets).mockResolvedValueOnce([]);
    const first = renderPage();
    expect(await screen.findByText("None yet")).toBeInTheDocument();
    first.unmount();
    vi.mocked(fetchVaultSecrets).mockRejectedValueOnce(new Error("Failed to load vault"));
    renderPage();
    expect(await screen.findByText("Couldn't load vault.")).toBeInTheDocument();
  });

  it("shows skeletons, never zeros or the empty message, while the data is on its way", async () => {
    const never = new Promise<never>(() => {});
    vi.mocked(fetchStats).mockReturnValue(never);
    vi.mocked(fetchActivity).mockReturnValue(never);
    vi.mocked(fetchIntegrations).mockReturnValue(never);
    vi.mocked(fetchConnections).mockReturnValue(never);
    vi.mocked(fetchSpaces).mockReturnValue(never);
    renderPage();
    expect(screen.queryByText("No apps connected yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("No tool calls recorded yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("No Spaces yet.")).not.toBeInTheDocument();
    for (const label of ["Tool calls (30d)", "Success rate (30d)", "Most used app", "Connected apps"]) {
      expect(statValue(label)).toBe("");
      expect(screen.getByText(label).closest(".ui-stat")!.querySelector('[role="status"]')).not.toBeNull();
    }
    // One skeleton each for the apps, Spaces and activity lists.
    expect(screen.getAllByRole("status", { name: "Loading" }).length).toBeGreaterThanOrEqual(3 + 4);
    // The apps skeleton is a tile grid, the same columns as the loaded apps.
    const appsBox = screen.getByText("Your apps").closest("section")!;
    expect(appsBox.querySelector(".wb-app-grid")).not.toBeNull();
  });

  it("shows a skeleton, not a dash, for the vault count while it loads", async () => {
    vi.mocked(fetchVaultSecrets).mockReturnValue(new Promise<never>(() => {}));
    renderPage();
    const row = screen.getByText("Secrets").closest(".ui-box-row")!;
    expect(row.querySelector('[role="status"]')).not.toBeNull();
    expect(row).not.toHaveTextContent("—");
  });

  it("lays the Your Spaces tiles out in two columns", async () => {
    renderPage();
    await screen.findByText("PR timeline");
    expect(document.querySelector(".space-grid.is-two")).not.toBeNull();
  });

  it("shows your apps as the same compact tiles as the Apps page", async () => {
    renderPage();
    const tile = (await screen.findByRole("button", { name: /^Acme/ })).closest(".wb-app-cell")!;
    expect(tile).toHaveTextContent("4 tools");
    expect(tile).toHaveTextContent("Connected");
  });

  it("shows a Your Spaces row with the first gallery tiles and opens the Space detail", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Your Spaces" });
    const box = heading.closest("section")!;
    await waitFor(() => expect(box.querySelectorAll(".space-tile-compact").length).toBe(3));
    // As the gallery orders them: favorites, then recently opened, then the rest.
    expect(Array.from(box.querySelectorAll(".space-tile-link")).map((a) => a.textContent)).toEqual([
      "PR timeline",
      "Drive upload",
      "Old board",
    ]);
    expect(screen.getByRole("link", { name: "Browse all Spaces" })).toHaveAttribute("href", "/spaces");
    fireEvent.click(screen.getByRole("button", { name: "Drive upload" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Drive upload");
  });

  it("says so when there are no Spaces, after loading", async () => {
    vi.mocked(fetchSpaces).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("No Spaces yet.")).toBeInTheDocument();
  });
});
