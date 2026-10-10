import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AppDetail from "./AppDetail";

vi.mock("../api", () => ({
  fetchIntegration: vi.fn(),
  fetchConnections: vi.fn(),
  exportSession: vi.fn(),
  importSession: vi.fn(),
  openBrowserLiveUrl: vi.fn(),
  resetBrowserSession: vi.fn(),
  startIntegrationAuth: vi.fn(),
  disconnectIntegration: vi.fn(),
  removeCustomApp: vi.fn(),
  updateCustomAppHeaders: vi.fn(),
  fetchVaultSecrets: vi.fn().mockResolvedValue([]),
  saveReconnectBindings: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u1", email: "dev@example.com" }, token: "t", isLoading: false, login: vi.fn(), logout: vi.fn() }),
}));

vi.mock("../components/CookieAuthPopup", () => ({ default: () => null }));
vi.mock("../components/ApiKeyAuthModal", () => ({ default: () => null }));

import { fetchIntegration, fetchConnections, startIntegrationAuth, disconnectIntegration, updateCustomAppHeaders } from "../api";

const DETAIL = {
  name: "acme",
  displayName: "Acme",
  version: "1.0.0",
  description: "Track work",
  categories: ["issues"],
  toolCount: 2,
  authType: "oauth2",
  configured: true,
  tools: [
    { name: "acme_search", description: "Search issues" },
    { name: "acme_create", description: "Create an issue" },
  ],
};

