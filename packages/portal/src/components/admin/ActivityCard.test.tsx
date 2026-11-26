import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ActivityCard from "./ActivityCard";

const api = vi.hoisted(() => ({
  fetchAdminActivity: vi.fn(),
  fetchIntegrations: vi.fn(),
  fetchAdminActivityPayload: vi.fn(),
  fetchAdminUsers: vi.fn(),
}));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));
const spaces = vi.hoisted(() => ({ searchAdminSpaces: vi.fn() }));
vi.mock("../../admin-spaces-api", () => spaces);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openFilters() {
  fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  return screen.getByRole("dialog", { name: "Filters" });
}

function lastCall() {
  return api.fetchAdminActivity.mock.calls[api.fetchAdminActivity.mock.calls.length - 1][0];
}

const NOW = Math.floor(Date.now() / 1000);

function ev(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: "u1",
    user_email: "dev@example.com",
    integration: "acme",
    tool: `tool_${id}`,
    action: "EXECUTE",
    success: true,
    error: null,
    duration_ms: 120,
    created_at: NOW,
    ...over,
  };
}

beforeEach(() => {
  api.fetchAdminActivity.mockReset();
  api.fetchIntegrations.mockReset();
  api.fetchAdminActivityPayload.mockReset();
  api.fetchAdminUsers.mockReset();
  spaces.searchAdminSpaces.mockReset();
  api.fetchAdminUsers.mockResolvedValue({
    total: 1,
    users: [{ id: "u1", email: "dev@example.com", disabled_at: null, last_activity: NOW }],
  });
  spaces.searchAdminSpaces.mockResolvedValue({
    spaces: [{ name: "release-desk", title: "Release desk", owner_email: "dev@example.com" }],
    has_more: false,
  });
  api.fetchIntegrations.mockResolvedValue({ integrations: [{ name: "acme", displayName: "Acme" }] });
});

