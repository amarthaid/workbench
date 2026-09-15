import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Files, { formatBytes, expiryLabel } from "./Files";

vi.mock("../api", () => ({
  fetchWorkspaceFiles: vi.fn(),
  downloadWorkspaceFile: vi.fn(async () => undefined),
  uploadWorkspaceFile: vi.fn(async () => ({})),
  deleteWorkspaceFile: vi.fn(async () => undefined),
}));

import {
  fetchWorkspaceFiles,
  downloadWorkspaceFile,
  deleteWorkspaceFile,
} from "../api";

const HOUR = 3_600_000;

function listing(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    files: [
      {
        name: "statement.csv",
        bytes: 2048,
        mtime: new Date(now - 2 * HOUR).toISOString(),
        expiresAt: new Date(now + 22 * HOUR).toISOString(),
      },
      {
        name: "nearly-gone.csv",
        bytes: 100,
        mtime: new Date(now - 23.5 * HOUR).toISOString(),
        expiresAt: new Date(now + 0.5 * HOUR).toISOString(),
      },
    ],
    usedBytes: 2148,
    quotaBytes: 268_435_456,
    maxFileBytes: 104_857_600,
    ttlHours: 24,
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Files />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [2048, "2.0 KB"],
    [1_500_000, "1.4 MB"],
  ])("formats %i as %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe("expiryLabel", () => {
  const now = new Date("2026-09-15T12:00:00Z");

  it.each([
    ["2026-09-15T12:30:00Z", "30m left"],
    ["2026-09-16T06:00:00Z", "18h left"],
    ["2026-09-17T12:00:00Z", "2d left"],
    ["2026-09-15T11:00:00Z", "expiring"],
  ])("renders %s as %s", (at, expected) => {
    expect(expiryLabel(at, now)).toBe(expected);
  });

  it("does not throw on an unparseable timestamp", () => {
    expect(expiryLabel("not a date", now)).toBe("unknown");
  });
});

describe("Files page", () => {
  it("lists files with size and time to expiry", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();

    expect(await screen.findByText("statement.csv")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    // The countdown is the point: retention is age only, so people need to see
    // it without hunting for a tooltip.
    expect(screen.getAllByText(/left$/)).toHaveLength(2);
  });

  it("states the retention rule and the quota in the header", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();

    expect(await screen.findByText(/deleted 24h after they are written/)).toBeInTheDocument();
  });

  it("explains what the workspace is for when it is empty", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(
      listing({ files: [], usedBytes: 0 }) as never
    );
    renderPage();

    expect(await screen.findByText(/Browser downloads land in this workspace/)).toBeInTheDocument();
  });

  it("downloads through the API client rather than a plain link", async () => {
    // A top-level navigation cannot carry the portal's Authorization header,
    // so an <a href> to /api/files would 401. The click has to go through fetch.
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();

    const row = (await screen.findByText("statement.csv")).closest("tr")!;
    fireEvent.click(within(row, "Download"));

    await waitFor(() => expect(downloadWorkspaceFile).toHaveBeenCalledWith("statement.csv"));
  });

  it("deletes a file", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();

    const row = (await screen.findByText("statement.csv")).closest("tr")!;
    fireEvent.click(within(row, "Delete"));

    // TanStack Query v5 hands mutationFn a context object as a second
    // argument, so assert on the first argument rather than the whole call.
    await waitFor(() =>
      expect(vi.mocked(deleteWorkspaceFile).mock.calls[0]?.[0]).toBe("statement.csv")
    );
  });

  it("surfaces a download failure instead of failing silently", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    vi.mocked(downloadWorkspaceFile).mockRejectedValue(new Error("Download failed"));
    renderPage();

    const row = (await screen.findByText("statement.csv")).closest("tr")!;
    fireEvent.click(within(row, "Download"));

    expect(await screen.findByText("Download failed")).toBeInTheDocument();
  });

  it("reports a failed listing", async () => {
    vi.mocked(fetchWorkspaceFiles).mockRejectedValue(new Error("nope"));
    renderPage();

    expect(await screen.findByText(/Couldn't load your files/)).toBeInTheDocument();
  });
});

/** Find a button by label within one table row. */
function within(row: HTMLElement, label: string): HTMLElement {
  const button = Array.from(row.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  );
  if (!button) throw new Error(`no ${label} button in row`);
  return button;
}