function renderAt(name: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/apps/${name}`]}>
        <Routes>
          <Route path="/apps/:name" element={<AppDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchIntegration).mockResolvedValue(DETAIL);
  vi.mocked(fetchConnections).mockResolvedValue({ connections: [] });
});

describe("AppDetail", () => {
  it("titles the page with the display name and links back to the registry", async () => {
    renderAt("acme");
    expect(await screen.findByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Apps/ })).toHaveAttribute("href", "/apps");
  });

  it("reports the connection state and auth type", async () => {
    renderAt("acme");
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("oauth2")).toBeInTheDocument();
  });

  it("lists every tool with its description", async () => {
    renderAt("acme");
    expect(await screen.findByText("acme_search")).toBeInTheDocument();
    expect(screen.getByText("Create an issue")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tools (2)" })).toBeInTheDocument();
  });

  it("offers Connect while disconnected", async () => {
    vi.mocked(startIntegrationAuth).mockResolvedValue({ type: "oauth2", url: "https://example.com/authorize" });
    renderAt("acme");
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startIntegrationAuth).toHaveBeenCalledWith("acme", undefined));
  });

  it("offers Reconnect and Disconnect once connected, and confirms the disconnect", async () => {
    vi.mocked(fetchConnections).mockResolvedValue({ connections: [{ name: "acme", connected: true }] });
    vi.mocked(disconnectIntegration).mockResolvedValue({ success: true });
    renderAt("acme");

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    // The confirmation dialog's own Disconnect button, not the header's.
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnectIntegration).toHaveBeenCalledWith("acme"));
  });

  it("shows session transfer only for cookie integrations", async () => {
    renderAt("acme");
    await screen.findByRole("heading", { level: 1, name: "Acme" });
    expect(screen.queryByRole("heading", { name: "Session transfer" })).toBeNull();

    vi.mocked(fetchIntegration).mockResolvedValue({ ...DETAIL, authType: "cookie" });
    renderAt("acme");
    expect(await screen.findByRole("heading", { name: "Session transfer" })).toBeInTheDocument();
  });

  it("shows the auto-reconnect panel only for cookie apps with a recipe", async () => {
    vi.mocked(fetchIntegration).mockResolvedValue({ ...DETAIL, authType: "cookie" });
    renderAt("acme");
    await screen.findByRole("heading", { name: "Session transfer" });
    expect(screen.queryByRole("heading", { name: "Auto-reconnect" })).toBeNull();

    vi.mocked(fetchIntegration).mockResolvedValue({
      ...DETAIL,
      authType: "cookie",
      autoReconnect: { credentials: [{ key: "password", label: "Password", secret: true }] },
    });
    vi.mocked(fetchConnections).mockResolvedValue({
      connections: [{ name: "acme", connected: true, autoReconnect: { bindings: {}, missing: ["password"], dead: false } }],
    });
    renderAt("acme");
    expect(await screen.findByRole("heading", { name: "Auto-reconnect" })).toBeInTheDocument();
    expect(await screen.findByText("Bind credentials to enable")).toBeInTheDocument();
  });

  it("shows browser controls only for the built-in browser", async () => {
    vi.mocked(fetchIntegration).mockResolvedValue({
      ...DETAIL,
      name: "browser",
      displayName: "Browser",
      authType: "none",
    });
    renderAt("browser");
    expect(await screen.findByRole("heading", { name: "Browser controls" })).toBeInTheDocument();
  });

  it("explains an unknown integration instead of rendering an empty page", async () => {
    vi.mocked(fetchIntegration).mockRejectedValue(new Error("Failed to fetch integration"));
    renderAt("nope");
    expect(await screen.findByText("That app isn't in this registry.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to apps" })).toHaveAttribute("href", "/apps");
  });

  describe("custom headers app", () => {
    const HEADERS_APP = {
      ...DETAIL,
      name: "custom:a2",
      displayName: "Keyed",
      custom: true,
      authType: "apikey",
      headerNames: ["X-Api-Key", "X-Team"],
      tools: [],
    };

    it("edits headers, sending a blank value to keep the stored one", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue(HEADERS_APP);
      vi.mocked(updateCustomAppHeaders).mockResolvedValue({ app: { id: "a2", name: "Keyed", headerNames: ["X-Api-Key"] } });
      renderAt("custom:a2");
      expect(await screen.findByLabelText("Header name 1")).toHaveValue("X-Api-Key");
      expect(screen.getByLabelText("Header name 2")).toHaveValue("X-Team");
      expect(screen.getByLabelText("Header value 1")).toHaveValue("");
      fireEvent.click(screen.getByRole("button", { name: "Remove header 2" }));
      fireEvent.click(screen.getByRole("button", { name: "Save headers" }));
      await waitFor(() =>
        expect(updateCustomAppHeaders).toHaveBeenCalledWith("a2", [{ name: "X-Api-Key", value: "" }])
      );
    });

    it("sends a typed value as a replacement and an untouched row as blank", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue(HEADERS_APP);
      vi.mocked(updateCustomAppHeaders).mockResolvedValue({ app: { id: "a2", name: "Keyed", headerNames: ["X-Api-Key", "X-Team"] } });
      renderAt("custom:a2");
      await screen.findByLabelText("Header name 1");
      fireEvent.change(screen.getByLabelText("Header value 1"), { target: { value: "tok-new" } });
      fireEvent.click(screen.getByRole("button", { name: "Save headers" }));
      await waitFor(() =>
        expect(updateCustomAppHeaders).toHaveBeenCalledWith("a2", [
          { name: "X-Api-Key", value: "tok-new" },
          { name: "X-Team", value: "" },
        ])
      );
    });

    it("blocks save and says why when a row has a value but no name", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue(HEADERS_APP);
      vi.mocked(updateCustomAppHeaders).mockClear();
      renderAt("custom:a2");
      await screen.findByLabelText("Header name 1");
      fireEvent.change(screen.getByLabelText("Header value 2"), { target: { value: "tok-new" } });
      fireEvent.change(screen.getByLabelText("Header name 2"), { target: { value: "" } });
      expect(screen.getByText("Every header needs a name")).toBeInTheDocument();
      const save = screen.getByRole("button", { name: "Save headers" });
      expect(save).toBeDisabled();
      fireEvent.click(save);
      expect(updateCustomAppHeaders).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("Header name 2"), { target: { value: "X-Team" } });
      expect(screen.queryByText("Every header needs a name")).toBeNull();
      expect(save).not.toBeDisabled();
    });

    it("offers no Connect, Reconnect or Disconnect for a headers app", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue(HEADERS_APP);
      vi.mocked(fetchConnections).mockResolvedValue({ connections: [{ name: "custom:a2", connected: true }] });
      renderAt("custom:a2");
      await screen.findByLabelText("Header name 1");
      expect(screen.queryByRole("button", { name: /^(Connect|Reconnect|Disconnect)$/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Delete app" })).toBeInTheDocument();
    });

    it("keeps Reconnect and Disconnect for an OAuth custom app", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue({ ...DETAIL, name: "custom:a1", custom: true, authType: "oauth2" });
      vi.mocked(fetchConnections).mockResolvedValue({ connections: [{ name: "custom:a1", connected: true }] });
      renderAt("custom:a1");
      expect(await screen.findByRole("button", { name: "Reconnect" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    });

    it("shows the server error inline when saving fails", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue(HEADERS_APP);
      vi.mocked(updateCustomAppHeaders).mockRejectedValue(new Error("Server rejected the headers (HTTP 401)"));
      renderAt("custom:a2");
      await screen.findByLabelText("Header name 1");
      fireEvent.click(screen.getByRole("button", { name: "Save headers" }));
      expect(await screen.findByText("Server rejected the headers (HTTP 401)")).toBeInTheDocument();
    });

    it("offers no header editor for an OAuth app", async () => {
      renderAt("acme");
      await screen.findByText("Acme");
      expect(screen.queryByLabelText("Header name 1")).toBeNull();
    });
  });
});
