import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ConnectionsCard from "./ConnectionsCard";

const api = vi.hoisted(() => ({ fetchAdminConnections: vi.fn() }));
vi.mock("../../api", () => api);

beforeEach(() => api.fetchAdminConnections.mockReset());

describe("ConnectionsCard", () => {
  it("lists each integration with its connected and needs-reconnect counts", async () => {
    api.fetchAdminConnections.mockResolvedValue({
      integrations: [
        { integration: "jira", connected: 3, needs_reconnect: 1 },
        { integration: "slack", connected: 1, needs_reconnect: 0 },
      ],
    });
    renderWithClient(<ConnectionsCard />);
    const jira = (await screen.findByText("jira")).closest("tr")!;
    expect(jira).toHaveTextContent("3");
    expect(jira).toHaveTextContent("1");
    expect(screen.getByText("slack").closest("tr")).toHaveTextContent("0");
  });

  it("shows an empty state", async () => {
    api.fetchAdminConnections.mockResolvedValue({ integrations: [] });
    renderWithClient(<ConnectionsCard />);
    expect(await screen.findByText("No connections yet.")).toBeInTheDocument();
  });

  it("shows an error state", async () => {
    // Once, not a persistent rejection: a persistent mockRejectedValue on a
    // query's fetch surfaces as an unhandled "boom" that fails the test.
    api.fetchAdminConnections.mockRejectedValueOnce(new Error("boom"));
    renderWithClient(<ConnectionsCard />);
    expect(await screen.findByText("Couldn't load connections.")).toBeInTheDocument();
  });
});
