import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../spaces-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spaces-api")>()),
  deleteSpace: vi.fn(),
}));
import { deleteSpace, SpaceApiError } from "../spaces-api";
import { DeleteSpaceDialog } from "./DeleteSpaceDialog";

beforeEach(() => vi.clearAllMocks());

function setup(over: Partial<React.ComponentProps<typeof DeleteSpaceDialog>> = {}) {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  render(
    <DeleteSpaceDialog
      space={{ name: "pr-timeline", title: "PR timeline", visibility: "private" }}
      onClose={onClose}
      onDeleted={onDeleted}
      {...over}
    />
  );
  return { onClose, onDeleted };
}

const button = () => screen.getByRole("button", { name: "Delete Space" });
const type = (v: string) => fireEvent.change(screen.getByLabelText(/Type the Space name/), { target: { value: v } });

describe("DeleteSpaceDialog", () => {
  it("names the Space and says what goes with it", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("PR timeline");
    expect(dialog).toHaveTextContent("cannot be undone");
    expect(dialog).toHaveTextContent("files and data");
    expect(dialog).toHaveTextContent("lose it");
  });

  it("says Only me for a private Space", () => {
    setup({ space: { name: "a", title: "A", visibility: "private" } });
    expect(screen.getByRole("dialog")).toHaveTextContent("Only me");
  });

  it("counts specific people when known", () => {
    setup({ space: { name: "a", title: "A", visibility: "users" }, sharedWith: 3 });
    expect(screen.getByRole("dialog")).toHaveTextContent("Specific people (3)");
  });

  it("says Everyone signed in", () => {
    setup({ space: { name: "a", title: "A", visibility: "org" } });
    expect(screen.getByRole("dialog")).toHaveTextContent("Everyone signed in");
  });

  it("shows the openers line only when the count is present", () => {
    setup({ openers: 7 });
    expect(screen.getByRole("dialog")).toHaveTextContent("7 people opened it in the last 30 days");
  });

  it("omits the openers line when absent", () => {
    setup();
    expect(screen.getByRole("dialog")).not.toHaveTextContent("opened it in the last");
  });

  it("keeps the button disabled until the exact name is typed, case-sensitive", () => {
    setup();
    expect(button()).toBeDisabled();
    type("PR-TIMELINE");
    expect(button()).toBeDisabled();
    type("pr-timeline ");
    expect(button()).toBeDisabled();
    type("pr-timeline");
    expect(button()).toBeEnabled();
  });

  it("deletes and reports success", async () => {
    vi.mocked(deleteSpace).mockResolvedValue(undefined);
    const { onDeleted } = setup();
    type("pr-timeline");
    fireEvent.click(button());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("pr-timeline"));
    expect(deleteSpace).toHaveBeenCalledWith("pr-timeline");
  });

  it("shows the server message on failure and stays open", async () => {
    vi.mocked(deleteSpace).mockRejectedValue(new SpaceApiError(403, { code: "FORBIDDEN", message: "Only the owner can delete this Space" }));
    const { onDeleted, onClose } = setup();
    type("pr-timeline");
    fireEvent.click(button());
    expect(await screen.findByText("Only the owner can delete this Space")).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
