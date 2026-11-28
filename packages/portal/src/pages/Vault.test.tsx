import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Vault, { relativeTime } from "./Vault";
import { within } from "@testing-library/react";

vi.mock("../api", () => ({
  fetchVaultSecrets: vi.fn(),
  deleteVaultSecret: vi.fn(async () => undefined),
}));

import { fetchVaultSecrets, deleteVaultSecret } from "../api";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/vault"]}>
        <Routes>
          <Route path="/vault" element={<Vault />} />
          <Route path="/vault/new" element={<div>ADD PAGE</div>} />
          <Route path="/vault/:name/replace" element={<div>REPLACE PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const nowSec = Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchVaultSecrets).mockResolvedValue([
    { name: "site_pw", description: "login", created_at: nowSec - 3600, updated_at: nowSec - 3600, last_used_at: nowSec - 60 },
    { name: "api_key", description: null, created_at: nowSec, updated_at: nowSec, last_used_at: null },
  ]);
});

describe("relativeTime", () => {
  it("phrases seconds ago", () => {
    expect(relativeTime(nowSec - 30, nowSec)).toBe("just now");
    expect(relativeTime(nowSec - 120, nowSec)).toBe("2m ago");
    expect(relativeTime(nowSec - 7200, nowSec)).toBe("2h ago");
    expect(relativeTime(nowSec - 3 * 86400, nowSec)).toBe("3d ago");
    expect(relativeTime(null, nowSec)).toBe("never");
  });
});

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest(".ui-list-row") as HTMLElement;
}

describe("Vault page", () => {
  it("lists secrets with name, description, reference and updated and last used", async () => {
    renderPage();
    expect(await screen.findByText("site_pw")).toBeInTheDocument();
    const row = rowOf("site_pw");
    expect(row).toHaveTextContent("login");
    expect(row).toHaveTextContent("Updated 1h ago");
    expect(row).toHaveTextContent("last used 1m ago");
    expect(rowOf("api_key")).toHaveTextContent("last used never");
    expect(screen.getByText("{{vault:site_pw}}")).toBeInTheDocument();
    expect(row.querySelector(".ui-list-row-tile svg")).not.toBeNull();
    expect(screen.queryByText(/reveal|show value|copy value/i)).not.toBeInTheDocument();
  });

  it("shows skeleton rows while loading", () => {
    vi.mocked(fetchVaultSecrets).mockReturnValue(new Promise(() => {}) as never);
    renderPage();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("shows an empty state with the primary action", async () => {
    vi.mocked(fetchVaultSecrets).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/No secrets yet/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /add secret/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("puts Add secret and One-time link in the header band", async () => {
    renderPage();
    await screen.findByText("site_pw");
    const band = document.querySelector(".ui-box-head") as HTMLElement;
    expect(within(band).getByRole("button", { name: /add secret/i })).toBeInTheDocument();
    expect(within(band).getByRole("button", { name: /one-time link/i })).toBeInTheDocument();
  });

  it("navigates to the add page", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getByRole("button", { name: /add secret/i }));
    expect(await screen.findByText("ADD PAGE")).toBeInTheDocument();
  });

  it("copies exactly the reference, never a value, and says so in the tooltip", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();
    await screen.findByText("site_pw");

    const chip = within(rowOf("site_pw")).getByRole("button", { name: /copy reference/i });
    fireEvent.click(chip);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("{{vault:site_pw}}"));
    expect(writeText).toHaveBeenCalledTimes(1);
    fireEvent.focus(chip);
    expect(await screen.findByText("Copies the reference, never the value")).toBeInTheDocument();
  });

  it("replace links to the secret's own replace route", async () => {
    renderPage();
    await screen.findByText("site_pw");
    const link = within(rowOf("site_pw")).getByRole("link", { name: /replace/i });
    expect(link).toHaveAttribute("href", "/vault/site_pw/replace");
    fireEvent.click(link);
    expect(await screen.findByText("REPLACE PAGE")).toBeInTheDocument();
  });

  it("delete asks for the exact secret name and warns references will stop working", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(within(rowOf("site_pw")).getByRole("button", { name: /delete site_pw/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/references to .* will stop working/i);
    const confirm = within(dialog).getByRole("button", { name: "Delete secret" });
    expect(confirm).toBeDisabled();

    const input = within(dialog).getByLabelText(/type the secret/i);
    fireEvent.change(input, { target: { value: "SITE_PW" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: "site_pw" } });
    expect(confirm).toBeEnabled();
    expect(deleteVaultSecret).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    await waitFor(() => expect(deleteVaultSecret).toHaveBeenCalledWith("site_pw"));
  });

  it("cancelling the delete leaves the secret alone", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(within(rowOf("site_pw")).getByRole("button", { name: /delete site_pw/i }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteVaultSecret).not.toHaveBeenCalled();
  });

  it("keeps a failed delete on screen", async () => {
    vi.mocked(deleteVaultSecret).mockRejectedValue(new Error("Delete failed"));
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(within(rowOf("site_pw")).getByRole("button", { name: /delete site_pw/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/type the secret/i), { target: { value: "site_pw" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete secret" }));
    expect(await screen.findByText("Delete failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
