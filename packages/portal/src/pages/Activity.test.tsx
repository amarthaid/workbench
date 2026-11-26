import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Activity from "./Activity";

vi.mock("../api", () => ({
  fetchActivity: vi.fn(),
  fetchActivityPeople: vi.fn(async () => ({ stored: true, people: [] })),
  fetchIntegrations: vi.fn(async () => ({
    integrations: [
      { name: "acme", displayName: "Acme", version: "1.0.0", toolCount: 2, logo: "/logos/acme.svg" },
      { name: "demo-repo", displayName: "Demo Repo", version: "1.0.0", toolCount: 2 },
    ],
  })),
  UNSTORED_MESSAGE: "This deployment sends audit events somewhere other than its database, so there is nothing to show here. Add db to AUDIT_LOG_DEST (the default) to record them.",
}));

vi.mock("../spaces-api", () => ({
  fetchSpaces: vi.fn(async () => [{ name: "sprint-board", title: "Sprint Board" }]),
}));

import { fetchActivity, type ActivityDelegation } from "../api";
import { fetchSpaces } from "../spaces-api";

const now = new Date();
const NOW = Math.floor(now.getTime() / 1000);
// Yesterday's local noon, not "now minus 25 hours": subtracting a fixed span
// lands two calendar days back whenever the suite happens to run in the small
// hours, and the day-grouping assertion below would fail on the clock rather
// than on the code. Constructing from the local date rolls months and years
// correctly, and noon keeps it clear of daylight-saving shifts.
const YESTERDAY = Math.floor(
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0).getTime() / 1000
);

const EVENTS = [
  { id: 3, integration: "acme", tool: "acme_search", action: "EXECUTE", success: true, error: null, duration_ms: 412, created_at: NOW },
  { id: 2, integration: "demo-repo", tool: "repo_diff", action: "EXECUTE", success: false, error: "NOT_CONNECTED", duration_ms: 12, created_at: YESTERDAY },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Activity />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchActivity).mockResolvedValue({ stored: true, events: EVENTS, next_cursor: null });
});

