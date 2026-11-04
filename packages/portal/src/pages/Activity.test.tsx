import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Activity from "./Activity";

vi.mock("../api", () => ({
  fetchActivity: vi.fn(),
  fetchIntegrations: vi.fn(async () => ({
    integrations: [
      { name: "acme", displayName: "Acme", version: "1.0.0", toolCount: 2, logo: "/logos/acme.svg" },
      { name: "demo-repo", displayName: "Demo Repo", version: "1.0.0", toolCount: 2 },
    ],
  })),
  UNSTORED_MESSAGE: "This deployment sends audit events somewhere other than its database, so there is nothing to show here. Add db to AUDIT_LOG_DEST (the default) to record them.",
}));

import { fetchActivity } from "../api";

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
    fireEvent.change(screen.getByLabelText("Integration"), { target: { value: "demo-repo" } });
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
});
