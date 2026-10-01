import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
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

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [], next_cursor: null });
  api.fetchAdminCustomApps.mockResolvedValue({ apps: [], total: 0 });
  api.fetchAdminProfiles.mockResolvedValue({ profiles: [], this_worker_only: false });
  api.fetchIntegrations.mockResolvedValue({ integrations: [] });
});

describe("OverviewTab", () => {
  it("one failing card does not blank the others", async () => {
    // Once: a persistent rejection on a query's fetch fails the test as an unhandled error.
    api.fetchAdminInstance.mockRejectedValueOnce(new Error("boom"));
    api.fetchAdminConnections.mockResolvedValue({
      integrations: [{ integration: "jira", connected: 2, needs_reconnect: 0 }],
    });
    renderWithClient(<OverviewTab />);
    expect(await screen.findByText("Couldn't load instance info.")).toBeInTheDocument();
    expect(await screen.findByText("jira")).toBeInTheDocument();
    expect(await screen.findByText("No custom apps.")).toBeInTheDocument();
  });
});
