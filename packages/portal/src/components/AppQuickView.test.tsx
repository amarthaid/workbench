import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppQuickView } from "./AppQuickView";
import type { IntegrationSummary } from "../api";

vi.mock("../api", () => ({ fetchIntegration: vi.fn() }));
import { fetchIntegration } from "../api";

const ACME: IntegrationSummary = {
  name: "acme",
  displayName: "Acme",
  version: "1.2.0",
  toolCount: 2,
  authType: "oauth2",
  configured: true,
  description: "Track work",
};

const DETAIL = {
  ...ACME,
  tools: [
    { name: "acme_search", description: "Search issues", effect: "read" },
    { name: "acme_create", description: "Create an issue", effect: "write" },
  ],
};

function renderView(over: Partial<React.ComponentProps<typeof AppQuickView>> = {}) {
  const props = { integration: ACME, connected: false, busy: false, onConnect: vi.fn(), onClose: vi.fn(), ...over };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AppQuickView {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchIntegration).mockResolvedValue(DETAIL as never);
});

describe("AppQuickView", () => {
  it("is a dialog named by the app", async () => {
    renderView();
    expect(screen.getByRole("dialog", { name: "Acme" })).toBeInTheDocument();
    await screen.findByText("acme_search");
  });

  it("shows the name, a Not connected chip and one facts line", async () => {
    renderView();
    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Auth: oauth2")).toBeInTheDocument();
    expect(screen.getByText("v1.2.0")).toBeInTheDocument();
    expect(screen.getByText("2 tools")).toBeInTheDocument();
    await screen.findByText("acme_search");
  });

  it("offers Connect when not connected and Reconnect when connected", async () => {
    const props = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(props.onConnect).toHaveBeenCalledTimes(1);
    await screen.findByText("acme_search");
  });

  it("offers Reconnect with a Connected chip when connected", async () => {
    renderView({ connected: true });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    await screen.findByText("acme_search");
  });

  it("has no primary action for a built-in app and calls it Built-in", async () => {
    renderView({ integration: { ...ACME, authType: "none" } });
    expect(screen.getByText("Built-in")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Connect|Reconnect)$/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("href", "/apps/acme");
    await screen.findByText("acme_search");
  });

  it("says Not configured and offers no primary action", async () => {
    renderView({ integration: { ...ACME, configured: false } });
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Connect|Reconnect)$/ })).toBeNull();
    await screen.findByText("acme_search");
  });

  it("has no primary action for a headers app", async () => {
    renderView({ integration: { ...ACME, name: "custom:a2", custom: true, authType: "apikey" } });
    expect(screen.queryByRole("button", { name: /^(Connect|Reconnect)$/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("href", "/apps/custom:a2");
    await screen.findByText("acme_search");
  });

  it("shows loading, then the tools", async () => {
    renderView();
    expect(screen.getByText("Loading tools...")).toBeInTheDocument();
    expect(await screen.findByText("acme_search")).toBeInTheDocument();
    expect(screen.getByText("Reads")).toBeInTheDocument();
    expect(screen.getByText("Writes")).toBeInTheDocument();
  });

  it("shows an error when the tools cannot load, and Manage still works", async () => {
    vi.mocked(fetchIntegration).mockRejectedValue(new Error("boom"));
    renderView();
    expect(await screen.findByText("Could not load the tools.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage" })).toBeInTheDocument();
  });

  it("says so when the app has no tools", async () => {
    vi.mocked(fetchIntegration).mockResolvedValue({ ...DETAIL, tools: [] } as never);
    renderView();
    expect(await screen.findByText("This app exposes no tools.")).toBeInTheDocument();
  });

  it("closes from the Close button", async () => {
    const props = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalled();
    await screen.findByText("acme_search");
  });
});
