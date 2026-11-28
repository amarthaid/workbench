import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Files, { formatBytes, expiryLabel, expiresInPhrase, middleTruncate } from "./Files";
import { ToastProvider } from "../components/ui/Toast";

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
      <ToastProvider>
        <Files />
      </ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deleteWorkspaceFile).mockResolvedValue(undefined);
  vi.mocked(downloadWorkspaceFile).mockResolvedValue(undefined);
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

describe("expiresInPhrase", () => {
  const now = new Date("2026-09-15T12:00:00Z");

  it("drops the trailing 'left' so it reads in a sentence", () => {
    expect(expiresInPhrase("2026-09-16T06:00:00Z", now)).toBe("18h");
  });

  it.each([
    ["2026-09-15T11:00:00Z", "already past"],
    ["not a date", "unparseable"],
  ])("returns null for %s (%s)", (at) => {
    // The caller drops the whole line rather than printing
    // "would have expired on its own in expiring".
    expect(expiresInPhrase(at, now)).toBeNull();
  });
});

describe("middleTruncate", () => {
  it("leaves short names alone", () => {
    expect(middleTruncate("a.csv", 20)).toBe("a.csv");
  });

  it("keeps the tail, including the timestamp and extension", () => {
    const name = "bank-statement-export-2026-11-28T10-15-00Z.csv";
    const out = middleTruncate(name, 30);
    expect(out).toHaveLength(30);
    expect(out).toContain("\u2026");
    expect(out.endsWith("10-15-00Z.csv")).toBe(true);
    expect(out.startsWith("bank-")).toBe(true);
  });
});

function manyFiles(n: number) {
  const now = Date.now();
  return {
    ...listing(),
    files: Array.from({ length: n }, (_, i) => ({
      name: `file-${String(i).padStart(2, "0")}.csv`,
      bytes: (i + 1) * 100,
      // file-00 is the newest and the largest-expiry; bigger index is older, bigger size
      mtime: new Date(now - (i + 1) * HOUR).toISOString(),
      expiresAt: new Date(now + (24 - (i % 20)) * HOUR - i * 60_000).toISOString(),
    })),
  };
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest(".ui-list-row") as HTMLElement;
}

function rowNames(): string[] {
  return Array.from(document.querySelectorAll(".ui-list-row .ui-list-row-title")).map(
    (n) => n.textContent ?? ""
  );
}

