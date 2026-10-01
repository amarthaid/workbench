import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ProfilesCard from "./ProfilesCard";

const api = vi.hoisted(() => ({ fetchAdminProfiles: vi.fn() }));
vi.mock("../../api", () => api);

beforeEach(() => api.fetchAdminProfiles.mockReset());

describe("ProfilesCard", () => {
  it("shows user, formatted size and live or idle status", async () => {
    api.fetchAdminProfiles.mockResolvedValue({
      this_worker_only: false,
      profiles: [
        { name: "user-dev", email: "dev@example.com", bytes: 5 * 1024 * 1024, last_used: Math.floor(Date.now() / 1000) - 60, live: true },
        { name: "orphan", email: null, bytes: 2048, last_used: null, live: false },
      ],
    });
    renderWithClient(<ProfilesCard />);
    const dev = (await screen.findByText("dev@example.com")).closest("tr")!;
    expect(dev).toHaveTextContent("5.0 MB");
    expect(dev).toHaveTextContent("Live");
    const orphan = screen.getByText("orphan").closest("tr")!;
    expect(orphan).toHaveTextContent("2.0 KB");
    expect(orphan).toHaveTextContent("Idle");
    expect(orphan).toHaveTextContent("—");
  });

  it("warns that only this worker's profiles are listed in cluster mode", async () => {
    api.fetchAdminProfiles.mockResolvedValue({ this_worker_only: true, profiles: [] });
    renderWithClient(<ProfilesCard />);
    expect(await screen.findByText(/only this worker/i)).toBeInTheDocument();
    expect(screen.getByText("No browser profiles.")).toBeInTheDocument();
  });

  it("shows an error state", async () => {
    // Once: see ConnectionsCard.test.tsx for why not a persistent rejection.
    api.fetchAdminProfiles.mockRejectedValueOnce(new Error("boom"));
    renderWithClient(<ProfilesCard />);
    expect(await screen.findByText("Couldn't load browser profiles.")).toBeInTheDocument();
  });
});
