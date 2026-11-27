import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../../test-utils";
import { shortDate } from "../../format";
import ApprovalsTab from "./ApprovalsTab";

const api = vi.hoisted(() => ({
  fetchAdminApprovals: vi.fn(),
  approveAdminApproval: vi.fn(),
  rejectAdminApproval: vi.fn(),
}));
vi.mock("../../approvals-api", async (orig) => ({ ...(await orig<typeof import("../../approvals-api")>()), ...api }));

const NOW = Math.floor(Date.now() / 1000);
const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: `a${n}`,
  kind: "account.activate" as const,
  requester_email: `user${n}@example.com`,
  message: `please let me in ${n}`,
  created_at: NOW - 3600 * n,
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminApprovals.mockResolvedValue({ items: [item(1), item(2)], next_cursor: null, pending_total: 2 });
  api.approveAdminApproval.mockResolvedValue(undefined);
  api.rejectAdminApproval.mockResolvedValue(undefined);
});

describe("ApprovalsTab", () => {
  it("shows the count badge, the banner, and each request with email, date and message", async () => {
    renderWithClient(<ApprovalsTab />);
    expect(await screen.findByText("user1@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("2 waiting")).toHaveTextContent("2");
    expect(screen.getByRole("status")).toHaveTextContent("2 accounts are waiting for approval.");
    expect(screen.getByText("please let me in 1")).toBeInTheDocument();
    expect(screen.getAllByText(shortDate(NOW - 3600)).length).toBeGreaterThan(0);
  });

  it("states that Disable on the Users tab is the permanent no", async () => {
    renderWithClient(<ApprovalsTab />);
    expect(await screen.findByText(/Disable on the Users tab is the permanent no/)).toBeInTheDocument();
  });

  it("uses the singular for one request", async () => {
    api.fetchAdminApprovals.mockResolvedValue({ items: [item(1)], next_cursor: null, pending_total: 1 });
    renderWithClient(<ApprovalsTab />);
    expect(await screen.findByRole("status")).toHaveTextContent("1 account is waiting for approval.");
  });

  it("renders a message as text, not markup", async () => {
    api.fetchAdminApprovals.mockResolvedValue({
      items: [item(1, { message: "<script>alert(1)</script>" })],
      next_cursor: null,
      pending_total: 1,
    });
    const { container } = renderWithClient(<ApprovalsTab />);
    expect(await screen.findByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  it("approves a request, drops the row and lowers the count", async () => {
    renderWithClient(<ApprovalsTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve user1@example.com" }));
    await waitFor(() => expect(api.approveAdminApproval).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect(screen.queryByText("user1@example.com")).not.toBeInTheDocument());
    expect(screen.getByLabelText("1 waiting")).toBeInTheDocument();
    expect(screen.getByText("user2@example.com")).toBeInTheDocument();
  });

  it("rejects with an optional note", async () => {
    renderWithClient(<ApprovalsTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject user2@example.com" }));
    fireEvent.change(screen.getByLabelText(/Note for user2@example.com/), { target: { value: "wrong team" } });
    fireEvent.click(screen.getByRole("button", { name: "Send rejection to user2@example.com" }));
    await waitFor(() => expect(api.rejectAdminApproval).toHaveBeenCalledWith("a2", "wrong team"));
    await waitFor(() => expect(screen.queryByText("user2@example.com")).not.toBeInTheDocument());
  });

  it("keeps the row and shows the error when a decision fails", async () => {
    api.approveAdminApproval.mockRejectedValue(new Error("That request is no longer open."));
    renderWithClient(<ApprovalsTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve user1@example.com" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That request is no longer open.");
    expect(screen.getByText("user1@example.com")).toBeInTheDocument();
  });

  it("loads more with the cursor and appends", async () => {
    api.fetchAdminApprovals
      .mockResolvedValueOnce({ items: [item(1)], next_cursor: "c2", pending_total: 2 })
      .mockResolvedValueOnce({ items: [item(2)], next_cursor: null, pending_total: 2 });
    renderWithClient(<ApprovalsTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("user2@example.com")).toBeInTheDocument();
    expect(api.fetchAdminApprovals).toHaveBeenLastCalledWith({ limit: 25, cursor: "c2" });
    expect(screen.getByText("user1@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows an empty state and no badge when nothing waits", async () => {
    api.fetchAdminApprovals.mockResolvedValue({ items: [], next_cursor: null, pending_total: 0 });
    renderWithClient(<ApprovalsTab />);
    expect(await screen.findByText("No account requests are waiting.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/waiting$/)).not.toBeInTheDocument();
  });

  it("says when the list could not be loaded", async () => {
    api.fetchAdminApprovals.mockRejectedValue(new Error("down"));
    renderWithClient(<ApprovalsTab />);
    expect(await screen.findByText("Couldn't load approvals.")).toBeInTheDocument();
  });
});