describe("ActivityCard", () => {
  it("shows each event with the user's email and the app's display name", async () => {
    api.fetchAdminActivity.mockResolvedValue({
      stored: true,
      events: [ev(1, { tool: "acme_search" }), ev(2, { user_email: null, tool: "orphan_tool" })],
      next_cursor: null,
    });
    renderWithClient(<ActivityCard />);
    const row = (await screen.findByText("acme_search")).closest("tr")!;
    expect(row).toHaveTextContent("dev@example.com");
    expect(row).toHaveTextContent("Acme");
    expect(screen.getByText("orphan_tool").closest("tr")).toHaveTextContent("—");
  });

  it("says events are not stored, rather than that nothing ran", async () => {
    api.fetchAdminActivity.mockResolvedValue({ stored: false, events: [], next_cursor: null });
    renderWithClient(<ActivityCard />);
    expect(await screen.findByText(/somewhere other than its database/i)).toBeInTheDocument();
    expect(screen.queryByText("No tool calls recorded yet.")).not.toBeInTheDocument();
  });

  it("shows an empty state and an error state", async () => {
    api.fetchAdminActivity.mockResolvedValueOnce({ stored: true, events: [], next_cursor: null });
    const { unmount } = renderWithClient(<ActivityCard />);
    expect(await screen.findByText("No tool calls recorded yet.")).toBeInTheDocument();
    unmount();
    api.fetchAdminActivity.mockRejectedValueOnce(new Error("boom"));
    renderWithClient(<ActivityCard />);
    expect(await screen.findByText("Couldn't load activity.")).toBeInTheDocument();
  });

  it("the Errors tab refetches with status=error", async () => {
    api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [ev(1)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("tab", { name: "Errors" }));
    await waitFor(() =>
      expect(api.fetchAdminActivity).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }))
    );
  });

  it("Load more appends the next page using the cursor", async () => {
    api.fetchAdminActivity
      .mockResolvedValueOnce({ stored: true, events: [ev(1)], next_cursor: "c1" })
      .mockResolvedValueOnce({ stored: true, events: [ev(2)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("tool_2")).toBeInTheDocument();
    expect(screen.getByText("tool_1")).toBeInTheDocument();
    expect(api.fetchAdminActivity).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c1" }));
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("does not show the same event twice when two pages both contain it", async () => {
    api.fetchAdminActivity
      .mockResolvedValueOnce({ stored: true, events: [ev(1)], next_cursor: "c1" })
      .mockResolvedValueOnce({ stored: true, events: [ev(1), ev(2)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("tool_2");
    expect(screen.getAllByText("tool_1")).toHaveLength(1);
  });
});

describe("ActivityCard filters", () => {
  beforeEach(() => {
    api.fetchAdminActivity.mockResolvedValue({ stored: true, events: [ev(1)], next_cursor: null });
  });

  it("applying filters makes exactly one refetch carrying every filter", async () => {
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    const first = api.fetchAdminActivity.mock.calls.length;
    const pop = openFilters();
    fireEvent.change(within(pop).getByLabelText("App"), { target: { value: "acme" } });
    fireEvent.change(within(pop).getByLabelText("Credential"), { target: { value: "oauth" } });
    fireEvent.click(within(pop).getByLabelText("Delegated calls only"));
    const space = within(pop).getByRole("combobox", { name: "Space" });
    fireEvent.focus(space);
    fireEvent.change(space, { target: { value: "release" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /release-desk/ }));
    const user = within(pop).getByRole("combobox", { name: "User" });
    fireEvent.focus(user);
    fireEvent.change(user, { target: { value: "dev@example.com" } });
    fireEvent.keyDown(user, { key: "Enter" });
    // Choosing values only changes the draft.
    await sleep(100);
    expect(api.fetchAdminActivity.mock.calls.length).toBe(first);
    fireEvent.click(within(pop).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.fetchAdminActivity.mock.calls.length).toBe(first + 1));
    await sleep(100);
    expect(api.fetchAdminActivity.mock.calls.length).toBe(first + 1);
    expect(lastCall()).toMatchObject({
      integration: "acme",
      auth: "oauth",
      delegated: true,
      space: "release-desk",
      email: "dev@example.com",
    });
    expect(typeof lastCall().since).toBe("number");
    expect(lastCall().cursor).toBeUndefined();
  });

  it("typing five characters in the User box makes at most one users request and no activity request", async () => {
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    const first = api.fetchAdminActivity.mock.calls.length;
    const pop = openFilters();
    const user = within(pop).getByRole("combobox", { name: "User" });
    fireEvent.focus(user);
    for (let i = 1; i <= 5; i++) fireEvent.change(user, { target: { value: "ana@e".slice(0, i) } });
    await sleep(400);
    expect(api.fetchAdminUsers.mock.calls.length).toBeLessThanOrEqual(1);
    expect(api.fetchAdminActivity.mock.calls.length).toBe(first);
  });

  it("the Space box sends nothing under two characters, then at most one search after the pause", async () => {
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    const first = api.fetchAdminActivity.mock.calls.length;
    const pop = openFilters();
    const space = within(pop).getByRole("combobox", { name: "Space" });
    fireEvent.focus(space);
    fireEvent.change(space, { target: { value: "r" } });
    await sleep(400);
    expect(spaces.searchAdminSpaces).not.toHaveBeenCalled();
    for (let i = 2; i <= 5; i++) fireEvent.change(space, { target: { value: "relea".slice(0, i) } });
    await waitFor(() => expect(spaces.searchAdminSpaces).toHaveBeenCalledTimes(1));
    await sleep(400);
    expect(spaces.searchAdminSpaces).toHaveBeenCalledTimes(1);
    expect(api.fetchAdminActivity.mock.calls.length).toBe(first);
  });

  it("the Errors tab refetches with status=error and paging starts over", async () => {
    api.fetchAdminActivity
      .mockResolvedValueOnce({ stored: true, events: [ev(1)], next_cursor: "c1" })
      .mockResolvedValueOnce({ stored: true, events: [ev(2)], next_cursor: null })
      .mockResolvedValue({ stored: true, events: [ev(3)], next_cursor: null });
    renderWithClient(<ActivityCard />);
    await screen.findByText("tool_1");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("tool_2");
    fireEvent.click(screen.getByRole("tab", { name: "Errors" }));
    await screen.findByText("tool_3");
    expect(lastCall()).toMatchObject({ status: "error" });
    expect(lastCall().cursor).toBeUndefined();
    expect(screen.queryByText("tool_1")).not.toBeInTheDocument();
  });
});

describe("ActivityCard rows and drawer", () => {
  const delegated = ev(1, {
    tool: "shared_tool",
    actor_user_id: "u2",
    actor_email: "ana@example.com",
    client_name: "space:release-desk",
    auth_method: "oauth",
    error: null,
  });

  beforeEach(() => {
    api.fetchAdminActivity.mockResolvedValue({
      stored: true,
      events: [
        delegated,
        ev(2, { tool: "own_space", client_name: "space:release-desk" }),
        ev(3, { tool: "failing", success: false, error: "upstream said no" }),
      ],
      next_cursor: null,
    });
  });

  it("shows Duration, the Run by line, and via Space on own access", async () => {
    renderWithClient(<ActivityCard />);
    const row = (await screen.findByText("shared_tool")).closest("tr")!;
    expect(row).toHaveTextContent("Delegated");
    expect(row).toHaveTextContent("Run by ana@example.com · release-desk");
    expect(row).toHaveTextContent("120ms");
    expect(screen.getByText("own_space").closest("tr")).toHaveTextContent("via Space release-desk");
    expect(screen.getByText("own_space").closest("tr")).not.toHaveTextContent("Delegated");
    expect(screen.getByRole("columnheader", { name: "Duration" })).toBeInTheDocument();
  });

  it("the actor and Space links apply filters without opening the drawer", async () => {
    renderWithClient(<ActivityCard />);
    await screen.findByText("shared_tool");
    const first = api.fetchAdminActivity.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "ana@example.com" }));
    await waitFor(() => expect(lastCall()).toMatchObject({ email: "ana@example.com" }));
    expect(screen.queryByRole("dialog", { name: "Call details" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "release-desk" }));
    await waitFor(() => expect(lastCall()).toMatchObject({ space: "release-desk" }));
    expect(screen.queryByRole("dialog", { name: "Call details" })).not.toBeInTheDocument();
    expect(api.fetchAdminActivity.mock.calls.length).toBeGreaterThan(first);
  });

  it("opens the drawer on a row click and on Enter, with the full error", async () => {
    renderWithClient(<ActivityCard />);
    const row = (await screen.findByText("failing")).closest("tr")!;
    fireEvent.click(row);
    const drawer = await screen.findByRole("dialog", { name: "Call details" });
    expect(drawer).toHaveTextContent("upstream said no");
    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Call details" })).not.toBeInTheDocument());
    const other = screen.getByText("own_space").closest("tr")!;
    fireEvent.keyDown(other, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "Call details" })).toHaveTextContent("own_space");
  });

  it("the drawer names whose access and who ran a delegated call", async () => {
    renderWithClient(<ActivityCard />);
    fireEvent.click((await screen.findByText("shared_tool")).closest("tr")!);
    const drawer = await screen.findByRole("dialog", { name: "Call details" });
    const sec = within(drawer).getByRole("region", { name: "Delegated access" });
    expect(sec).toHaveTextContent("dev@example.com");
    expect(sec).toHaveTextContent("ana@example.com");
  });
});

