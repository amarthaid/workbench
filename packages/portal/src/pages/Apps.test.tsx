import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Apps from "./Apps";

vi.mock("../api", () => ({
  fetchIntegrations: vi.fn(),
  fetchConnections: vi.fn(),
  startIntegrationAuth: vi.fn(),
  disconnectIntegration: vi.fn(),
  createCustomApp: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  user: { id: "u1", email: "dev@example.com" } as { id: string; email: string; canCreateCustomApps?: boolean },
}));
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: auth.user, token: "t", isLoading: false, login: vi.fn(), logout: vi.fn() }),
}));

vi.mock("../components/CookieAuthPopup", () => ({ default: () => null }));
vi.mock("../components/ApiKeyAuthModal", () => ({ default: () => null }));

import { fetchIntegrations, fetchConnections, startIntegrationAuth, createCustomApp } from "../api";

const INTEGRATIONS = [
  { name: "acme", displayName: "Acme", version: "1.0.0", toolCount: 4, categories: ["issues"], configured: true, authType: "oauth2", description: "Track work" },
  { name: "demo-repo", displayName: "Demo Repo", version: "2.1.0", toolCount: 9, categories: ["code"], configured: true, authType: "oauth2", description: "Review code" },
  { name: "unwired", displayName: "Unwired", version: "0.1.0", toolCount: 2, categories: ["code"], configured: false, authType: "oauth2" },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Apps />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchIntegrations).mockResolvedValue({ integrations: INTEGRATIONS });
  vi.mocked(fetchConnections).mockResolvedValue({ connections: [{ name: "acme", connected: true }] });
});

describe("Apps", () => {
  it("shows a loading state before the registry arrives", () => {
    vi.mocked(fetchIntegrations).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText("Loading apps…")).toBeInTheDocument();
  });

  it("lists every integration with its version and tool count", async () => {
    renderPage();
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0 · 4 tools")).toBeInTheDocument();
    expect(screen.getByText("Demo Repo")).toBeInTheDocument();
  });

  it("counts each tab", async () => {
    renderPage();
    expect(await screen.findByRole("tab", { name: /All/ })).toHaveTextContent("3");
    expect(screen.getByRole("tab", { name: /Connected/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /Available/ })).toHaveTextContent("2");
  });

  it("filters to connected integrations", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Connected/ }));
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByText("Demo Repo")).toBeNull();
  });

  it("filters by search across name and description", async () => {
    renderPage();
    await screen.findByText("Acme");
    fireEvent.change(screen.getByLabelText("Search apps"), { target: { value: "review" } });
    expect(screen.getByText("Demo Repo")).toBeInTheDocument();
    expect(screen.queryByText("Acme")).toBeNull();
  });

  it("filters by category", async () => {
    renderPage();
    await screen.findByText("Acme");
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "issues" } });
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByText("Demo Repo")).toBeNull();
  });

  it("links a configured integration to its detail page", async () => {
    renderPage();
    expect(await screen.findByRole("link", { name: /Acme/ })).toHaveAttribute("href", "/apps/acme");
  });

  it("does not link an integration whose auth is not configured", async () => {
    renderPage();
    await screen.findByText("Acme");
    expect(screen.queryByRole("link", { name: /Unwired/ })).toBeNull();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });

  it("starts a connect from the cell without following the link", async () => {
    vi.mocked(startIntegrationAuth).mockResolvedValue({ type: "oauth2", url: "https://example.com/authorize" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Demo Repo" }));
    await waitFor(() => expect(startIntegrationAuth).toHaveBeenCalledWith("demo-repo", undefined));
  });

  it("starts the connect as soon as a custom app is created", async () => {
    vi.mocked(createCustomApp).mockResolvedValue({
      app: { id: "a1", name: "Tracker", baseUrl: "https://mcp.example.com/mcp", integration: "custom:a1" },
    });
    vi.mocked(startIntegrationAuth).mockResolvedValue({ type: "oauth2", url: "https://example.com/authorize" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tracker" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startIntegrationAuth).toHaveBeenCalledWith("custom:a1", undefined));
    expect(createCustomApp).toHaveBeenCalledWith("Tracker", "https://mcp.example.com/mcp");
    // The browser is leaving for the OAuth page: the modal stays up, busy,
    // rather than flashing the grid first.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Connecting/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("shows a loader while the custom app registers", async () => {
    vi.mocked(createCustomApp).mockReturnValue(new Promise(() => {}));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tracker" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const busy = await screen.findByRole("button", { name: /Registering/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Name")).toBeDisabled();
  });

  it("closes the modal and surfaces the error when the connect cannot start", async () => {
    vi.mocked(createCustomApp).mockResolvedValue({
      app: { id: "a1", name: "Tracker", baseUrl: "https://mcp.example.com/mcp", integration: "custom:a1" },
    });
    vi.mocked(startIntegrationAuth).mockRejectedValue(new Error("OAuth start failed"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tracker" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("OAuth start failed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not start a connect when registering the custom app fails", async () => {
    vi.mocked(createCustomApp).mockRejectedValue(new Error("Invalid or blocked URL: http://10.0.0.1"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tracker" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "http://10.0.0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Invalid or blocked URL: http://10.0.0.1")).toBeInTheDocument();
    expect(startIntegrationAuth).not.toHaveBeenCalled();
  });

  it("explains an empty filter rather than showing a blank grid", async () => {
    renderPage();
    await screen.findByText("Acme");
    fireEvent.change(screen.getByLabelText("Search apps"), { target: { value: "nothing matches this" } });
    expect(screen.getByText("No apps match this filter.")).toBeInTheDocument();
  });
});

describe("custom-app policy", () => {
  it("offers New custom app by default", async () => {
    auth.user = { id: "u1", email: "dev@example.com" };
    renderPage();
    expect(await screen.findByRole("button", { name: "New custom app" })).toBeInTheDocument();
  });

  it("hides New custom app when the policy excludes this user", async () => {
    auth.user = { id: "u1", email: "dev@example.com", canCreateCustomApps: false };
    try {
      renderPage();
      await screen.findByText("Acme");
      expect(screen.queryByRole("button", { name: "New custom app" })).not.toBeInTheDocument();
    } finally {
      auth.user = { id: "u1", email: "dev@example.com" };
    }
  });
});
