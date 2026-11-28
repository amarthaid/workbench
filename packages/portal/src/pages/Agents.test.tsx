import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Agents from "./Agents";

vi.mock("../api", () => ({
  fetchAgents: vi.fn(),
  revokeAgent: vi.fn(),
  getApiKeyStatus: vi.fn(),
}));

import { fetchAgents, revokeAgent, getApiKeyStatus } from "../api";

const NOW = Math.floor(Date.now() / 1000);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiKeyStatus).mockResolvedValue({ hasKey: true });
  vi.mocked(fetchAgents).mockResolvedValue({
    agents: [
      { client_id: "cli-1", client_name: "Test Agent", scopes: ["mcp"], connected_since: NOW - 7200, expires_at: NOW + 3600 },
      { client_id: "cli-2", scopes: [], connected_since: NOW - 60, expires_at: NOW + 3600 },
    ],
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

describe("Agents", () => {
  it("shows the MCP endpoint and a client config block", async () => {
    renderPage();
    expect(await screen.findByText(`${window.location.origin}/mcp`)).toBeInTheDocument();
    expect(screen.getByText(/"mcpServers"/)).toBeInTheDocument();
  });

  it("reports that a key exists and links to settings rather than managing it here", async () => {
    renderPage();
    expect(await screen.findByText("Key active")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage API key" })).toHaveAttribute("href", "/settings");
    expect(screen.queryByRole("button", { name: /Generate/ })).toBeNull();
  });

  it("says when no key exists yet", async () => {
    vi.mocked(getApiKeyStatus).mockResolvedValue({ hasKey: false });
    renderPage();
    expect(await screen.findByText("No key")).toBeInTheDocument();
  });

  it("lists connected agents with an initial tile, id, connection age and scope chip", async () => {
    renderPage();
    const row = (await screen.findByText("Test Agent")).closest(".ui-list-row") as HTMLElement;
    expect(within(row).getByText("cli-1")).toBeInTheDocument();
    expect(within(row).getByText("cli-1").className).toContain("wb-mono");
    expect(row).toHaveTextContent("Connected 2h ago");
    expect(within(row).getByText("mcp")).toBeInTheDocument();
    expect(row.querySelector(".ui-list-row-tile")).toHaveTextContent("T");
  });

  it("shows the client id on every row, so two agents with one name are told apart", async () => {
    vi.mocked(fetchAgents).mockResolvedValue({
      agents: [
        { client_id: "cli-a", client_name: "Claude", scopes: [], connected_since: NOW - 60, expires_at: NOW + 3600 },
        { client_id: "cli-b", client_name: "Claude", scopes: [], connected_since: NOW - 60, expires_at: NOW + 3600 },
      ],
    });
    renderPage();
    expect(await screen.findByText("cli-a")).toBeInTheDocument();
    expect(screen.getByText("cli-b")).toBeInTheDocument();
    expect(screen.getAllByText("Claude")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Revoke Claude (cli-a)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke Claude (cli-b)" })).toBeInTheDocument();
  });

  it("shows skeleton rows while loading", () => {
    vi.mocked(fetchAgents).mockReturnValue(new Promise(() => {}) as never);
    renderPage();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("falls back to the client id when an agent has no name", async () => {
    renderPage();
    await screen.findByText("Test Agent");
    // cli-2 has no client_name: its id stands in for the name cell too.
    expect(screen.getAllByText("cli-2").length).toBeGreaterThanOrEqual(1);
  });

  it("confirms before revoking, explaining that a live session may outlast it", async () => {
    vi.mocked(revokeAgent).mockResolvedValue({ revoked: 1 });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke Test Agent (cli-1)" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Revoke access for Test Agent (cli-1)?");
    expect(within(dialog).getByText(/access token/)).toBeInTheDocument();
    expect(revokeAgent).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeAgent).toHaveBeenCalledWith("cli-1"));
    expect(revokeAgent).toHaveBeenCalledTimes(1);
  });

  it("does not revoke when the confirm is cancelled", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Test Agent (cli-1)" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(revokeAgent).not.toHaveBeenCalled();
  });

  it("says so when no agents are connected", async () => {
    vi.mocked(fetchAgents).mockResolvedValue({ agents: [] });
    renderPage();
    expect(await screen.findByText("No agents connected.")).toBeInTheDocument();
  });

  it("surfaces a revoke failure", async () => {
    vi.mocked(revokeAgent).mockRejectedValue(new Error("Revoke failed"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Test Agent (cli-1)" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Revoke failed")).toBeInTheDocument();
  });
});