describe("ActivityCard captured payload", () => {
  beforeEach(() => {
    api.fetchAdminActivity.mockResolvedValue({
      stored: true,
      events: [ev(1, { tool: "with_payload", has_payload: true }), ev(2, { tool: "plain" })],
      next_cursor: null,
    });
    api.fetchAdminActivityPayload.mockResolvedValue({
      audit_id: 1,
      args: '{"q":"hello"}',
      args_truncated: false,
      args_bytes: 13,
      result: '{"body":"abc',
      result_truncated: true,
      result_bytes: 20480,
    });
  });

  it("requests the payload only after Show, then shows args and a truncated result", async () => {
    renderWithClient(<ActivityCard />);
    fireEvent.click((await screen.findByText("with_payload")).closest("tr")!);
    const drawer = await screen.findByRole("dialog", { name: "Call details" });
    expect(drawer).toHaveTextContent("Viewing these is recorded in the audit log under your name");
    await sleep(100);
    expect(api.fetchAdminActivityPayload).not.toHaveBeenCalled();
    fireEvent.click(within(drawer).getByRole("button", { name: "Show" }));
    await waitFor(() => expect(drawer).toHaveTextContent('"q": "hello"'));
    expect(drawer).toHaveTextContent("Truncated: showing the first part of 20.0 KB");
    expect(drawer).toHaveTextContent('{"body":"abc');
    expect(api.fetchAdminActivityPayload).toHaveBeenCalledTimes(1);
    expect(api.fetchAdminActivityPayload).toHaveBeenCalledWith(1);
  });

  it("says Not captured for a call with no payload and offers no Show", async () => {
    renderWithClient(<ActivityCard />);
    fireEvent.click((await screen.findByText("plain")).closest("tr")!);
    const drawer = await screen.findByRole("dialog", { name: "Call details" });
    expect(drawer).toHaveTextContent("Not captured.");
    expect(within(drawer).queryByRole("button", { name: "Show" })).not.toBeInTheDocument();
  });

  it("shows a null side as Not captured", async () => {
    api.fetchAdminActivityPayload.mockResolvedValue({
      audit_id: 1, args: null, args_truncated: false, args_bytes: null,
      result: "ok", result_truncated: false, result_bytes: 2,
    });
    renderWithClient(<ActivityCard />);
    fireEvent.click((await screen.findByText("with_payload")).closest("tr")!);
    const drawer = await screen.findByRole("dialog", { name: "Call details" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Show" }));
    await waitFor(() => expect(drawer).toHaveTextContent("Not captured."));
  });
});

describe("ActivityCard request origin", () => {
  it("shows auth method, OAuth client and IP under the user, with the user agent on hover", async () => {
    api.fetchAdminActivity.mockResolvedValue({
      stored: true,
      events: [
        ev(1, {
          tool: "via_oauth",
          auth_method: "oauth",
          client_name: "Claude Code",
          source_ip: "203.0.113.9",
          user_agent: "claude-code/2.0",
        }),
        ev(2, { tool: "via_key", auth_method: "api_key", source_ip: "198.51.100.1" }),
        ev(3, { tool: "background" }),
      ],
      next_cursor: null,
    });
    renderWithClient(<ActivityCard />);
    const oauthRow = (await screen.findByText("via_oauth")).closest("tr")!;
    const origin = within(oauthRow).getByText(/OAuth: Claude Code · 203\.0\.113\.9/);
    expect(origin).toHaveAttribute("title", "claude-code/2.0");
    expect(screen.getByText("via_key").closest("tr")).toHaveTextContent("API key · 198.51.100.1");
    expect(screen.getByText("background").closest("tr")!.querySelector(".ui-stat-note")).toBeNull();
  });
});
