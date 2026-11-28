import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Link } from "react-router-dom";
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

import { fetchIntegration, fetchConnections, fetchVaultSecrets, startIntegrationAuth, disconnectIntegration, updateCustomAppHeaders, removeCustomApp } from "../api";

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
    { name: "acme_search", description: "Search **issues** quickly", effect: "read" },
    { name: "acme_create", description: "Create an issue", effect: "write" },
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

  it("lists every tool in the shared accordion with effect badges", async () => {
    renderAt("acme");
    expect(await screen.findByText("acme_search")).toBeInTheDocument();
    expect(screen.getByText("acme_create")).toBeInTheDocument();
    expect(screen.getByText("Reads")).toBeInTheDocument();
    expect(screen.getByText("Writes")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tools (2)" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders a tool description as markdown once the tool is expanded", async () => {
    renderAt("acme");
    fireEvent.click(await screen.findByRole("button", { name: /acme_search/ }));
    expect(screen.getByText("issues", { selector: "strong" })).toBeInTheDocument();
  });

  it("still renders a deep link to a registry app with its tools", async () => {
    vi.mocked(fetchIntegration).mockResolvedValue({
      ...DETAIL,
      name: "slack",
      displayName: "Slack",
      tools: [{ name: "slack_post", description: "Post a message", effect: "write" }],
    });
    renderAt("slack");
    expect(await screen.findByRole("heading", { level: 1, name: "Slack" })).toBeInTheDocument();
    expect(fetchIntegration).toHaveBeenCalledWith("slack");
    expect(screen.getByText("slack_post")).toBeInTheDocument();
  });

  it("puts the app logo in the page header", async () => {
    vi.mocked(fetchIntegration).mockResolvedValue({ ...DETAIL, logo: "/api/integrations/acme/logo" });
    renderAt("acme");
    const logo = await screen.findByRole("img", { name: "Acme logo" });
    expect(logo.closest("header")).not.toBeNull();
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

  it("does not carry panel edits from one app to another", async () => {
    const detail = (name: string) => ({
      ...DETAIL,
      name,
      displayName: name,
      authType: "cookie",
      autoReconnect: { credentials: [{ key: "password", label: "Password", secret: true }] },
    });
    vi.mocked(fetchIntegration).mockImplementation(async (n: string) => detail(n));
    vi.mocked(fetchConnections).mockResolvedValue({
      connections: [
        { name: "alpha", connected: true, autoReconnect: { bindings: {}, missing: ["password"], dead: false } },
        { name: "beta", connected: true, autoReconnect: { bindings: { password: "beta_pw" }, missing: [], dead: false } },
      ],
    });
    vi.mocked(fetchVaultSecrets).mockResolvedValue([{ name: "alpha_pw" }, { name: "beta_pw" }] as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Beta is already cached, so navigating never passes through a loading state
    // that would unmount the panel and hide a missing key.
    qc.setQueryData(["integration", "beta"], detail("beta"));
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/apps/alpha"]}>
          <Link to="/apps/beta">go beta</Link>
          <Routes>
            <Route path="/apps/:name" element={<AppDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await screen.findAllByRole("option", { name: "alpha_pw" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "alpha_pw" } });
    expect(screen.getByLabelText("Password")).toHaveValue("alpha_pw");
    fireEvent.click(screen.getByText("go beta"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "beta" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveValue("beta_pw"));
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

    it("removing a custom app needs the app's name typed first", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue({ ...DETAIL, name: "custom:a1", displayName: "Tracker", custom: true, authType: "oauth2" });
      vi.mocked(removeCustomApp).mockResolvedValue(undefined as never);
      renderAt("custom:a1");
      fireEvent.click(await screen.findByRole("button", { name: "Remove app" }));
      const dialog = await screen.findByRole("dialog");
      const confirm = within(dialog).getByRole("button", { name: "Remove app" });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "tracker" } });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Tracker" } });
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);
      await waitFor(() => expect(removeCustomApp).toHaveBeenCalledWith("a1"));
    });

    it("keeps the removal dialog open and shows the error when removing fails", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue({ ...DETAIL, name: "custom:a1", displayName: "Tracker", custom: true, authType: "oauth2" });
      vi.mocked(removeCustomApp).mockRejectedValue(new Error("Delete failed"));
      renderAt("custom:a1");
      fireEvent.click(await screen.findByRole("button", { name: "Remove app" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Tracker" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove app" }));
      expect(await within(dialog).findByText("Delete failed")).toBeInTheDocument();
    });

    it("uses the shared red-text style for Disconnect and Remove app", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue({ ...DETAIL, name: "custom:a1", custom: true, authType: "oauth2" });
      vi.mocked(fetchConnections).mockResolvedValue({ connections: [{ name: "custom:a1", connected: true }] });
      renderAt("custom:a1");
      expect(await screen.findByRole("button", { name: "Disconnect" })).toHaveClass("ui-row-action-danger");
      expect(screen.getByRole("button", { name: "Remove app" })).toHaveClass("ui-row-action-danger");
    });

    it("offers no Connect, Reconnect or Disconnect for a headers app", async () => {
      vi.mocked(fetchIntegration).mockResolvedValue(HEADERS_APP);
      vi.mocked(fetchConnections).mockResolvedValue({ connections: [{ name: "custom:a2", connected: true }] });
      renderAt("custom:a2");
      await screen.findByLabelText("Header name 1");
      expect(screen.queryByRole("button", { name: /^(Connect|Reconnect|Disconnect)$/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Remove app" })).toBeInTheDocument();
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
      await screen.findByRole("heading", { level: 1, name: "Acme" });
      expect(screen.queryByLabelText("Header name 1")).toBeNull();
    });
  });
});