describe("Files page", () => {
  it("lists files with size, written time and time to expiry", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();

    expect(await screen.findByText("statement.csv")).toBeInTheDocument();
    expect(rowOf("statement.csv")).toHaveTextContent("2.0 KB");
    expect(rowOf("statement.csv")).toHaveTextContent("2h ago");
    // The countdown is the point: retention is age only, so people need to see
    // it without hunting for a tooltip.
    expect(screen.getAllByText(/left$/)).toHaveLength(2);
  });

  it("shows a file-type icon tile on each row", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();
    await screen.findByText("statement.csv");
    expect(rowOf("statement.csv").querySelector(".ui-list-row-tile svg")).not.toBeNull();
  });

  it("gives a truncated name its full name as tooltip and accessible name", async () => {
    const long = "bank-statement-export-of-the-whole-year-2026-11-28T10-15-00Z.csv";
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(
      listing({ files: [{ ...listing().files[0], name: long }] }) as never
    );
    renderPage();

    const title = (await screen.findByText(long)).closest("[title]") as HTMLElement;
    expect(title).toHaveAttribute("title", long);
    expect(screen.getByRole("button", { name: `Download ${long}` })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: `Select ${long}` })).toBeInTheDocument();
    // The visible text is shortened but keeps the tail.
    const visible = title.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(visible.textContent!.length).toBeLessThan(long.length);
    expect(visible.textContent!.endsWith("10-15-00Z.csv")).toBe(true);
  });

  it("states the retention rule and the quota in the header", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();

    expect(await screen.findByText(/deleted 24h after they are written/)).toBeInTheDocument();
  });

  it("shows skeleton rows while loading", () => {
    vi.mocked(fetchWorkspaceFiles).mockReturnValue(new Promise(() => {}) as never);
    renderPage();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("explains what the workspace is for when it is empty", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(
      listing({ files: [], usedBytes: 0 }) as never
    );
    renderPage();

    expect(await screen.findByText(/Browser downloads land in this workspace/)).toBeInTheDocument();
  });

  it("has Upload as the primary action in the header band", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();
    await screen.findByText("statement.csv");
    const band = document.querySelector(".ui-box-head") as HTMLElement;
    expect(within(band).getByRole("button", { name: "Upload file" })).toBeInTheDocument();
  });

  it("downloads through the API client rather than a plain link", async () => {
    // A top-level navigation cannot carry the portal's Authorization header,
    // so an <a href> to /api/files would 401. The click has to go through fetch.
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();

    await screen.findByText("statement.csv");
    fireEvent.click(screen.getByRole("button", { name: "Download statement.csv" }));

    await waitFor(() => expect(downloadWorkspaceFile).toHaveBeenCalledWith("statement.csv"));
  });

  it("surfaces a download failure instead of failing silently", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    vi.mocked(downloadWorkspaceFile).mockRejectedValue(new Error("Download failed"));
    renderPage();

    await screen.findByText("statement.csv");
    fireEvent.click(screen.getByRole("button", { name: "Download statement.csv" }));

    expect(await screen.findByText("Download failed")).toBeInTheDocument();
  });

  it("reports a failed listing", async () => {
    vi.mocked(fetchWorkspaceFiles).mockRejectedValue(new Error("nope"));
    renderPage();

    expect(await screen.findByText(/Couldn't load your files/)).toBeInTheDocument();
  });

  it("keeps Delete reachable by keyboard focus although it is revealed on hover", async () => {
    vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
    renderPage();
    await screen.findByText("statement.csv");

    const del = screen.getByRole("button", { name: "Delete statement.csv" });
    expect(del.closest(".ui-row-actions")).toHaveClass("is-reveal");
    del.focus();
    expect(del).toHaveFocus();
    // Download stays visible, never hover-gated.
    expect(screen.getByRole("button", { name: "Download statement.csv" }).closest(".ui-row-actions")).not.toHaveClass("is-reveal");
  });

  describe("single delete", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows an undo toast with no dialog and sends the delete after the delay", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
      renderPage();
      await screen.findByText("statement.csv");

      fireEvent.click(screen.getByRole("button", { name: "Delete statement.csv" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("statement.csv deleted.")).toBeInTheDocument();
      expect(deleteWorkspaceFile).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(5100);
      });
      await waitFor(() =>
        expect(vi.mocked(deleteWorkspaceFile).mock.calls[0]?.[0]).toBe("statement.csv")
      );
    });

    it("Undo cancels the delete", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
      renderPage();
      await screen.findByText("statement.csv");

      fireEvent.click(screen.getByRole("button", { name: "Delete statement.csv" }));
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });

      expect(deleteWorkspaceFile).not.toHaveBeenCalled();
    });

    it("shows a failed delayed delete as an error", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
      vi.mocked(deleteWorkspaceFile).mockRejectedValue(new Error("Delete failed"));
      renderPage();
      await screen.findByText("statement.csv");

      fireEvent.click(screen.getByRole("button", { name: "Delete statement.csv" }));
      await act(async () => {
        vi.advanceTimersByTime(5100);
      });

      expect(await screen.findByText("Delete failed")).toBeInTheDocument();
    });
  });

  describe("selection and bulk actions", () => {
    it("shows the bulk bar in the header band once something is selected", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
      renderPage();
      await screen.findByText("statement.csv");

      expect(screen.queryByRole("button", { name: "Delete selected" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("checkbox", { name: "Select statement.csv" }));

      const band = document.querySelector(".ui-box-head") as HTMLElement;
      expect(within(band).getByText("1 selected")).toBeInTheDocument();
      expect(within(band).getByRole("button", { name: "Delete selected" })).toBeInTheDocument();
      expect(within(band).getByRole("button", { name: "Download selected" })).toBeInTheDocument();
      fireEvent.click(within(band).getByRole("button", { name: "Clear" }));
      expect(screen.queryByRole("button", { name: "Delete selected" })).not.toBeInTheDocument();
    });

    it("asks for confirmation naming the count before bulk delete", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
      renderPage();
      await screen.findByText("statement.csv");
      fireEvent.click(screen.getByRole("checkbox", { name: "Select statement.csv" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select nearly-gone.csv" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Delete 2 files?");
      expect(deleteWorkspaceFile).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(deleteWorkspaceFile).not.toHaveBeenCalled();
    });

    it("deletes sequentially on confirm and clears the selection", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
      renderPage();
      await screen.findByText("statement.csv");
      fireEvent.click(screen.getByRole("checkbox", { name: "Select statement.csv" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select nearly-gone.csv" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete 2 files" }));

      await waitFor(() => expect(deleteWorkspaceFile).toHaveBeenCalledTimes(2));
      expect(vi.mocked(deleteWorkspaceFile).mock.calls.map((c) => c[0])).toEqual([
        "statement.csv",
        "nearly-gone.csv",
      ]);
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Delete selected" })).not.toBeInTheDocument()
      );
    });

    it("reports failures and keeps only the failed files selected", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
      vi.mocked(deleteWorkspaceFile).mockImplementation(async (name: string) => {
        if (name === "nearly-gone.csv") throw new Error("boom");
      });
      renderPage();
      await screen.findByText("statement.csv");
      fireEvent.click(screen.getByRole("checkbox", { name: "Select statement.csv" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select nearly-gone.csv" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete 2 files" }));

      expect(await screen.findByText(/Could not delete 1 of 2 files/)).toBeInTheDocument();
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    });

    it("downloads every selected file", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(listing() as never);
      vi.mocked(downloadWorkspaceFile).mockResolvedValue(undefined);
      renderPage();
      await screen.findByText("statement.csv");
      fireEvent.click(screen.getByRole("checkbox", { name: "Select statement.csv" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select nearly-gone.csv" }));
      fireEvent.click(screen.getByRole("button", { name: "Download selected" }));

      await waitFor(() => expect(downloadWorkspaceFile).toHaveBeenCalledTimes(2));
    });
  });

  describe("sort and filter", () => {
    it("hides sort and filter at 15 files or fewer", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(manyFiles(15) as never);
      renderPage();
      await screen.findByText("file-00.csv");
      expect(screen.queryByLabelText("Sort files")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Filter files")).not.toBeInTheDocument();
    });

    it("shows sort and filter above 15 files", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(manyFiles(16) as never);
      renderPage();
      await screen.findByText("file-00.csv");
      expect(screen.getByLabelText("Sort files")).toBeInTheDocument();
      expect(screen.getByLabelText("Filter files")).toBeInTheDocument();
    });

    it("sorts newest first, by size, and by soonest expiry", async () => {
      const data = manyFiles(16);
      // Present them shuffled so the page has to sort.
      data.files = [...data.files].reverse();
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(data as never);
      renderPage();
      await screen.findByText("file-00.csv");

      expect(rowNames()[0]).toBe("file-00.csv"); // newest

      fireEvent.change(screen.getByLabelText("Sort files"), { target: { value: "size" } });
      expect(rowNames()[0]).toBe("file-15.csv"); // largest

      fireEvent.change(screen.getByLabelText("Sort files"), { target: { value: "expiring" } });
      const expected = [...data.files]
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
        .map((f) => f.name);
      expect(rowNames()).toEqual(expected);
    });

    it("filters by name", async () => {
      vi.mocked(fetchWorkspaceFiles).mockResolvedValue(manyFiles(16) as never);
      renderPage();
      await screen.findByText("file-00.csv");

      fireEvent.change(screen.getByLabelText("Filter files"), { target: { value: "file-07" } });
      expect(rowNames()).toEqual(["file-07.csv"]);
    });
  });
});
