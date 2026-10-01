import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import RequireAdmin from "./RequireAdmin";

const auth = vi.hoisted(() => ({
  value: { user: null as null | { id: string; email: string; isAdmin?: boolean }, isLoading: false },
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => auth.value }));

function renderAdmin() {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/admin" element={<RequireAdmin><p>secret</p></RequireAdmin>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("RequireAdmin", () => {
  it("renders children for an admin", () => {
    auth.value = { user: { id: "u1", email: "admin@example.com", isAdmin: true }, isLoading: false };
    renderAdmin();
    expect(screen.getByText("secret")).toBeInTheDocument();
  });

  it("redirects a non-admin to the home page", () => {
    auth.value = { user: { id: "u2", email: "dev@example.com", isAdmin: false }, isLoading: false };
    renderAdmin();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.getByText("home")).toBeInTheDocument();
  });

  it("treats a missing isAdmin as not admin", () => {
    auth.value = { user: { id: "u2", email: "dev@example.com" }, isLoading: false };
    renderAdmin();
    expect(screen.getByText("home")).toBeInTheDocument();
  });

  it("shows nothing privileged while the session is still loading", () => {
    auth.value = { user: null, isLoading: true };
    renderAdmin();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.queryByText("home")).not.toBeInTheDocument();
  });
});
