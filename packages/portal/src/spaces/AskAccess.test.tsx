import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AskAccess, ASKED_COPY } from "./AskAccess";
import { ApprovalApiError } from "../approvals-api";

const api = vi.hoisted(() => ({ requestSpaceAccess: vi.fn() }));
vi.mock("../approvals-api", async (orig) => ({ ...(await orig<typeof import("../approvals-api")>()), ...api }));

beforeEach(() => {
  api.requestSpaceAccess.mockReset();
  api.requestSpaceAccess.mockResolvedValue(undefined);
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("AskAccess", () => {
  it("offers a message box capped at 280 with a counter", () => {
    render(<AskAccess name="sprint-board" />);
    const box = screen.getByLabelText("Message for the owner (optional)");
    expect(box).toHaveAttribute("maxlength", "280");
    fireEvent.change(box, { target: { value: "hello" } });
    expect(screen.getByText("5/280")).toBeInTheDocument();
  });

  it("sends the request and then shows only the fixed neutral copy", async () => {
    render(<AskAccess name="sprint-board" />);
    fireEvent.change(screen.getByLabelText(/Message for the owner/), { target: { value: "need the board" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask the owner for access" }));
    await waitFor(() => expect(api.requestSpaceAccess).toHaveBeenCalledWith("sprint-board", "need the board"));
    expect(await screen.findByText(ASKED_COPY)).toBeInTheDocument();
    expect(ASKED_COPY).toBe(
      "If this Space exists and was shared with specific people, the owner has been asked. You will see it in your gallery once approved."
    );
    expect(screen.queryByRole("button", { name: "Ask the owner for access" })).not.toBeInTheDocument();
  });

  it("never implies the Space exists", async () => {
    const { container } = render(<AskAccess name="sprint-board" />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the owner for access" }));
    await screen.findByText(ASKED_COPY);
    expect(container.textContent).not.toMatch(/\b(owner of|the owner is|sent to the owner|requested from)\b/i);
    expect(container.textContent).not.toContain("sprint-board");
  });

  it("remembers the waiting state per Space name", async () => {
    const first = render(<AskAccess name="sprint-board" />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the owner for access" }));
    await screen.findByText(ASKED_COPY);
    first.unmount();

    render(<AskAccess name="sprint-board" />);
    expect(screen.getByText(ASKED_COPY)).toBeInTheDocument();
    expect(api.requestSpaceAccess).toHaveBeenCalledTimes(1);

    render(<AskAccess name="other-space" />);
    expect(screen.getAllByRole("button", { name: "Ask the owner for access" })).toHaveLength(1);
  });

  it("lets the person ask again, forgetting the waiting state", async () => {
    render(<AskAccess name="sprint-board" />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the owner for access" }));
    await screen.findByText(ASKED_COPY);
    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(screen.getByRole("button", { name: "Ask the owner for access" })).toBeInTheDocument();
    expect(localStorage.getItem("wb_space_access_asked:sprint-board")).toBeNull();
  });

  it("still works when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<AskAccess name="sprint-board" />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the owner for access" }));
    expect(await screen.findByText(ASKED_COPY)).toBeInTheDocument();
  });

  it("shows the rate-limit copy and stays on the form", async () => {
    api.requestSpaceAccess.mockRejectedValue(new ApprovalApiError(429, "rate_limited", "Too many requests. Try again later."));
    render(<AskAccess name="sprint-board" />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the owner for access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Try again later.");
    expect(screen.queryByText(ASKED_COPY)).not.toBeInTheDocument();
    expect(localStorage.getItem("wb_space_access_asked:sprint-board")).toBeNull();
  });

  it("shows a generic error for other failures", async () => {
    api.requestSpaceAccess.mockRejectedValue(new ApprovalApiError(500, "failed", "Action failed"));
    render(<AskAccess name="sprint-board" />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the owner for access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not send the request. Try again.");
  });
});
