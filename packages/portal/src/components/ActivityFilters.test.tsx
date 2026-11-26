import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import {
  ActivityFilters,
  countActiveFilters,
  customRangeError,
  defaultFilters,
  filtersToOpts,
  type AppliedFilters,
} from "./ActivityFilters";
import { SpaceCombobox } from "./SpaceCombobox";
import { PersonCombobox } from "./PersonCombobox";

const api = vi.hoisted(() => ({ fetchActivityPeople: vi.fn(), fetchActivity: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), ...api }));

const NOW = 1_800_000_000;
const SPACES = [{ name: "release-desk", title: "Release desk" }, { name: "cockpit", title: "Branch Cockpit" }];

function Harness({ onChange, initial }: { onChange: (f: AppliedFilters) => void; initial?: Partial<AppliedFilters> }) {
  const [value, setValue] = useState<AppliedFilters>({ ...defaultFilters(NOW), ...initial });
  return (
    <ActivityFilters
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      now={() => NOW}
      integrations={[{ name: "jira", label: "Jira" }, { name: "github", label: "GitHub" }]}
      spaceField={(s) => <SpaceCombobox source={{ kind: "local", spaces: SPACES }} {...s} />}
      partyField={{ kind: "person", render: (s) => <PersonCombobox since={NOW - 1000} {...s} /> }}
    />
  );
}

const openPopover = () => fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));

beforeEach(() => {
  api.fetchActivityPeople.mockReset();
  api.fetchActivity.mockReset();
  api.fetchActivityPeople.mockResolvedValue({ stored: true, people: [{ email: "ana@example.com", count: 2 }] });
});

describe("ActivityFilters", () => {
  it("makes no onChange call while the draft is edited", () => {
    const onChange = vi.fn();
    renderWithClient(<Harness onChange={onChange} />);
    openPopover();
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    fireEvent.change(within(dialog).getByLabelText("App"), { target: { value: "jira" } });
    fireEvent.change(within(dialog).getByLabelText("Credential"), { target: { value: "oauth" } });
    fireEvent.click(within(dialog).getByLabelText("Delegated calls only"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Apply commits exactly one change with every field", () => {
    const onChange = vi.fn();
    renderWithClient(<Harness onChange={onChange} />);
    openPopover();
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    fireEvent.change(within(dialog).getByLabelText("App"), { target: { value: "jira" } });
    fireEvent.change(within(dialog).getByLabelText("Credential"), { target: { value: "api_key" } });
    const space = within(dialog).getByRole("combobox", { name: "Space" });
    fireEvent.focus(space);
    fireEvent.change(space, { target: { value: "cock" } });
    fireEvent.keyDown(space, { key: "Enter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const applied = onChange.mock.calls[0][0] as AppliedFilters;
    expect(applied).toMatchObject({ integration: "jira", auth: "api_key", space: "cockpit", delegated: false });
    expect(filtersToOpts(applied, "personal")).toEqual({
      since: NOW - 7 * 86400,
      integration: "jira",
      space: "cockpit",
      auth: "api_key",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filters/ })).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /^Filters/ })).toHaveFocus();
  });

  it("Esc discards the draft and returns focus to the button", () => {
    const onChange = vi.fn();
    renderWithClient(<Harness onChange={onChange} />);
    openPopover();
    fireEvent.change(screen.getByLabelText("App"), { target: { value: "jira" } });
    fireEvent.keyDown(screen.getByLabelText("App"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filters/ })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    openPopover();
    expect(screen.getByLabelText("App")).toHaveValue("");
  });

  it("a click outside discards the draft", () => {
    const onChange = vi.fn();
    renderWithClient(<><button>elsewhere</button><Harness onChange={onChange} /></>);
    openPopover();
    fireEvent.change(screen.getByLabelText("App"), { target: { value: "jira" } });
    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Reset clears the draft without applying", () => {
    const onChange = vi.fn();
    renderWithClient(<Harness onChange={onChange} initial={{ integration: "jira", delegated: true }} />);
    openPopover();
    expect(screen.getByLabelText("App")).toHaveValue("jira");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByLabelText("App")).toHaveValue("");
    expect(screen.getByLabelText("Delegated calls only")).not.toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("picking a person in the draft turns Delegated only on", async () => {
    const onChange = vi.fn();
    renderWithClient(<Harness onChange={onChange} />);
    openPopover();
    const person = screen.getByRole("combobox", { name: "Person" });
    fireEvent.focus(person);
    fireEvent.mouseDown(await screen.findByRole("option", { name: /ana@example.com/ }));
    expect(screen.getByLabelText("Delegated calls only")).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(filtersToOpts(onChange.mock.calls[0][0], "personal")).toMatchObject({ person: "ana@example.com", delegated: true });
  });

  it("shows a count badge and chips, each chip clears one filter, Clear all clears the rest", () => {
    const onChange = vi.fn();
    renderWithClient(<Harness onChange={onChange} initial={{ space: "cockpit", delegated: true }} />);
    expect(screen.getByRole("button", { name: /^Filters/ })).toHaveTextContent("2");
    expect(screen.getByText("Space: cockpit")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear Space: cockpit" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ space: "", delegated: true });
    expect(screen.queryByText("Space: cockpit")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toMatchObject({ space: "", delegated: false });
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it("applies All / Errors and the range at once, computing since at apply time", () => {
    const onChange = vi.fn();
    renderWithClient(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Errors" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ range: "30d", since: NOW - 30 * 86400 }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("custom range commits once both dates are valid and refuses more than 90 days", () => {
    const onChange = vi.fn();
    renderWithClient(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2027-01-01" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2027-01-10" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as AppliedFilters;
    expect(next.range).toBe("custom");
    expect(next.until! - next.since).toBe(10 * 86400 - 1);
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2027-06-10" } });
    expect(screen.getByRole("alert")).toHaveTextContent("limited to 90 days");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("helpers", () => {
  it("maps admin user to email and personal person to person", () => {
    const f = { ...defaultFilters(NOW), person: "a@example.com", user: "b@example.com", status: "error" as const };
    expect(filtersToOpts(f, "personal")).toMatchObject({ person: "a@example.com", status: "error" });
    expect(filtersToOpts(f, "personal")).not.toHaveProperty("email");
    expect(filtersToOpts(f, "admin")).toMatchObject({ email: "b@example.com" });
    expect(filtersToOpts(f, "admin")).not.toHaveProperty("person");
    expect(countActiveFilters(f)).toBe(2);
    expect(customRangeError("2027-01-10", "2027-01-01")).toMatch(/before/);
  });
});
