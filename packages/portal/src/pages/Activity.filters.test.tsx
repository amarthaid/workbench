import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import Activity from "./Activity";

vi.mock("../spaces-api", () => ({
  fetchSpaces: vi.fn(async () => [{ name: "sprint-board", title: "Sprint Board" }]),
}));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  fetchIntegrations: vi.fn(async () => ({ integrations: [{ name: "acme", displayName: "Acme", version: "1", toolCount: 1 }] })),
}));

const NOW = Math.floor(Date.now() / 1000);
const EVENT = { id: 1, integration: "acme", tool: "acme_search", action: "EXECUTE", success: true, error: null, duration_ms: 5, created_at: NOW };

const fetchMock = vi.fn();
const activityUrls = () =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/activity") && !u.includes("/people"));
const peopleUrls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/activity/people"));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const body = String(url).includes("/people")
      ? { stored: true, people: [{ email: "qa@example.com", count: 2 }] }
      : { stored: true, events: [EVENT], next_cursor: null };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const query = (u: string) => new URL(u, "http://x").searchParams;

describe("Activity filters", () => {
  it("fetches with a since window on first load", async () => {
    renderWithClient(<Activity />);
    await screen.findByText("acme_search");
    expect(activityUrls()).toHaveLength(1);
    expect(query(activityUrls()[0]).get("since")).toMatch(/^\d+$/);
  });

  it("refetches once on Apply with since, delegated, space and person", async () => {
    renderWithClient(<Activity />);
    await screen.findByText("acme_search");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));

    const space = screen.getByRole("combobox", { name: "Space" });
    fireEvent.focus(space);
    fireEvent.change(space, { target: { value: "sprint" } });
    fireEvent.keyDown(space, { key: "Enter" });

    const person = screen.getByRole("combobox", { name: "Person" });
    fireEvent.focus(person);
    await screen.findByText("qa@example.com");
    fireEvent.keyDown(person, { key: "ArrowDown" });
    fireEvent.keyDown(person, { key: "Enter" });

    expect(activityUrls()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(activityUrls()).toHaveLength(2));
    const q = query(activityUrls()[1]);
    expect(q.get("space")).toBe("sprint-board");
    expect(q.get("person")).toBe("qa@example.com");
    expect(q.get("delegated")).toBe("1");
    expect(q.get("since")).toMatch(/^\d+$/);
    await new Promise((r) => setTimeout(r, 50));
    expect(activityUrls()).toHaveLength(2);
  });

  it("makes no activity request while typing in the Space or Person box", async () => {
    renderWithClient(<Activity />);
    await screen.findByText("acme_search");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const before = activityUrls().length;

    const space = screen.getByRole("combobox", { name: "Space" });
    fireEvent.focus(space);
    for (const v of ["s", "sp", "spr"]) fireEvent.change(space, { target: { value: v } });
    const person = screen.getByRole("combobox", { name: "Person" });
    fireEvent.focus(person);
    await waitFor(() => expect(peopleUrls()).toHaveLength(1));
    for (const v of ["q", "qa"]) fireEvent.change(person, { target: { value: v } });

    await new Promise((r) => setTimeout(r, 400));
    expect(activityUrls()).toHaveLength(before);
    expect(peopleUrls()).toHaveLength(1);
  });
});
