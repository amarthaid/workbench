import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ProfilesCard from "./ProfilesCard";

const api = vi.hoisted(() => ({ fetchAdminProfiles: vi.fn() }));
vi.mock("../../api", () => api);

// Block body: an arrow that returns the mock makes vitest run it as a teardown
// hook, which calls the mock again after the test.
beforeEach(() => {
  api.fetchAdminProfiles.mockReset();
});

describe("ProfilesCard", () => {
  it("shows user, formatted size and live or idle status", async () => {
    api.fetchAdminProfiles.mockResolvedValue({
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

  it("shows an empty state", async () => {
    api.fetchAdminProfiles.mockResolvedValue({ profiles: [] });
    renderWithClient(<ProfilesCard />);
    expect(await screen.findByText("No browser profiles.")).toBeInTheDocument();
  });

  it("does not refetch, and so re-walk every profile on disk, when the window regains focus", async () => {
    api.fetchAdminProfiles.mockResolvedValue({
      profiles: [{ name: "user-dev", email: "dev@example.com", bytes: 10, last_used: null, live: false }],
    });
    renderWithClient(<ProfilesCard />);
    await screen.findByText("dev@example.com");
    window.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));
    expect(api.fetchAdminProfiles).toHaveBeenCalledTimes(1);
  });

  it("shows an error state", async () => {
    api.fetchAdminProfiles.mockRejectedValue(new Error("boom"));
    renderWithClient(<ProfilesCard />);
    expect(await screen.findByText("Couldn't load browser profiles.")).toBeInTheDocument();
    expect(api.fetchAdminProfiles).toHaveBeenCalledTimes(1);
  });
});
