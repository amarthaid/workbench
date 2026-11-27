import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithClient } from "../test-utils";
import { OpenRequests, SpaceRequestList } from "./SpaceRequestList";
import { RequestsModal } from "./RequestsModal";
import type { SpaceApproval } from "../approvals-api";

const api = vi.hoisted(() => ({ fetchApprovals: vi.fn(), approveApproval: vi.fn(), rejectApproval: vi.fn() }));
vi.mock("../approvals-api", async (orig) => ({ ...(await orig<typeof import("../approvals-api")>()), ...api }));

const NOW = Math.floor(Date.now() / 1000);
const req = (id: string, over: Partial<SpaceApproval> = {}): SpaceApproval => ({
  id,
  kind: "space.access",
  subject: "sprint-board",
  subject_label: "Sprint Board",
  requester_email: `${id}@example.com`,
  message: `hi from ${id}`,
  status: "pending",
  created_at: NOW - 60,
  delegated: false,
  ...over,
});

const WARNING = "This Space runs with your connected apps. Approving lets this person use them.";

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.approveApproval.mockResolvedValue(undefined);
  api.rejectApproval.mockResolvedValue(undefined);
});

describe("SpaceRequestList", () => {
  it("shows requester, message and the Space asked for", () => {
    render(<SpaceRequestList items={[req("r1")]} />);
    expect(screen.getByText("r1@example.com")).toBeInTheDocument();
    expect(screen.getByText("hi from r1")).toBeInTheDocument();
    expect(screen.getByText("Sprint Board")).toBeInTheDocument();
  });

  it("shows the delegated warning only on rows where delegated is true", () => {
    render(<SpaceRequestList items={[req("r1", { delegated: true }), req("r2")]} />);
    expect(screen.getAllByText(WARNING)).toHaveLength(1);
    const row = screen.getByText("r1@example.com").closest("li")!;
    expect(row).toHaveTextContent(WARNING);
    expect(screen.getByText("r2@example.com").closest("li")).not.toHaveTextContent(WARNING);
  });

  it("approves, removes the row and reports the decision", async () => {
    const onDecided = vi.fn();
    render(<SpaceRequestList items={[req("r1"), req("r2")]} onDecided={onDecided} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve r1@example.com" }));
    await waitFor(() => expect(api.approveApproval).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(screen.queryByText("r1@example.com")).not.toBeInTheDocument());
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(screen.getByText("r2@example.com")).toBeInTheDocument();
  });

  it("rejects with the note", async () => {
    render(<SpaceRequestList items={[req("r1")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject r1@example.com" }));
    fireEvent.change(screen.getByLabelText(/Note for/), { target: { value: "not yours" } });
    fireEvent.click(screen.getByRole("button", { name: /Send rejection/ }));
    await waitFor(() => expect(api.rejectApproval).toHaveBeenCalledWith("r1", "not yours"));
    expect(await screen.findByText("No one is waiting for access.")).toBeInTheDocument();
  });

  it("keeps the row and shows the error on failure", async () => {
    api.approveApproval.mockRejectedValue(new Error("That request is no longer open."));
    render(<SpaceRequestList items={[req("r1")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve r1@example.com" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That request is no longer open.");
    expect(screen.getByText("r1@example.com")).toBeInTheDocument();
  });

  it("renders request text as text", () => {
    const { container } = render(<SpaceRequestList items={[req("r1", { message: "<a href='x'>click</a>" })]} />);
    expect(screen.getByText("<a href='x'>click</a>")).toBeInTheDocument();
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("OpenRequests", () => {
  it("lists only the open requests for this Space, without naming the Space again", async () => {
    api.fetchApprovals.mockResolvedValue([
      req("r1"),
      req("r2", { subject: "other-space", subject_label: "Other" }),
      req("r3", { status: "approved" }),
    ]);
    render(<OpenRequests spaceName="sprint-board" />);
    expect(await screen.findByText("r1@example.com")).toBeInTheDocument();
    expect(screen.queryByText("r2@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("r3@example.com")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Requests to open this Space (1)" })).toBeInTheDocument();
    expect(screen.queryByText(/Wants to open/)).not.toBeInTheDocument();
    expect(api.fetchApprovals).toHaveBeenCalledWith("inbox");
  });

  it("renders nothing when nobody is waiting or the load fails", async () => {
    api.fetchApprovals.mockResolvedValueOnce([]);
    const { container, rerender } = render(<OpenRequests spaceName="a" />);
    await waitFor(() => expect(api.fetchApprovals).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    api.fetchApprovals.mockRejectedValueOnce(new Error("x"));
    rerender(<OpenRequests spaceName="b" />);
    await waitFor(() => expect(api.fetchApprovals).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("RequestsModal", () => {
  it("loads the inbox when opened and lists every Space's requests", async () => {
    api.fetchApprovals.mockResolvedValue([req("r1"), req("r2", { subject_label: "Standup", delegated: true })]);
    renderWithClient(<RequestsModal open onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByText("r1@example.com")).toBeInTheDocument();
    expect(screen.getByText("Standup")).toBeInTheDocument();
    expect(screen.getAllByText(WARNING)).toHaveLength(1);
  });

  it("does not fetch while closed, and closes on Escape", async () => {
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (open: boolean) => (
      <QueryClientProvider client={qc}>
        <RequestsModal open={open} onClose={onClose} />
      </QueryClientProvider>
    );
    const { rerender } = render(wrap(false));
    expect(api.fetchApprovals).not.toHaveBeenCalled();
    api.fetchApprovals.mockResolvedValue([]);
    rerender(wrap(true));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("says when requests could not be loaded", async () => {
    api.fetchApprovals.mockRejectedValue(new Error("x"));
    renderWithClient(<RequestsModal open onClose={vi.fn()} />);
    expect(await screen.findByText("Could not load requests. Close and try again.")).toBeInTheDocument();
  });
});