describe("Activity", () => {
  it("lists each event with its tool and duration", async () => {
    renderPage();
    expect(await screen.findByText("acme_search")).toBeInTheDocument();
    expect(screen.getByText("412ms")).toBeInTheDocument();
  });

  it("shows each row's app with its logo, and a fallback mark when it has none", async () => {
    renderPage();
    const acme = await screen.findByAltText("Acme logo");
    expect(acme).toHaveAttribute("src", "/logos/acme.svg");
    // demo-repo carries no logo in the registry, so it falls back to the cog.
    const fallbackRow = screen.getByText("repo_diff").closest("tr");
    expect(fallbackRow?.querySelector(".integ-logo-fallback")).toBeInTheDocument();
  });

  it("groups events under a day heading", async () => {
    renderPage();
    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });

  it("pairs the status icon with text so colour is not the only signal", async () => {
    renderPage();
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("shows the error message on a failed row", async () => {
    renderPage();
    expect(await screen.findByText("NOT_CONNECTED")).toBeInTheDocument();
  });

  it("requests only failures when the Errors tab is chosen", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Errors" }));
    await waitFor(() =>
      expect(fetchActivity).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }))
    );
  });

  it("requests one integration when it is selected", async () => {
    renderPage();
    await screen.findByText("acme_search");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("App"), { target: { value: "demo-repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(fetchActivity).toHaveBeenCalledWith(expect.objectContaining({ integration: "demo-repo" }))
    );
  });

  it("offers Load more only while a cursor comes back, and pages with it", async () => {
    vi.mocked(fetchActivity).mockResolvedValueOnce({ stored: true, events: EVENTS, next_cursor: "cur-1" });
    renderPage();

    const more = await screen.findByRole("button", { name: "Load more" });
    vi.mocked(fetchActivity).mockResolvedValueOnce({ stored: true, events: [], next_cursor: null });
    fireEvent.click(more);

    await waitFor(() =>
      expect(fetchActivity).toHaveBeenCalledWith(expect.objectContaining({ cursor: "cur-1" }))
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("says nothing has been recorded when the log is empty", async () => {
    vi.mocked(fetchActivity).mockResolvedValue({ stored: true, events: [], next_cursor: null });
    renderPage();
    expect(await screen.findByText("No tool calls recorded yet.")).toBeInTheDocument();
  });

  it("distinguishes an unstored log from an empty one", async () => {
    vi.mocked(fetchActivity).mockResolvedValue({ stored: false, events: [], next_cursor: null });
    renderPage();
    expect(
      await screen.findByText(/This deployment sends audit events somewhere other than its database/)
    ).toBeInTheDocument();
    expect(screen.getByText(/AUDIT_LOG_DEST/)).toBeInTheDocument();
  });

  describe("delegated calls", () => {
    const row = (id: number, delegation: ActivityDelegation | null) => ({
      id,
      integration: "acme",
      tool: `acme_tool_${id}`,
      action: "EXECUTE",
      success: true,
      error: null,
      duration_ms: 10,
      created_at: NOW,
      delegation,
    });

    it("shows who used whose access on a second line under the tool, with the Space's title", async () => {
      vi.mocked(fetchActivity).mockResolvedValue({
        stored: true,
        next_cursor: null,
        events: [
          row(10, { direction: "for_me", other_email: "qa@example.com", space: "sprint-board" }),
          row(11, { direction: "by_me", other_email: "dev@example.com", space: "sprint-board" }),
          row(12, null),
        ],
      });
      renderPage();
      const forMe = (await screen.findByText("acme_tool_10")).closest("tr")!;
      const cell = screen.getByText("acme_tool_10").closest("td")!;
      expect(cell).toHaveTextContent("Delegated");
      expect(cell).toHaveTextContent("Used by");
      expect(within(cell).getByRole("button", { name: "qa@example.com" })).toBeInTheDocument();
      expect(await within(cell).findByRole("button", { name: "Sprint Board" })).toBeInTheDocument();
      const byMe = screen.getByText("acme_tool_11").closest("td")!;
      expect(byMe).toHaveTextContent("On access of");
      expect(byMe).not.toHaveTextContent("Used by");
      expect(within(byMe).getByRole("button", { name: "dev@example.com" })).toBeInTheDocument();
      const plain = screen.getByText("acme_tool_12").closest("tr")!;
      expect(plain).not.toHaveTextContent("Delegated");
      expect(plain.querySelector(".wb-cell-delegation")).toBeNull();
      expect(forMe).toHaveTextContent("Delegated");
      expect(screen.getAllByText("Delegated")).toHaveLength(2);
    });

    it("leaves out the Space when there is none, and falls back to its name when not visible", async () => {
      vi.mocked(fetchActivity).mockResolvedValue({
        stored: true,
        next_cursor: null,
        events: [
          row(20, { direction: "for_me", other_email: "qa@example.com", space: null }),
          row(21, { direction: "by_me", other_email: "dev@example.com", space: "gone-space" }),
        ],
      });
      renderPage();
      const a = (await screen.findByText("acme_tool_20")).closest("td")!;
      expect(a.querySelectorAll("button")).toHaveLength(1);
      const b = screen.getByText("acme_tool_21").closest("td")!;
      expect(await within(b).findByRole("button", { name: "gone-space" })).toBeInTheDocument();
    });

    it("shows only 'via Space' for a call through a Space on the caller's own access", async () => {
      vi.mocked(fetchActivity).mockResolvedValue({
        stored: true,
        next_cursor: null,
        events: [{ ...row(30, null), client_name: "space:sprint-board" }],
      });
      renderPage();
      const cell = (await screen.findByText("acme_tool_30")).closest("td")!;
      expect(cell).toHaveTextContent("via Space");
      expect(cell).not.toHaveTextContent("Delegated");
      expect(await within(cell).findByRole("button", { name: "Sprint Board" })).toBeInTheDocument();
    });

    it("applies the person filter from a person link without opening the drawer", async () => {
      vi.mocked(fetchActivity).mockResolvedValue({
        stored: true,
        next_cursor: null,
        events: [row(40, { direction: "for_me", other_email: "qa@example.com", space: null })],
      });
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "qa@example.com" }));
      await waitFor(() =>
        expect(fetchActivity).toHaveBeenCalledWith(expect.objectContaining({ person: "qa@example.com", delegated: true }))
      );
      expect(screen.queryByRole("dialog", { name: /call/i })).toBeNull();
      expect(document.querySelector(".af-drawer")).toBeNull();
      expect(screen.getByText("Person: qa@example.com")).toBeInTheDocument();
    });

    it("applies the Space filter from a Space link", async () => {
      vi.mocked(fetchActivity).mockResolvedValue({
        stored: true,
        next_cursor: null,
        events: [row(41, { direction: "by_me", other_email: "dev@example.com", space: "sprint-board" })],
      });
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Sprint Board" }));
      await waitFor(() => expect(fetchActivity).toHaveBeenCalledWith(expect.objectContaining({ space: "sprint-board" })));
      expect(document.querySelector(".af-drawer")).toBeNull();
    });

    it("opens the drawer on row click and on Enter, and notes withheld origin for a for_me row", async () => {
      vi.mocked(fetchActivity).mockResolvedValue({
        stored: true,
        next_cursor: null,
        events: [
          row(50, { direction: "for_me", other_email: "qa@example.com", space: "sprint-board" }),
          row(51, null),
        ],
      });
      renderPage();
      const r = (await screen.findByText("acme_tool_50")).closest("tr")!;
      fireEvent.click(r);
      expect(await screen.findByText(/Their IP address and browser are not shown to you/)).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(document.querySelector(".af-drawer")).toBeNull());

      const r2 = screen.getByText("acme_tool_51").closest("tr")!;
      fireEvent.keyDown(r2, { key: "Enter" });
      expect(await screen.findByText(/Origin/)).toBeInTheDocument();
      expect(document.querySelector(".af-drawer")).not.toBeNull();
    });

    it("loads the viewer's Spaces for the Space filter and for row titles", async () => {
      renderPage();
      await screen.findByText("acme_search");
      await waitFor(() => expect(fetchSpaces).toHaveBeenCalledTimes(1));
    });
  });
});
