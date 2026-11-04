import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import ConfigTab from "./ConfigTab";

const api = vi.hoisted(() => ({
  fetchAdminConfig: vi.fn(),
  fetchAdminUsers: vi.fn(),
  setAdminIntegrationEnabled: vi.fn(),
  setAdminCustomAppsPolicy: vi.fn(),
  setAdminBrowserBlockedDomains: vi.fn(),
}));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));

const CONFIG = {
  integrations: [
    { name: "acme", display_name: "Acme", enabled: true },
    { name: "demo-repo", display_name: "Demo Repo", enabled: false },
  ],
  custom_apps_policy: { mode: "all" as const, user_ids: [] as string[] },
  browser_blocked_domains: ["blocked.example"],
  browser_allowed_domains: [] as string[],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminConfig.mockResolvedValue(CONFIG);
  api.fetchAdminUsers.mockResolvedValue({
    users: [
      { id: "u1", email: "dev@example.com" },
      { id: "u2", email: "other@example.com" },
    ],
    total: 2,
  });
  api.setAdminIntegrationEnabled.mockResolvedValue(undefined);
  api.setAdminCustomAppsPolicy.mockResolvedValue(undefined);
  api.setAdminBrowserBlockedDomains.mockResolvedValue(undefined);
});

describe("ConfigTab integrations", () => {
  it("lists each integration with its state", async () => {
    renderWithClient(<ConfigTab />);
    const acme = (await screen.findByText("Acme")).closest("tr")!;
    expect(acme).toHaveTextContent("Enabled");
    expect(screen.getByText("Demo Repo").closest("tr")).toHaveTextContent("Disabled");
  });

  it("disabling asks for confirmation, then saves and refreshes", async () => {
    renderWithClient(<ConfigTab />);
    await screen.findByText("Acme");
    fireEvent.click(screen.getByRole("button", { name: "Disable Acme" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/every user/i)).toBeInTheDocument();
    expect(api.setAdminIntegrationEnabled).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.setAdminIntegrationEnabled).toHaveBeenCalledWith("acme", false));
    await waitFor(() => expect(api.fetchAdminConfig).toHaveBeenCalledTimes(2));
  });

  it("enabling needs no confirmation", async () => {
    renderWithClient(<ConfigTab />);
    await screen.findByText("Demo Repo");
    fireEvent.click(screen.getByRole("button", { name: "Enable Demo Repo" }));
    await waitFor(() => expect(api.setAdminIntegrationEnabled).toHaveBeenCalledWith("demo-repo", true));
  });

  it("shows the server's reason when a change is refused", async () => {
    api.setAdminIntegrationEnabled.mockRejectedValueOnce(new Error("That integration is not registered."));
    renderWithClient(<ConfigTab />);
    await screen.findByText("Demo Repo");
    fireEvent.click(screen.getByRole("button", { name: "Enable Demo Repo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not registered");
  });

  it("shows an error state when the config cannot be loaded", async () => {
    api.fetchAdminConfig.mockRejectedValue(new Error("boom"));
    renderWithClient(<ConfigTab />);
    expect(await screen.findByText("Couldn't load config.")).toBeInTheDocument();
  });
});

describe("ConfigTab custom-app policy", () => {
  it("shows the current mode and keeps Save disabled until something changes", async () => {
    renderWithClient(<ConfigTab />);
    const select = await screen.findByLabelText("Who can add custom apps");
    expect(select).toHaveValue("all");
    expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
  });

  it("saves a new mode", async () => {
    renderWithClient(<ConfigTab />);
    fireEvent.change(await screen.findByLabelText("Who can add custom apps"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(api.setAdminCustomAppsPolicy).toHaveBeenCalledWith({ mode: "none", user_ids: [] }));
  });

  it("an allowlist offers the users and saves the ticked ones", async () => {
    renderWithClient(<ConfigTab />);
    fireEvent.change(await screen.findByLabelText("Who can add custom apps"), { target: { value: "allowlist" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "dev@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() =>
      expect(api.setAdminCustomAppsPolicy).toHaveBeenCalledWith({ mode: "allowlist", user_ids: ["u1"] })
    );
  });

  it("does not offer the user list unless the mode is allowlist", async () => {
    renderWithClient(<ConfigTab />);
    await screen.findByLabelText("Who can add custom apps");
    expect(screen.queryByRole("checkbox", { name: "dev@example.com" })).not.toBeInTheDocument();
  });

  it("keeps an unsaved allowlist selection when the config is refetched", async () => {
    // A fresh object on every call, as a real refetch returns.
    api.fetchAdminConfig.mockImplementation(async () => JSON.parse(JSON.stringify(CONFIG)));
    renderWithClient(<ConfigTab />);
    fireEvent.change(await screen.findByLabelText("Who can add custom apps"), { target: { value: "allowlist" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "dev@example.com" }));

    // Toggling an integration refetches the config.
    fireEvent.click(screen.getByRole("button", { name: "Enable Demo Repo" }));
    await waitFor(() => expect(api.fetchAdminConfig).toHaveBeenCalledTimes(2));
    // Let the refetched data reach the component before asserting.
    await new Promise((r) => setTimeout(r, 50));

    expect(screen.getByLabelText("Who can add custom apps")).toHaveValue("allowlist");
    expect(screen.getByRole("checkbox", { name: "dev@example.com" })).toBeChecked();
  });

  it("shows the server's reason when the policy is refused", async () => {
    api.setAdminCustomAppsPolicy.mockRejectedValueOnce(new Error("One of the selected users no longer exists."));
    renderWithClient(<ConfigTab />);
    fireEvent.change(await screen.findByLabelText("Who can add custom apps"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer exists");
  });
});

describe("ConfigTab browser blocklist", () => {
  it("shows the current list and saves the edited one, split on lines, spaces and commas", async () => {
    renderWithClient(<ConfigTab />);
    const box = (await screen.findByLabelText(/agent browser tabs may not load/i)) as HTMLTextAreaElement;
    expect(box.value).toBe("blocked.example");
    const save = screen.getByRole("button", { name: "Save blocklist" });
    expect(save).toBeDisabled();
    fireEvent.change(box, { target: { value: "blocked.example\nads.example, ads.example  other.example" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.setAdminBrowserBlockedDomains).toHaveBeenCalledWith(["blocked.example", "ads.example", "other.example"], [])
    );
  });

  it("saves allow exceptions alongside the blocklist", async () => {
    renderWithClient(<ConfigTab />);
    const block = await screen.findByLabelText(/agent browser tabs may not load/i);
    const allow = screen.getByLabelText(/Exceptions/i);
    fireEvent.change(block, { target: { value: "*.prod.example.com" } });
    fireEvent.change(allow, { target: { value: "x.prod.example.com\nz.prod.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save blocklist" }));
    await waitFor(() =>
      expect(api.setAdminBrowserBlockedDomains).toHaveBeenCalledWith(
        ["*.prod.example.com"],
        ["x.prod.example.com", "z.prod.example.com"]
      )
    );
  });

  it("shows the stored exceptions, and editing only them enables Save", async () => {
    api.fetchAdminConfig.mockResolvedValue({ ...CONFIG, browser_allowed_domains: ["x.prod.example.com"] });
    renderWithClient(<ConfigTab />);
    const allow = (await screen.findByLabelText(/Exceptions/i)) as HTMLTextAreaElement;
    expect(allow.value).toBe("x.prod.example.com");
    const save = screen.getByRole("button", { name: "Save blocklist" });
    expect(save).toBeDisabled();
    fireEvent.change(allow, { target: { value: "" } });
    expect(save).toBeEnabled();
  });

  it("shows the server's reason when an entry is refused", async () => {
    api.setAdminBrowserBlockedDomains.mockRejectedValueOnce(new Error("Some entries are not valid domains: com"));
    renderWithClient(<ConfigTab />);
    const box = await screen.findByLabelText(/agent browser tabs may not load/i);
    fireEvent.change(box, { target: { value: "com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save blocklist" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not valid domains: com");
  });
});
