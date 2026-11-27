import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import { UserEmailCombobox } from "./UserEmailCombobox";

const api = vi.hoisted(() => ({ fetchAdminUsers: vi.fn(), fetchAdminActivity: vi.fn() }));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), ...api }));

const NOW = Math.floor(Date.now() / 1000);
const user = (email: string, over: Record<string, unknown> = {}) => ({
  id: email,
  email,
  created_at: NOW,
  disabled_at: null,
  has_api_key: false,
  connection_count: 0,
  custom_app_count: 0,
  last_activity: NOW - 7200,
  ...over,
});

beforeEach(() => {
  api.fetchAdminUsers.mockReset();
  api.fetchAdminActivity.mockReset();
  api.fetchAdminUsers.mockResolvedValue({
    users: [user("ana@example.com"), user("dev@example.com"), user("former@example.com", { disabled_at: NOW - 100, last_activity: null })],
    total: 3,
  });
});

describe("UserEmailCombobox", () => {
  it("makes one list request and no activity request while typing five characters", async () => {
    renderWithClient(<UserEmailCombobox value="" onChange={() => {}} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    await screen.findAllByRole("option");
    for (const v of ["f", "fo", "for", "form", "forme"]) fireEvent.change(box, { target: { value: v } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("Disabled");
    expect(api.fetchAdminUsers).toHaveBeenCalledTimes(1);
    expect(api.fetchAdminActivity).not.toHaveBeenCalled();
  });

  it("shows last activity and picks with the keyboard", async () => {
    const onChange = vi.fn();
    renderWithClient(<UserEmailCombobox value="" onChange={onChange} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    expect(await screen.findByRole("option", { name: /ana@example.com/ })).toHaveTextContent("last active 2h ago");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("dev@example.com");
  });

  it("accepts a full address that is not in the list with Enter", async () => {
    const onChange = vi.fn();
    renderWithClient(<UserEmailCombobox value="" onChange={onChange} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    await screen.findAllByRole("option");
    fireEvent.change(box, { target: { value: "Gone@Example.com" } });
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("gone@example.com");
  });

  it("does not accept text that is not an address", async () => {
    const onChange = vi.fn();
    renderWithClient(<UserEmailCombobox value="" onChange={onChange} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    await screen.findAllByRole("option");
    fireEvent.change(box, { target: { value: "nobody" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tells the admin when the list is cut at 500", async () => {
    api.fetchAdminUsers.mockResolvedValue({ users: [user("ana@example.com")], total: 812 });
    renderWithClient(<UserEmailCombobox value="" onChange={() => {}} />);
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByText(/first 500 of 812/)).toBeInTheDocument());
  });

  it("marks pending users with a Pending badge", async () => {
    api.fetchAdminUsers.mockResolvedValue({ users: [user("new@example.com", { status: "pending", last_activity: null })], total: 1 });
    renderWithClient(<UserEmailCombobox value="" onChange={() => {}} />);
    fireEvent.focus(screen.getByRole("combobox"));
    expect(await screen.findByRole("option")).toHaveTextContent("Pending");
  });

  it("marks users the server calls disabled even without disabled_at", async () => {
    api.fetchAdminUsers.mockResolvedValue({ users: [user("off@example.com", { status: "disabled" })], total: 1 });
    renderWithClient(<UserEmailCombobox value="" onChange={() => {}} />);
    fireEvent.focus(screen.getByRole("combobox"));
    expect(await screen.findByRole("option")).toHaveTextContent("Disabled");
  });
});
