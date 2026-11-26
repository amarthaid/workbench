import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import { PersonCombobox } from "./PersonCombobox";

const api = vi.hoisted(() => ({ fetchActivityPeople: vi.fn(), fetchActivity: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), ...api }));

beforeEach(() => {
  api.fetchActivityPeople.mockReset();
  api.fetchActivity.mockReset();
  api.fetchActivityPeople.mockResolvedValue({
    stored: true,
    people: [{ email: "ana@example.com", count: 3 }, { email: "sam@example.com", count: 1 }],
  });
});

describe("PersonCombobox", () => {
  it("lists people with counts, makes one list request and no activity request while typing", async () => {
    renderWithClient(<PersonCombobox since={100} value="" onChange={() => {}} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    expect(await screen.findByRole("option", { name: /ana@example.com/ })).toHaveTextContent("3 calls");
    expect(screen.getByRole("option", { name: /sam@example.com/ })).toHaveTextContent("1 call");
    for (const v of ["s", "sa", "sam", "sam@", "sam@e"]) fireEvent.change(box, { target: { value: v } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(api.fetchActivityPeople).toHaveBeenCalledTimes(1);
    expect(api.fetchActivity).not.toHaveBeenCalled();
    expect(api.fetchActivityPeople).toHaveBeenCalledWith({ since: 100, until: undefined });
  });

  it("picks with the keyboard", async () => {
    const onChange = vi.fn();
    renderWithClient(<PersonCombobox since={100} value="" onChange={onChange} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    await screen.findAllByRole("option");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("sam@example.com");
  });

  it("says so when nobody matches", async () => {
    renderWithClient(<PersonCombobox since={100} value="" onChange={() => {}} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });
});
