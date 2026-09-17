import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import VaultOneTime from "./VaultOneTime";

vi.mock("../api", () => ({
  mintVaultOneTimeLink: vi.fn(),
}));

import { mintVaultOneTimeLink } from "../api";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/vault/one-time"]}>
        <Routes>
          <Route path="/vault" element={<div>LIST PAGE</div>} />
          <Route path="/vault/one-time" element={<VaultOneTime />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  vi.mocked(mintVaultOneTimeLink).mockResolvedValue({
    url: "http://localhost:3000/api/vault/otl/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
});

describe("VaultOneTime", () => {
  it("mints with the default 5-minute ttl, then shows the link once and copies it", async () => {
    renderPage();
    expect(screen.getByText("← Vault")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("300");

    const value = screen.getByLabelText("Value") as HTMLInputElement;
    // Masked by CSS, never type=password: no autofill, no save prompt.
    expect(value.type).toBe("text");
    expect(value).toHaveClass("ui-input-masked");
    expect(value).toHaveAttribute("autocomplete", "off");
    expect(value).toHaveAttribute("data-1p-ignore");
    fireEvent.change(value, { target: { value: "one-shot-pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() =>
      expect(mintVaultOneTimeLink).toHaveBeenCalledWith({ value: "one-shot-pw", ttl_seconds: 300 })
    );
    const link = (await screen.findByLabelText("One-time link")) as HTMLInputElement;
    expect(link.value).toContain("/api/vault/otl/");
    expect(link.readOnly).toBe(true);
    expect(screen.getByText(/expires in 5 minutes/)).toBeInTheDocument();
    // The typed value is gone from the page.
    expect(screen.queryByLabelText("Value")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link.value));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("LIST PAGE")).toBeInTheDocument();
  });

  it("sends the chosen ttl and refuses an empty value without calling the API", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByText("Value cannot be empty.")).toBeInTheDocument();
    expect(mintVaultOneTimeLink).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(mintVaultOneTimeLink).toHaveBeenCalledWith({ value: "v", ttl_seconds: 600 }));
  });

  it("surfaces an API error and keeps the form", async () => {
    vi.mocked(mintVaultOneTimeLink).mockRejectedValueOnce(new Error("Value is too large (8 KB max)."));
    renderPage();
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByText("Value is too large (8 KB max).")).toBeInTheDocument();
    expect(screen.getByLabelText("Value")).toBeInTheDocument();
  });
});
