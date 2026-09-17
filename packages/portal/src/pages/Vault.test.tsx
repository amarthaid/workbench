import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Vault, { relativeTime } from "./Vault";

vi.mock("../api", () => ({
  fetchVaultSecrets: vi.fn(),
  putVaultSecret: vi.fn(async () => undefined),
  deleteVaultSecret: vi.fn(async () => undefined),
}));

import { fetchVaultSecrets, putVaultSecret, deleteVaultSecret } from "../api";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Vault />
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

describe("Vault page", () => {
  it("lists secrets with their reference and never a value column", async () => {
    renderPage();
    expect(await screen.findByText("site_pw")).toBeInTheDocument();
    expect(screen.getByText("{{vault:site_pw}}")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
    expect(screen.queryByText(/reveal|show value|copy value/i)).not.toBeInTheDocument();
  });

  it("adds a secret and clears the value field afterwards", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getByRole("button", { name: /add secret/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "db_url" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "prod" } });
    const valueInput = screen.getByLabelText(/^value/i) as HTMLInputElement;
    expect(valueInput.type).toBe("password");
    fireEvent.change(valueInput, { target: { value: "postgres://x" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(putVaultSecret).toHaveBeenCalledWith({ name: "db_url", value: "postgres://x", description: "prod" })
    );
    await waitFor(() => expect(screen.queryByLabelText(/^value/i)).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain("postgres://x");
  });

  it("toggles the value field between password and text with an icon button", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getByRole("button", { name: /add secret/i }));
    const valueInput = screen.getByLabelText(/^value/i) as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: /show value while typing/i });
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(valueInput.type).toBe("password");
    fireEvent.click(toggle);
    expect(valueInput.type).toBe("text");
    expect(screen.getByRole("button", { name: /hide value/i })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /hide value/i }));
    expect(valueInput.type).toBe("password");
  });

  it("rejects an invalid name client-side", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getByRole("button", { name: /add secret/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "Bad Name" } });
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/lowercase/i)).toBeInTheDocument();
    expect(putVaultSecret).not.toHaveBeenCalled();
  });

  it("overwrite locks the name", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getAllByRole("button", { name: /replace/i })[0]);
    const name = screen.getByLabelText(/^name/i) as HTMLInputElement;
    expect(name.value).toBe("site_pw");
    expect(name.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(putVaultSecret).toHaveBeenCalledWith({ name: "site_pw", value: "new", description: "login" })
    );
  });

  it("deletes after confirmation", async () => {
    renderPage();
    await screen.findByText("site_pw");
    fireEvent.click(screen.getAllByRole("button", { name: /^delete$/i })[0]);
    expect(await screen.findByText(/delete this secret/i)).toBeInTheDocument();
    const deleteButtons = screen.getAllByRole("button", { name: /^delete$/i });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);
    await waitFor(() => expect(deleteVaultSecret).toHaveBeenCalledWith("site_pw"));
  });
});
