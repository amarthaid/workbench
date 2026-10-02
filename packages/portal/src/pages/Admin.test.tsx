import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import Admin from "./Admin";

const bodies = vi.hoisted(() => ({ profilesMounted: vi.fn() }));
vi.mock("../components/admin/OverviewTab", () => ({ default: () => <p>overview-body</p> }));
vi.mock("../components/admin/ActivityCard", () => ({ default: () => <p>activity-body</p> }));
vi.mock("../components/admin/ConnectionsCard", () => ({ default: () => <p>connections-body</p> }));
vi.mock("../components/admin/CustomAppsCard", () => ({ default: () => <p>custom-apps-body</p> }));
vi.mock("../components/admin/ProfilesCard", () => ({
  default: () => {
    bodies.profilesMounted();
    return <p>profiles-body</p>;
  },
}));
vi.mock("../components/admin/VaultTab", () => ({ default: () => <p>vault-body</p> }));
vi.mock("../components/admin/FilesTab", () => ({ default: () => <p>files-body</p> }));
vi.mock("../components/admin/UsersTab", () => ({ default: () => <p>users-body</p> }));
vi.mock("../components/admin/ConfigTab", () => ({ default: () => <p>config-body</p> }));

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(path: string) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/", path]} initialIndex={1}>
        <Routes>
          <Route path="/admin/*" element={<Admin />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  bodies.profilesMounted.mockReset();
});

describe("Admin page", () => {
  it("has a title and opens on the Overview tab", () => {
    renderAt("/admin");
    expect(screen.getByRole("heading", { level: 1, name: "Admin" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("overview-body")).toBeInTheDocument();
  });

  it("lists every section as one tab row", () => {
    renderAt("/admin");
    const names = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(names).toEqual([
      "Overview", "Activity", "Connections", "Custom apps", "Browser profiles", "Vault", "Files", "Users", "Config",
    ]);
  });

  it("opens the tab named by the URL", () => {
    renderAt("/admin/connections");
    expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("connections-body")).toBeInTheDocument();
  });

  it("a tab click changes the route and shows only that tab", () => {
    renderAt("/admin");
    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/users");
    expect(screen.getByText("users-body")).toBeInTheDocument();
    expect(screen.queryByText("overview-body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/admin$/);
  });

  it("mounts a tab only when it is opened", () => {
    renderAt("/admin");
    expect(bodies.profilesMounted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Browser profiles" }));
    expect(bodies.profilesMounted).toHaveBeenCalled();
  });

  it("sends an unknown section back to the Overview", () => {
    renderAt("/admin/nope");
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/admin$/);
    expect(screen.getByText("overview-body")).toBeInTheDocument();
  });
});
