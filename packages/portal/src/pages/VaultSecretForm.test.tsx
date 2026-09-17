import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import VaultSecretForm from "./VaultSecretForm";

vi.mock("../api", () => ({
  fetchVaultSecrets: vi.fn(),
  putVaultSecret: vi.fn(async () => undefined),
}));

import { fetchVaultSecrets, putVaultSecret } from "../api";

const nowSec = Math.floor(Date.now() / 1000);

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/vault" element={<div>LIST PAGE</div>} />
          <Route path="/vault/new" element={<VaultSecretForm />} />
          <Route path="/vault/:name/replace" element={<VaultSecretForm />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchVaultSecrets).mockResolvedValue([
    { name: "site_pw", description: "login", created_at: nowSec, updated_at: nowSec, last_used_at: null },
  ]);
});

describe("VaultSecretForm — add", () => {
  it("is a page with a back link, saves, and returns to the list with the value gone", async () => {
    renderAt("/vault/new");
    expect(screen.getByRole("link", { name: /vault/i })).toHaveAttribute("href", "/vault");
    expect(screen.getByRole("heading", { name: "Add secret" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "db_url" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "prod" } });
    const valueInput = screen.getByLabelText(/^value/i) as HTMLInputElement;
    expect(valueInput.type).toBe("password");
    fireEvent.change(valueInput, { target: { value: "postgres://x" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(putVaultSecret).toHaveBeenCalledWith({ name: "db_url", value: "postgres://x", description: "prod" })
    );
    expect(await screen.findByText("LIST PAGE")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("postgres://x");
    expect(document.querySelector("input")).toBeNull();
  });

  it("shows the reference the agent will use as the name is typed", () => {
    renderAt("/vault/new");
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "db_url" } });
    expect(screen.getByText("{{vault:db_url}}")).toBeInTheDocument();
  });

  it("toggles the value field with the eye button", () => {
    renderAt("/vault/new");
    const valueInput = screen.getByLabelText(/^value/i) as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: /show value while typing/i });
    expect(toggle.querySelector("svg")).not.toBeNull();
    fireEvent.click(toggle);
    expect(valueInput.type).toBe("text");
    expect(screen.getByRole("button", { name: /hide value/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("rejects an invalid name client-side and never calls the API", async () => {
    renderAt("/vault/new");
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "Bad Name" } });
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(document.querySelector(".ui-form-error")?.textContent).toMatch(/lowercase/i));
    expect(putVaultSecret).not.toHaveBeenCalled();
  });

  it("surfaces a server error in place", async () => {
    vi.mocked(putVaultSecret).mockRejectedValueOnce(new Error("Value is too large (8 KB max)."));
    renderAt("/vault/new");
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "k" } });
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/too large/i)).toBeInTheDocument();
    expect(screen.queryByText("LIST PAGE")).not.toBeInTheDocument();
  });

  it("cancel returns to the list", async () => {
    renderAt("/vault/new");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(await screen.findByText("LIST PAGE")).toBeInTheDocument();
  });
});

describe("VaultSecretForm — replace", () => {
  it("locks the name, pre-fills the description, and saves under the same name", async () => {
    renderAt("/vault/site_pw/replace");
    expect(screen.getByRole("heading", { name: /replace value of site_pw/i })).toBeInTheDocument();
    const name = screen.getByLabelText(/^name/i) as HTMLInputElement;
    expect(name.value).toBe("site_pw");
    expect(name.disabled).toBe(true);
    await waitFor(() => expect((screen.getByLabelText(/description/i) as HTMLInputElement).value).toBe("login"));
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(putVaultSecret).toHaveBeenCalledWith({ name: "site_pw", value: "new", description: "login" })
    );
    expect(await screen.findByText("LIST PAGE")).toBeInTheDocument();
  });
});
