import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithClient } from "../test-utils";
import { AutoReconnectPanel } from "./AutoReconnectPanel";

vi.mock("../api", () => ({
  fetchVaultSecrets: vi.fn(),
  saveReconnectBindings: vi.fn(),
}));
import { fetchVaultSecrets, saveReconnectBindings } from "../api";

const CREDS = [
  { key: "username", label: "Username" },
  { key: "password", label: "Password", secret: true },
];

function renderPanel(props: Partial<React.ComponentProps<typeof AutoReconnectPanel>> = {}) {
  return renderWithClient(
    <MemoryRouter>
      <AutoReconnectPanel
        integration="acme"
        credentials={CREDS}
        status={{ bindings: {}, missing: ["username", "password"], dead: false }}
        {...props}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchVaultSecrets).mockResolvedValue([
    { name: "acme_pw" },
    { name: "acme_user" },
  ] as never);
  vi.mocked(saveReconnectBindings).mockResolvedValue({ success: true });
});

describe("AutoReconnectPanel", () => {
  it("shows a picker per credential slot and saves only changed bindings", async () => {
    renderPanel();
    await screen.findAllByRole("option", { name: "acme_pw" });
    expect(screen.getByText("Bind credentials to enable")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "acme_pw" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(saveReconnectBindings).toHaveBeenCalledWith("acme", { password: "acme_pw" }));
  });

  it("does not wipe a binding when the status loads after mount", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const panel = (status?: React.ComponentProps<typeof AutoReconnectPanel>["status"]) => (
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AutoReconnectPanel integration="acme" credentials={CREDS} status={status} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(panel(undefined));
    await screen.findAllByRole("option", { name: "acme_pw" });
    expect(screen.getByLabelText("Password")).toBeDisabled();
    rerender(panel({ bindings: { password: "acme_pw" }, missing: ["username"], dead: false }));
    expect(screen.getByLabelText("Password")).toHaveValue("acme_pw");
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("drops edits when remounted for another integration", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (key: string) => (
      <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AutoReconnectPanel
          key={key}
          integration={key}
          credentials={CREDS}
          status={{ bindings: {}, missing: ["username", "password"], dead: false }}
        />
      </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(tree("a"));
    await screen.findAllByRole("option", { name: "acme_pw" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "acme_pw" } });
    expect(screen.getByLabelText("Password")).toHaveValue("acme_pw");
    rerender(tree("b"));
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("labels a bound entry that no longer exists in the vault", async () => {
    renderPanel({ status: { bindings: { password: "gone_pw" }, missing: [], dead: false } });
    expect(await screen.findByRole("option", { name: "gone_pw (missing)" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("gone_pw");
  });

  it("keeps showing the saved value while the refetched status is still stale", async () => {
    renderPanel();
    await screen.findAllByRole("option", { name: "acme_pw" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "acme_pw" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await screen.findByText("Bindings saved.");
    expect(screen.getByLabelText("Password")).toHaveValue("acme_pw");
  });

  it("sends an empty string for a cleared slot", async () => {
    renderPanel({ status: { bindings: { password: "acme_pw" }, missing: ["username"], dead: false } });
    await screen.findAllByRole("option", { name: "acme_user" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(saveReconnectBindings).toHaveBeenCalledWith("acme", { password: "" }));
  });

  it("shows the server error inline when save fails", async () => {
    vi.mocked(saveReconnectBindings).mockRejectedValue(new Error("unknown vault entry"));
    renderPanel();
    await screen.findAllByRole("option", { name: "acme_pw" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "acme_pw" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("unknown vault entry")).toBeInTheDocument();
  });

  it("SSO recipe shows no pickers", () => {
    renderPanel({ credentials: [], status: { bindings: {}, missing: [], dead: false } });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(/existing SSO session/)).toBeInTheDocument();
    expect(screen.getByText("Auto-reconnect ready")).toBeInTheDocument();
  });

  it("renders the failure status", () => {
    renderPanel({
      status: { bindings: {}, missing: [], dead: true, last: { at: Date.now(), ok: false, error: "step 2: PROBE_FAILED" } },
    });
    expect(screen.getByText(/step 2: PROBE_FAILED/)).toBeInTheDocument();
    expect(screen.getByText(/reconnect manually/)).toBeInTheDocument();
  });

  it("renders success and expired statuses", () => {
    const { unmount } = renderPanel({
      status: { bindings: {}, missing: [], dead: false, last: { at: Date.now() - 120000, ok: true } },
    });
    expect(screen.getByText(/Auto-reconnected 2m ago/)).toBeInTheDocument();
    unmount();
    renderPanel({ status: { bindings: {}, missing: [], dead: true } });
    expect(screen.getByText("Session expired")).toBeInTheDocument();
  });

  it("disables pickers with a hint when there is no connection row", () => {
    renderPanel({ status: undefined });
    expect(screen.getByText("Connect first")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeDisabled();
  });

  it("an expired (dead) connection can still be bound: that is when binding matters", async () => {
    renderPanel({ status: { bindings: {}, missing: ["username", "password"], dead: true } });
    expect(screen.queryByText("Connect first")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeEnabled();
    await screen.findAllByRole("option", { name: "acme_pw" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "acme_pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveReconnectBindings).toHaveBeenCalledWith("acme", { password: "acme_pw" }));
  });
});
