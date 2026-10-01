import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Login from "./Login";

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: null, token: null, isLoading: false, login: vi.fn(), logout: vi.fn() }),
}));

vi.mock("../api", () => ({
  fetchProviders: vi.fn(async () => ({ providers: ["google", "keycloak"] })),
  fetchAuthUrl: vi.fn(),
  fetchKeycloakAuthUrl: vi.fn(),
}));

vi.mock("@a-workbench/brand", async (orig) => ({
  ...(await orig<typeof import("@a-workbench/brand")>()),
  createSwarm: vi.fn(() => ({ destroy: vi.fn(), setGround: vi.fn(), replay: vi.fn(), state: vi.fn() })),
}));

// Block body, not an expression body — `tsc` rejects the value `vi.clearAllMocks()`
// returns as a hook callback's return type.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("Login", () => {
  it("tells a disabled user why they were turned away", async () => {
    window.history.pushState({}, "", "/login?error=account_disabled");
    try {
      render(<Login />);
      expect(await screen.findByText(/disabled by an administrator/i)).toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("shows no error on a plain visit", async () => {
    window.history.pushState({}, "", "/login");
    render(<Login />);
    await screen.findByRole("button", { name: /Continue with Google/ });
    expect(screen.queryByText(/disabled by an administrator/i)).not.toBeInTheDocument();
  });

  it("offers each configured provider", async () => {
    render(<Login />);
    expect(await screen.findByRole("button", { name: /Continue with Google/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue with Keycloak/ })).toBeInTheDocument();
  });

  it("states nothing it cannot know", async () => {
    const { container } = render(<Login />);
    await waitFor(() => screen.getByRole("button", { name: /Continue with Google/ }));
    const text = container.textContent ?? "";
    // The old panel asserted a tool count, a plugin count and a node status,
    // none of which this page has any way to know before sign-in.
    expect(text).not.toMatch(/TOOLS|PLUGINS|NODE|online/);
    expect(text).not.toContain("//");
  });

  it("explains when no provider is configured", async () => {
    const { fetchProviders } = await import("../api");
    vi.mocked(fetchProviders).mockResolvedValue({ providers: [] });
    render(<Login />);
    expect(await screen.findByText("No auth provider configured")).toBeInTheDocument();
  });

  it("carries the workbench mark beside the wordmark", () => {
    const { container } = render(<Login />);
    const lockup = container.querySelector(".brand-lockup");
    expect(lockup).toBeInTheDocument();
    expect(lockup?.querySelector(".brand-mark svg")).not.toBeNull();
    expect(lockup?.querySelector(".brand-name")).toHaveTextContent("workbench");
  });

  it("hosts the swarm canvas behind the hero copy", async () => {
    // vi.clearAllMocks() (above) clears call history but not an implementation
    // installed via mockResolvedValue, so an earlier test's override of
    // fetchProviders can otherwise leak in here regardless of run order.
    const { fetchProviders } = await import("../api");
    vi.mocked(fetchProviders).mockResolvedValue({ providers: ["google", "keycloak"] });
    const { container } = render(<Login />);
    await waitFor(() => screen.getByRole("button", { name: /Continue with Google/ }));
    const aside = container.querySelector(".login-art")!;
    expect(aside.querySelector("canvas.login-art-canvas")).not.toBeNull();
    expect(aside.querySelector(".login-art-copy")).not.toBeNull();
    expect(screen.getByText("Connect your agent's toolbelt.")).toBeInTheDocument();
  });
});
