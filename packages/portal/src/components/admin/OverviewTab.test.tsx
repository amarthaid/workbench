import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import OverviewTab from "./OverviewTab";

const api = vi.hoisted(() => ({
  fetchAdminInstance: vi.fn(),
  fetchAdminActivity: vi.fn(),
  fetchAdminConnections: vi.fn(),
  fetchAdminCustomApps: vi.fn(),
  fetchAdminProfiles: vi.fn(),
  fetchIntegrations: vi.fn(),
}));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));

const INSTANCE = {
  version: "0.30.0", db_backend: "sqlite", cluster_enabled: false, audit_log_dest: "sqlite",
  audit_stored: true, user_count: 1, admin_count: 1,
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminInstance.mockResolvedValue(INSTANCE);
  api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [], next_cursor: null });
  api.fetchAdminConnections.mockResolvedValue({
    integrations: [{ integration: "jira", connected: 2, needs_reconnect: 0 }],
  });
  api.fetchAdminCustomApps.mockResolvedValue({ apps: [], total: 0 });
  api.fetchAdminProfiles.mockResolvedValue({ profiles: [] });
  api.fetchIntegrations.mockResolvedValue({ integrations: [] });
});

describe("OverviewTab", () => {
  it("shows the instance summary above tabs for the four detail views", async () => {
    renderWithClient(<OverviewTab />);
    expect(await screen.findByRole("table", { name: "Instance settings" })).toBeInTheDocument();
    for (const name of ["Activity", "Connections", "Custom apps", "Browser profiles"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
  });

  it("opens on Activity", async () => {
    renderWithClient(<OverviewTab />);
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("No tool calls recorded yet.")).toBeInTheDocument();
  });

  it("shows one detail view at a time", async () => {
    renderWithClient(<OverviewTab />);
    await screen.findByText("No tool calls recorded yet.");

    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(await screen.findByText("jira")).toBeInTheDocument();
    expect(screen.queryByText("No tool calls recorded yet.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Custom apps" }));
    expect(await screen.findByText("No custom apps.")).toBeInTheDocument();
    expect(screen.queryByText("jira")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Browser profiles" }));
    expect(await screen.findByText("No browser profiles.")).toBeInTheDocument();
    expect(screen.queryByText("No custom apps.")).not.toBeInTheDocument();
  });

  it("loads a detail view only when its tab is opened", async () => {
    renderWithClient(<OverviewTab />);
    await screen.findByText("No tool calls recorded yet.");
    // The browser-profiles card walks every profile on disk; it must not run
    // just because the Overview was opened.
    expect(api.fetchAdminProfiles).not.toHaveBeenCalled();
    expect(api.fetchAdminConnections).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Browser profiles" }));
    await waitFor(() => expect(api.fetchAdminProfiles).toHaveBeenCalledTimes(1));
  });

  it("a failing instance summary does not blank the detail views", async () => {
    api.fetchAdminInstance.mockRejectedValue(new Error("boom"));
    renderWithClient(<OverviewTab />);
    expect(await screen.findByText("Couldn't load instance info.")).toBeInTheDocument();
    expect(await screen.findByText("No tool calls recorded yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(await screen.findByText("jira")).toBeInTheDocument();
  });
});
