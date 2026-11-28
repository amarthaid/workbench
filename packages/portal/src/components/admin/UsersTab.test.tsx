import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import UsersTab from "./UsersTab";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => {
  const hit = css.split("}").find((b) => b.split("{")[0].split(",").map((x) => x.trim()).includes(selector));
  return hit ? hit.slice(hit.indexOf("{") + 1) : "";
};

const api = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn(),
  disableAdminUser: vi.fn(),
  enableAdminUser: vi.fn(),
  revokeAdminUserKey: vi.fn(),
  getUserPermissions: vi.fn(),
  setUserPermission: vi.fn(),
  clearUserPermission: vi.fn(),
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
  api.setUserPermission.mockResolvedValue(undefined);
  api.clearUserPermission.mockResolvedValue(undefined);
  api.getUserPermissions.mockResolvedValue(perms());
});

function perm(over: Record<string, unknown> = {}) {
  return {
    capability: "spaces.delegate_access",
    label: "Delegate access in Spaces",
    description: "Lets this user share Spaces that run with their connected apps.",
    default: "deny",
    effect: "deny",
    source: "default",
    grantedBy: null,
    grantedByEmail: null,
    grantedAt: null,
    ...over,
  };
}

function perms(over: Record<string, unknown> = {}, delegatedSpaces = 0) {
  return { permissions: [perm(over)], delegatedSpaces };
}

const GRANTED = {
  effect: "allow",
  source: "rule",
  grantedBy: "me",
  grantedByEmail: "admin@example.com",
  grantedAt: Math.floor(new Date(new Date().getFullYear(), 10, 26, 12).getTime() / 1000),
};

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

