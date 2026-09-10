import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Connect from "./Connect";
import { ConnectLinkError } from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ConnectLinkError: actual.ConnectLinkError,
    fetchIntegrations: vi.fn(),
    redeemConnectLink: vi.fn(),
    connectCapture: vi.fn(),
  };
});

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u1", email: "dev@example.com" }, token: "t", isLoading: false, login: vi.fn(), logout: vi.fn() }),
}));

// Mounts a live CDP stream (SSE + command POSTs); stand it in.
vi.mock("../components/CdpScreencast", () => ({ default: () => <div>screencast</div> }));

import { fetchIntegrations, redeemConnectLink, connectCapture } from "../api";

const INTEGRATIONS = [
  { name: "acme", displayName: "Acme", version: "1.0.0", toolCount: 4, logo: "/logos/acme.svg" },
];

const COOKIE_RESULT = {
  type: "cookie" as const,
  integration: "acme",
  loginUrl: "https://example.com/login",
  cdpProxyUrl: "/api/auth/cookie/acme/cdp",
  sessionId: "u1",
  cdpToken: "tok-abc",
};

function renderPage(path = "/connect/acme?t=link-jwt") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/connect/:integration" element={<Connect />} />
          <Route path="/connected/:integration" element={<div>result page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(fetchIntegrations).mockResolvedValue({ integrations: INTEGRATIONS });
});

describe("Connect", () => {
  it("shows what is about to be connected without spending the link", async () => {
    renderPage();
    expect(await screen.findByRole("img", { name: /Acme logo/i })).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(redeemConnectLink).not.toHaveBeenCalled();
  });

  it("carries the workbench lockup so the human can see who is asking", async () => {
    const { container } = renderPage();
    await screen.findByRole("button", { name: "Connect" });
    expect(container.querySelector(".brand-lockup")).toBeInTheDocument();
  });

  it("redeems only once the human accepts", async () => {
    vi.mocked(redeemConnectLink).mockResolvedValue(COOKIE_RESULT);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(redeemConnectLink).toHaveBeenCalledWith("link-jwt"));
  });

  it("hands an oauth2 link off to the provider and marks the tab as agent-initiated", async () => {
    vi.mocked(redeemConnectLink).mockResolvedValue({ type: "oauth2", url: "https://example.com/authorize" });
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => expect(window.location.href).toBe("https://example.com/authorize"));
    expect(sessionStorage.getItem("awb_connect_origin")).toBe("link");
  });

  it("opens the remote browser for a cookie link", async () => {
    vi.mocked(redeemConnectLink).mockResolvedValue(COOKIE_RESULT);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("screencast")).toBeInTheDocument();
  });

  it("sends a captured cookie session to the result page instead of a bare message", async () => {
    vi.mocked(redeemConnectLink).mockResolvedValue(COOKIE_RESULT);
    vi.mocked(connectCapture).mockResolvedValue({ success: true, cookieCount: 3 });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Capture session" }));
    expect(await screen.findByText("result page")).toBeInTheDocument();
  });

  it("surfaces a consumed link as a link problem, not a raw error", async () => {
    vi.mocked(redeemConnectLink).mockRejectedValue(new ConnectLinkError("LINK_CONSUMED"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Link already used/)).toBeInTheDocument();
  });

  it("refuses to start when the link carries no token", async () => {
    renderPage("/connect/acme");
    expect(await screen.findByText(/missing link token/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("still offers to connect an integration the registry doesn't list", async () => {
    renderPage("/connect/mystery?t=link-jwt");
    expect(await screen.findByText("mystery")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });
});
