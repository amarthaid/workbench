import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";

const auth = vi.hoisted(() => ({
  user: { id: "u1", email: "dev@example.com", isAdmin: false } as {
    id: string;
    email: string;
    isAdmin?: boolean;
  },
}));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: auth.user, token: "t", isLoading: false, login: vi.fn(), logout: vi.fn() }),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
    </MemoryRouter>
  );
}

describe("Sidebar", () => {
  it("is a labelled navigation landmark", () => {
    renderAt("/");
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });

  it("lists every destination", () => {
    renderAt("/");
    for (const name of ["Home", "Apps", "Agents", "Activity", "Files", "Vault", "Settings"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
  });

  it("lists Files and Vault last, after Activity, set off by a separator", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const list = nav.querySelector("ul.wb-nav")!;
    const items = Array.from(list.querySelectorAll("li"));
    const labels = items.map((li) => li.textContent?.trim() ?? "");
    expect(labels).toEqual(["Home", "Apps", "Agents", "Activity", "", "Files", "Vault"]);
    expect(items[4]).toHaveAttribute("role", "separator");
  });

  it("marks only the current route as the current page", () => {
    renderAt("/apps");
    expect(screen.getByRole("link", { name: "Apps" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("does not mark Home as current on a nested route", () => {
    renderAt("/activity");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "page");
  });

  it("shows the signed-in email", () => {
    renderAt("/");
    expect(screen.getByText("dev@example.com")).toBeInTheDocument();
  });

  it("hides the Admin link from non-admins", () => {
    auth.user = { id: "u1", email: "dev@example.com", isAdmin: false };
    renderAt("/");
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("shows the Admin link to admins, pointing at /admin", () => {
    auth.user = { id: "u2", email: "admin@example.com", isAdmin: true };
    renderAt("/");
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
    auth.user = { id: "u1", email: "dev@example.com", isAdmin: false };
  });

  it("keeps Help out of the sidebar — it lives on Settings", () => {
    renderAt("/");
    expect(screen.queryByRole("link", { name: "Help" })).not.toBeInTheDocument();
  });

  it("carries the workbench mark beside the wordmark", () => {
    const { container } = renderAt("/");
    const lockup = container.querySelector(".brand-lockup");
    expect(lockup).toBeInTheDocument();
    // Mark and wordmark inside the one container that sets the gap between them.
    expect(lockup?.querySelector(".brand-mark svg")).not.toBeNull();
    expect(lockup?.querySelector(".brand-name")).toHaveTextContent("workbench");
  });
});