describe("UsersTab permissions", () => {
  async function openPanel() {
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    const toggle = screen.getByRole("button", { name: "Permissions for dev@example.com" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    return screen.findByRole("group", { name: "Delegate access in Spaces for dev@example.com" });
  }

  it("expands a panel per user with each capability at its default", async () => {
    const group = await openPanel();
    expect(api.getUserPermissions).toHaveBeenCalledWith("u1");
    const row = group.closest(".wb-perm-row") as HTMLElement;
    expect(row).toHaveTextContent("Delegate access in Spaces");
    expect(row).toHaveTextContent("Lets this user share Spaces that run with their connected apps.");
    expect(row).toHaveTextContent("Default: off");
    expect(within(group).getByRole("button", { name: "Default" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Allow" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Default follows the instance setting")).toBeInTheDocument();
  });

  it("lists the custom apps capability next to delegation, Default off, and sets Allow without the delegate confirm", async () => {
    api.getUserPermissions.mockResolvedValue({
      permissions: [
        perm(),
        perm({
          capability: "custom_apps.create",
          label: "Add and use custom apps",
          description: "Lets this user connect their own MCP servers as custom apps.",
        }),
      ],
      delegatedSpaces: 2,
    });
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Permissions for dev@example.com" }));
    const group = await screen.findByRole("group", { name: "Add and use custom apps for dev@example.com" });
    const row = group.closest(".wb-perm-row") as HTMLElement;
    expect(row).toHaveTextContent("Lets this user connect their own MCP servers as custom apps.");
    expect(row).toHaveTextContent("Default: off");
    expect(within(group).getByRole("button", { name: "Default" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Delegate access in Spaces for dev@example.com" })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(api.setUserPermission).toHaveBeenCalledWith("u1", "custom_apps.create", "allow"));
  });

  it("resetting custom apps to Default never shows the delegated Spaces warning", async () => {
    api.getUserPermissions.mockResolvedValue({
      permissions: [
        perm(),
        perm({ capability: "custom_apps.create", label: "Add and use custom apps", description: "x", ...GRANTED }),
      ],
      delegatedSpaces: 3,
    });
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Permissions for dev@example.com" }));
    const group = await screen.findByRole("group", { name: "Add and use custom apps for dev@example.com" });
    fireEvent.click(within(group).getByRole("button", { name: "Default" }));
    await waitFor(() => expect(api.clearUserPermission).toHaveBeenCalledWith("u1", "custom_apps.create"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("collapses again", async () => {
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Permissions for dev@example.com" }));
    expect(screen.queryByRole("group", { name: /Delegate access/ })).not.toBeInTheDocument();
  });

  it("Allow sets the opposite of the default and refreshes the panel", async () => {
    const group = await openPanel();
    api.getUserPermissions.mockResolvedValue(perms(GRANTED));
    fireEvent.click(within(group).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(api.setUserPermission).toHaveBeenCalledWith("u1", "spaces.delegate_access", "allow"));
    expect(await screen.findByText(/Granted by admin@example.com, 26 Nov/)).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Allow" })).toHaveAttribute("aria-pressed", "true");
  });

  it("Default with no delegated Spaces clears the rule without asking", async () => {
    api.getUserPermissions.mockResolvedValue(perms(GRANTED, 0));
    const group = await openPanel();
    fireEvent.click(within(group).getByRole("button", { name: "Default" }));
    await waitFor(() => expect(api.clearUserPermission).toHaveBeenCalledWith("u1", "spaces.delegate_access"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Default with delegated Spaces asks first; Cancel keeps the grant", async () => {
    api.getUserPermissions.mockResolvedValue(perms(GRANTED, 2));
    const group = await openPanel();
    fireEvent.click(within(group).getByRole("button", { name: "Default" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Remove permission" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "dev@example.com has 2 Spaces using delegated access. They will stop working for viewers until it is allowed again."
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.clearUserPermission).not.toHaveBeenCalled();
  });

  it("Set to Default in the confirmation clears the rule", async () => {
    api.getUserPermissions.mockResolvedValue(perms(GRANTED, 1));
    const group = await openPanel();
    fireEvent.click(within(group).getByRole("button", { name: "Default" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("has 1 Space using delegated access");
    fireEvent.click(within(dialog).getByRole("button", { name: "Set to Default" }));
    await waitFor(() => expect(api.clearUserPermission).toHaveBeenCalledWith("u1", "spaces.delegate_access"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the server's reason when a change is refused", async () => {
    api.setUserPermission.mockRejectedValueOnce(new Error("That user no longer exists."));
    const group = await openPanel();
    fireEvent.click(within(group).getByRole("button", { name: "Allow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That user no longer exists.");
  });

  it("says so when the permissions cannot be loaded", async () => {
    api.getUserPermissions.mockRejectedValue(new Error("boom"));
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Permissions for dev@example.com" }));
    expect(await screen.findByText("Couldn't load permissions.")).toBeInTheDocument();
  });

  describe("pending sign-ups", () => {
    const pendingUser = (over: Record<string, unknown> = {}) =>
      user({ id: "p1", email: "new@example.com", status: "pending", has_api_key: false, last_activity: null, ...over });

    beforeEach(() => {
      api.fetchAdminUsers.mockResolvedValue({
        users: [user({ status: "active" }), pendingUser(), user({ id: "u3", email: "off@example.com", status: "disabled", disabled_at: NOW - 5 })],
        total: 3,
      });
    });

    it("hides pending users by default and shows how many wait on the filter chip", async () => {
      renderWithClient(<UsersTab />);
      expect(await screen.findByText("dev@example.com")).toBeInTheDocument();
      expect(screen.queryByText("new@example.com")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Pending (1)" })).toBeInTheDocument();
      expect(screen.getByText("off@example.com")).toBeInTheDocument();
    });

    it("shows pending users with a Pending badge and an Approve action, not Enable", async () => {
      renderWithClient(<UsersTab />);
      fireEvent.click(await screen.findByRole("button", { name: "Pending (1)" }));
      const row = (await screen.findByText("new@example.com")).closest("tr")!;
      expect(within(row).getByText("Pending")).toBeInTheDocument();
      expect(within(row).queryByText("Enable")).not.toBeInTheDocument();
      expect(screen.queryByText("dev@example.com")).not.toBeInTheDocument();
      fireEvent.click(within(row).getByRole("button", { name: "Approve new@example.com" }));
      await waitFor(() => expect(api.enableAdminUser).toHaveBeenCalledWith("p1"));
    });

    it("keeps Disable on a pending row as the permanent no", async () => {
      renderWithClient(<UsersTab />);
      fireEvent.click(await screen.findByRole("button", { name: "Pending (1)" }));
      const row = (await screen.findByText("new@example.com")).closest("tr")!;
      fireEvent.click(within(row).getByRole("button", { name: "Disable new@example.com" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disable" }));
      await waitFor(() => expect(api.disableAdminUser).toHaveBeenCalledWith("p1"));
    });

    it("labels the action Enable for a disabled user", async () => {
      renderWithClient(<UsersTab />);
      const row = (await screen.findByText("off@example.com")).closest("tr")!;
      expect(within(row).getByText("Disabled")).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Enable off@example.com" })).toHaveTextContent("Enable");
    });

    it("shows everyone under All", async () => {
      renderWithClient(<UsersTab />);
      fireEvent.click(await screen.findByRole("button", { name: "All" }));
      expect(await screen.findByText("new@example.com")).toBeInTheDocument();
      expect(screen.getByText("dev@example.com")).toBeInTheDocument();
    });

    it("treats a row without status as active or disabled by disabled_at", async () => {
      api.fetchAdminUsers.mockResolvedValue({ users: [user(), user({ id: "u3", email: "off@example.com", disabled_at: NOW - 5 })], total: 2 });
      renderWithClient(<UsersTab />);
      expect(await screen.findByText("dev@example.com")).toBeInTheDocument();
      expect(screen.getByText("off@example.com")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Pending (0)" })).toBeInTheDocument();
    });
  });

  it("uses the red-text row action for Revoke key and Disable, and a plain one for the rest", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    for (const name of ["Revoke key for dev@example.com", "Disable dev@example.com"]) {
      const b = screen.getByRole("button", { name });
      expect(b).toHaveClass("ui-row-action", "ui-row-action-danger");
      expect(b).not.toHaveClass("ui-button-danger");
    }
    expect(screen.getByRole("button", { name: "Permissions for dev@example.com" })).toHaveClass("ui-row-action");
  });

  it("keeps the dates on one line and lets the actions wrap inside the card", async () => {
    renderWithClient(<UsersTab />);
    await screen.findByText("dev@example.com");
    const row = screen.getByText("dev@example.com").closest("tr")!;
    const joined = row.querySelectorAll("td")[1];
    const last = row.querySelectorAll("td")[2];
    expect(joined).toHaveClass("wb-col-date");
    expect(last).toHaveClass("wb-col-date");
    expect(rule(".wb-col-date")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".wb-col-date")).toMatch(/width:\s*\d+/);
    const actions = screen.getByRole("button", { name: "Disable dev@example.com" }).parentElement!;
    expect(actions).toHaveClass("wb-user-actions");
    expect(rule(".wb-user-actions")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".wb-user-actions")).not.toMatch(/(?<![-\w])width:\s*\d+px/);
  });
});
