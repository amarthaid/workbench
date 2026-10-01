import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import UsersTab from "./UsersTab";

const api = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn(),
  disableAdminUser: vi.fn(),
  enableAdminUser: vi.fn(),
  revokeAdminUserKey: vi.fn(),
}));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", email: "admin@example.com", isAdmin: true }, isLoading: false }),
}));

const NOW = Math.floor(Date.now() / 1000);

function user(over: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "dev@example.com",
    created_at: NOW - 86400,
    disabled_at: null,
    has_api_key: true,
    connection_count: 2,
    custom_app_count: 1,
    last_activity: NOW - 120,
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminUsers.mockResolvedValue({ users: [user()], total: 1 });
  api.disableAdminUser.mockResolvedValue(undefined);
  api.enableAdminUser.mockResolvedValue(undefined);
  api.revokeAdminUserKey.mockResolvedValue(undefined);
});

describe("UsersTab", () => {
  it("lists users with counts, key state and status", async () => {
    api.fetchAdminUsers.mockResolvedValue({
      users: [user(), user({ id: "u2", email: "off@example.com", disabled_at: NOW - 5, has_api_key: false, last_activity: null })],
      total: 2,
    });
    renderWithClient(<UsersTab />);
    const dev = (await screen.findByText("dev@example.com")).closest("tr")!;
    expect(dev).toHaveTextContent("Active");
    expect(dev).toHaveTextContent("2");
    const off = screen.getByText("off@example.com").closest("tr")!;
    expect(off).toHaveTextContent("Disabled");
    expect(off).toHaveTextContent("—");
  });

  it("shows empty and error states", async () => {
    api.fetchAdminUsers.mockResolvedValueOnce({ users: [], total: 0 });
    const { unmount } = renderWithClient(<UsersTab />);
    expect(await screen.findByText("No users yet.")).toBeInTheDocument();
    unmount();
    api.fetchAdminUsers.mockRejectedValue(new Error("boom"));
    renderWithClient(<UsersTab />);
    expect(await screen.findByText("Couldn't load users.")).toBeInTheDocument();
  });

  it("disabling asks for confirmation first, then calls the API and refreshes", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Disable dev@example.com" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/signed out/i)).toBeInTheDocument();
    expect(api.disableAdminUser).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.disableAdminUser).toHaveBeenCalledWith("u1"));
    await waitFor(() => expect(api.fetchAdminUsers).toHaveBeenCalledTimes(2));
  });

  it("cancelling the confirmation does nothing", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Disable dev@example.com" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.disableAdminUser).not.toHaveBeenCalled();
  });

  it("enabling a disabled user needs no confirmation", async () => {
    api.fetchAdminUsers.mockResolvedValue({ users: [user({ disabled_at: NOW - 5 })], total: 1 });
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Enable dev@example.com" }));
    await waitFor(() => expect(api.enableAdminUser).toHaveBeenCalledWith("u1"));
  });

  it("revoking a key asks for confirmation, and is offered only when the user has a key", async () => {
    api.fetchAdminUsers.mockResolvedValue({
      users: [user(), user({ id: "u2", email: "nokey@example.com", has_api_key: false })],
      total: 2,
    });
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    expect(screen.queryByRole("button", { name: "Revoke key for nokey@example.com" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke key for dev@example.com" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));
    await waitFor(() => expect(api.revokeAdminUserKey).toHaveBeenCalledWith("u1"));
  });

  it("offers no Disable button on your own row", async () => {
    api.fetchAdminUsers.mockResolvedValue({ users: [user({ id: "me", email: "admin@example.com" })], total: 1 });
    renderWithClient(<UsersTab />);
    await screen.findByText("admin@example.com");
    expect(screen.queryByRole("button", { name: "Disable admin@example.com" })).not.toBeInTheDocument();
  });

  it("shows the server's reason when an action is refused", async () => {
    api.disableAdminUser.mockRejectedValueOnce(new Error("Admins named in ADMIN_EMAILS can't be disabled here."));
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Disable dev@example.com" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("can't be disabled here");
  });
});

describe("UsersTab search", () => {
  const MANY = [
    user({ id: "u1", email: "alice@example.com" }),
    user({ id: "u2", email: "Bob.Builder@example.com" }),
    user({ id: "u3", email: "carol@corp.example.org" }),
    user({ id: "u4", email: null }),
  ];

  beforeEach(() => {
    api.fetchAdminUsers.mockResolvedValue({ users: MANY, total: 4 });
  });

  const search = (value: string) =>
    fireEvent.change(screen.getByLabelText("Search users by email"), { target: { value } });

  it("filters the list by email as you type, ignoring case", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("alice@example.com");
    search("BOB");
    expect(screen.getByText("Bob.Builder@example.com")).toBeInTheDocument();
    expect(screen.queryByText("alice@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("carol@corp.example.org")).not.toBeInTheDocument();
  });

  it("matches anywhere in the address, and ignores surrounding spaces", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("alice@example.com");
    search("  corp.example ");
    expect(screen.getByText("carol@corp.example.org")).toBeInTheDocument();
    expect(screen.queryByText("alice@example.com")).not.toBeInTheDocument();
  });

  it("says how many match, and restores the full list when cleared", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("alice@example.com");
    search("example.com");
    expect(screen.getByText("Showing 2 of 4 users.")).toBeInTheDocument();
    search("");
    expect(screen.queryByText(/Showing \d+ of/)).not.toBeInTheDocument();
    expect(screen.getByText("carol@corp.example.org")).toBeInTheDocument();
  });

  it("explains when nothing matches, instead of showing an empty table", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("alice@example.com");
    search("nobody-here");
    expect(screen.getByText('No users match "nobody-here".')).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps acting on the right user while a filter is applied", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("alice@example.com");
    search("carol");
    fireEvent.click(screen.getByRole("button", { name: "Disable carol@corp.example.org" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.disableAdminUser).toHaveBeenCalledWith("u3"));
  });

  it("is honest when the server list was cut off, since search only covers what was loaded", async () => {
    api.fetchAdminUsers.mockResolvedValue({ users: MANY, total: 900 });
    renderWithClient(<UsersTab />);
    await screen.findByText("alice@example.com");
    expect(screen.getByText(/Loaded the first 4 of 900 users/)).toBeInTheDocument();
  });
});
