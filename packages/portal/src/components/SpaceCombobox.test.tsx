import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import { SpaceCombobox } from "./SpaceCombobox";

const admin = vi.hoisted(() => ({ searchAdminSpaces: vi.fn() }));
vi.mock("../admin-spaces-api", () => admin);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hit = (name: string) => ({ name, title: name, owner_email: "dev@example.com" });

function type(box: HTMLElement, text: string) {
  fireEvent.focus(box);
  for (let i = 1; i <= text.length; i++) fireEvent.change(box, { target: { value: text.slice(0, i) } });
}

beforeEach(() => {
  admin.searchAdminSpaces.mockReset();
  admin.searchAdminSpaces.mockResolvedValue({ spaces: [hit("Release desk")], has_more: false });
});

describe("SpaceCombobox remote", () => {
  it("sends at most one search for five fast keystrokes", async () => {
    renderWithClient(<SpaceCombobox source={{ kind: "remote" }} value="" onChange={() => {}} />);
    type(screen.getByRole("combobox"), "relea");
    await waitFor(() => expect(admin.searchAdminSpaces).toHaveBeenCalledTimes(1));
    await sleep(400);
    expect(admin.searchAdminSpaces).toHaveBeenCalledTimes(1);
    expect(admin.searchAdminSpaces.mock.calls[0][0]).toBe("relea");
    expect(await screen.findByRole("option", { name: /Release desk/ })).toBeInTheDocument();
    expect(screen.getByText(/Showing 1/)).toBeInTheDocument();
  });

  it("sends nothing for one character and says why", async () => {
    renderWithClient(<SpaceCombobox source={{ kind: "remote" }} value="" onChange={() => {}} />);
    type(screen.getByRole("combobox"), "r");
    await sleep(400);
    expect(admin.searchAdminSpaces).not.toHaveBeenCalled();
    expect(screen.getByText(/Type 2 or more characters/)).toBeInTheDocument();
  });

  it("serves a repeated query from the cache", async () => {
    renderWithClient(<SpaceCombobox source={{ kind: "remote" }} value="" onChange={() => {}} />);
    const box = screen.getByRole("combobox");
    type(box, "re");
    await waitFor(() => expect(admin.searchAdminSpaces).toHaveBeenCalledTimes(1));
    await screen.findByRole("option");
    fireEvent.change(box, { target: { value: "rel" } });
    await waitFor(() => expect(admin.searchAdminSpaces).toHaveBeenCalledTimes(2));
    await screen.findByRole("option");
    fireEvent.change(box, { target: { value: "re" } });
    await sleep(400);
    expect(admin.searchAdminSpaces).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("option", { name: /Release desk/ })).toBeInTheDocument();
  });

  it("aborts the request in flight when a newer query replaces it", async () => {
    admin.searchAdminSpaces.mockImplementation(() => new Promise(() => {}));
    renderWithClient(<SpaceCombobox source={{ kind: "remote" }} value="" onChange={() => {}} />);
    const box = screen.getByRole("combobox");
    type(box, "re");
    await waitFor(() => expect(admin.searchAdminSpaces).toHaveBeenCalledTimes(1));
    const first = admin.searchAdminSpaces.mock.calls[0][1] as AbortSignal;
    expect(first.aborted).toBe(false);
    fireEvent.change(box, { target: { value: "rel" } });
    await waitFor(() => expect(admin.searchAdminSpaces).toHaveBeenCalledTimes(2));
    expect(first.aborted).toBe(true);
  });

  it("picks with the keyboard and reports the name once", async () => {
    const onChange = vi.fn();
    renderWithClient(<SpaceCombobox source={{ kind: "remote" }} value="" onChange={onChange} />);
    const box = screen.getByRole("combobox");
    type(box, "re");
    await screen.findByRole("option");
    expect(box).toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("Release desk");
  });
});

describe("SpaceCombobox local", () => {
  it("filters in the browser and makes no network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onChange = vi.fn();
    renderWithClient(
      <SpaceCombobox
        source={{ kind: "local", spaces: [{ name: "release-desk", title: "Release desk", meta: "shared with you" }, { name: "cockpit", title: "Branch Cockpit", meta: "yours" }] }}
        value=""
        onChange={onChange}
      />
    );
    const box = screen.getByRole("combobox");
    type(box, "cock");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("Branch Cockpit");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("cockpit");
    await sleep(300);
    expect(admin.searchAdminSpaces).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("SpaceCombobox remote value", () => {
  it("shows the title of the picked Space and keeps the slug as the value", async () => {
    admin.searchAdminSpaces.mockResolvedValue({
      spaces: [{ name: "release-desk", title: "Release desk", owner_email: "dev@example.com" }],
      has_more: false,
    });
    const onChange = vi.fn();
    function Harness() {
      const [v, setV] = useState("");
      return <SpaceCombobox source={{ kind: "remote" }} value={v} onChange={(n) => { onChange(n); setV(n); }} />;
    }
    renderWithClient(<Harness />);
    const box = screen.getByRole("combobox");
    type(box, "rel");
    await screen.findByRole("option");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("release-desk");
    expect(screen.getByRole("combobox")).toHaveValue("Release desk");
  });

  it("falls back to the slug when the title is not known", () => {
    renderWithClient(<SpaceCombobox source={{ kind: "remote" }} value="release-desk" onChange={() => {}} />);
    expect(screen.getByRole("combobox")).toHaveValue("release-desk");
  });
});
