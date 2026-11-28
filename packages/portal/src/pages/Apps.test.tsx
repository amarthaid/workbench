import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Apps from "./Apps";

vi.mock("../api", () => ({
  fetchIntegrations: vi.fn(),
  fetchConnections: vi.fn(),
  fetchIntegration: vi.fn(),
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

import { fetchIntegrations, fetchConnections, fetchIntegration, startIntegrationAuth, createCustomApp } from "../api";

const INTEGRATIONS = [
  { name: "acme", displayName: "Acme", version: "1.0.0", toolCount: 4, categories: ["issues"], configured: true, authType: "oauth2", description: "Track work" },
  { name: "demo-repo", displayName: "Demo Repo", version: "2.1.0", toolCount: 9, categories: ["code"], configured: true, authType: "oauth2", description: "Review code" },
  { name: "unwired", displayName: "Unwired", version: "0.1.0", toolCount: 2, categories: ["code"], configured: false, authType: "oauth2" },
];

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/apps"]}>
        <Where />
        <Routes>
          <Route path="/apps" element={<Apps />} />
          <Route path="/apps/:name" element={<div>Detail page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const ACME_DETAIL = {
  ...INTEGRATIONS[0],
  tools: [
    { name: "acme_search", description: "Search **issues** quickly", effect: "read" },
    { name: "acme_create", description: "Create an issue", effect: "write" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchIntegrations).mockResolvedValue({ integrations: INTEGRATIONS });
  vi.mocked(fetchConnections).mockResolvedValue({ connections: [{ name: "acme", connected: true }] });
  vi.mocked(fetchIntegration).mockResolvedValue(ACME_DETAIL as never);
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

  it("opens the quick view from a tile instead of navigating", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Acme/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/apps");
    expect(screen.queryByText("Detail page")).toBeNull();
  });

  it("makes the tile body a real button, not a link", async () => {
    renderPage();
    await screen.findByText("Acme");
    expect(screen.queryByRole("link", { name: /Acme/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Acme/ })).toBeInTheDocument();
  });

  it("goes to the full page from Manage", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Acme/ }));
    const dialog = await screen.findByRole("dialog");
    const manage = within(dialog).getByRole("link", { name: "Manage" });
    expect(manage).toHaveAttribute("href", "/apps/acme");
    fireEvent.click(manage);
    expect(await screen.findByText("Detail page")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/apps/acme");
  });

  it("shows the tools with effect badges and markdown descriptions in the quick view", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Acme/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("acme_search")).toBeInTheDocument();
    expect(within(dialog).getByText("Reads")).toBeInTheDocument();
    expect(within(dialog).getByText("Writes")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /acme_search/ }));
    const strong = within(dialog).getByText("issues");
    expect(strong.tagName).toBe("STRONG");
  });

  it("opens the quick view for an app that is not configured, without a primary action", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Unwired/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Not configured")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^(Connect|Reconnect)$/ })).toBeNull();
    expect(within(dialog).getByRole("link", { name: "Manage" })).toBeInTheDocument();
  });

  it("does not open the quick view from the tile Connect button", async () => {
    vi.mocked(startIntegrationAuth).mockResolvedValue({ type: "oauth2", url: "https://example.com/authorize" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Demo Repo" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(startIntegrationAuth).toHaveBeenCalledWith("demo-repo", undefined));
  });

  it("labels the header action Add custom app", async () => {
    renderPage();
    const add = await screen.findByRole("button", { name: "Add custom app" });
    expect(add).toHaveTextContent("Add custom app");
    expect(add.closest(".wb-page-actions")).not.toBeNull();
    fireEvent.click(add);
    expect(await screen.findByRole("dialog")).toHaveTextContent("New custom app");
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
    fireEvent.click(await screen.findByRole("button", { name: "Add custom app" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Add custom app" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Add custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tracker" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("OAuth start failed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not start a connect when registering the custom app fails", async () => {
    vi.mocked(createCustomApp).mockRejectedValue(new Error("Invalid or blocked URL: http://10.0.0.1"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tracker" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "http://10.0.0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Invalid or blocked URL: http://10.0.0.1")).toBeInTheDocument();
    expect(startIntegrationAuth).not.toHaveBeenCalled();
  });

  it("registers a headers app without starting OAuth", async () => {
    vi.mocked(createCustomApp).mockResolvedValue({
      app: { id: "a2", name: "Keyed", baseUrl: "https://mcp.example.com/mcp", integration: "custom:a2" },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keyed" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("radio", { name: "Headers" }));
    fireEvent.change(screen.getByLabelText("Header name 1"), { target: { value: "X-Api-Key" } });
    fireEvent.change(screen.getByLabelText("Header value 1"), { target: { value: "tok-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));

    await waitFor(() =>
      expect(createCustomApp).toHaveBeenCalledWith("Keyed", "https://mcp.example.com/mcp", [
        { name: "X-Api-Key", value: "tok-abc" },
      ])
    );
    expect(startIntegrationAuth).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("masks header values and shows the server's verify error inline", async () => {
    vi.mocked(createCustomApp).mockRejectedValue(new Error("Server rejected the headers (HTTP 401)"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add custom app" }));
    fireEvent.click(screen.getByRole("radio", { name: "Headers" }));
    expect(screen.getByLabelText("Header value 1")).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keyed" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.change(screen.getByLabelText("Header name 1"), { target: { value: "X-Api-Key" } });
    fireEvent.change(screen.getByLabelText("Header value 1"), { target: { value: "tok-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    expect(await screen.findByText("Server rejected the headers (HTTP 401)")).toBeInTheDocument();
  });

  it("resets the form on cancel so typed headers do not reappear", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keyed" } });
    fireEvent.click(screen.getByRole("radio", { name: "Headers" }));
    fireEvent.change(screen.getByLabelText("Header name 1"), { target: { value: "X-Api-Key" } });
    fireEvent.change(screen.getByLabelText("Header value 1"), { target: { value: "tok-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Add custom app" }));
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "OAuth" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Headers" }));
    expect(screen.getByLabelText("Header name 1")).toHaveValue("");
    expect(screen.getByLabelText("Header value 1")).toHaveValue("");
  });

  it("drops fully blank header rows and blocks a row with a name but no value", async () => {
    vi.mocked(createCustomApp).mockResolvedValue({
      app: { id: "a2", name: "Keyed", baseUrl: "https://mcp.example.com/mcp", integration: "custom:a2" },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add custom app" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keyed" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("radio", { name: "Headers" }));
    fireEvent.change(screen.getByLabelText("Header name 1"), { target: { value: "X-Api-Key" } });
    fireEvent.change(screen.getByLabelText("Header value 1"), { target: { value: "tok-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByLabelText("Header name 3"), { target: { value: "X-Team" } });
    expect(screen.getByRole("button", { name: "Add app" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Header name 3"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    await waitFor(() =>
      expect(createCustomApp).toHaveBeenCalledWith("Keyed", "https://mcp.example.com/mcp", [
        { name: "X-Api-Key", value: "tok-abc" },
      ])
    );
  });

  it("explains an empty filter rather than showing a blank grid", async () => {
    renderPage();
    await screen.findByText("Acme");
    fireEvent.change(screen.getByLabelText("Search apps"), { target: { value: "nothing matches this" } });
    expect(screen.getByText("No apps match this filter.")).toBeInTheDocument();
  });
});

describe("custom-app policy", () => {
  it("offers Add custom app by default", async () => {
    auth.user = { id: "u1", email: "dev@example.com" };
    renderPage();
    expect(await screen.findByRole("button", { name: "Add custom app" })).toBeInTheDocument();
  });

  it("hides Add custom app when the policy excludes this user", async () => {
    auth.user = { id: "u1", email: "dev@example.com", canCreateCustomApps: false };
    try {
      renderPage();
      await screen.findByText("Acme");
      expect(screen.queryByRole("button", { name: "Add custom app" })).not.toBeInTheDocument();
    } finally {
      auth.user = { id: "u1", email: "dev@example.com" };
    }
  });
});
