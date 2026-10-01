import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import InstanceCard from "./InstanceCard";

const api = vi.hoisted(() => ({ fetchAdminInstance: vi.fn() }));
vi.mock("../../api", () => api);

const info = {
  version: "0.30.0",
  db_backend: "sqlite",
  cluster_enabled: false,
  audit_log_dest: "sqlite",
  audit_stored: true,
  user_count: 3,
  admin_count: 1,
};

// Block body: an arrow that returns the mock makes vitest run it as a teardown
// hook, which calls the mock again after the test.
beforeEach(() => {
  api.fetchAdminInstance.mockReset();
});

describe("InstanceCard", () => {
  it("shows version, database, cluster, audit log and counts", async () => {
    api.fetchAdminInstance.mockResolvedValue(info);
    renderWithClient(<InstanceCard />);
    const table = await screen.findByRole("table", { name: "Instance settings" });
    const rows = within(table).getAllByRole("row").map((r) => r.textContent);
    expect(rows).toEqual(
      expect.arrayContaining(["Version0.30.0", "Databasesqlite", "ClusterOff", "Audit logsqlite", "Users3", "Admins1"])
    );
  });

  it("says when audit events are not stored in the database", async () => {
    api.fetchAdminInstance.mockResolvedValue({ ...info, audit_log_dest: "stdout", audit_stored: false });
    renderWithClient(<InstanceCard />);
    expect(await screen.findByText("stdout (not in database)")).toBeInTheDocument();
  });

  it("shows a loading state, then an error state", async () => {
    api.fetchAdminInstance.mockRejectedValue(new Error("boom"));
    renderWithClient(<InstanceCard />);
    expect(screen.getByText("Loading instance info…")).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load instance info.")).toBeInTheDocument();
    // Exactly one fetch: a rejection that resolved to undefined on a second call
    // would otherwise hide a double-fetch.
    expect(api.fetchAdminInstance).toHaveBeenCalledTimes(1);
  });
});
