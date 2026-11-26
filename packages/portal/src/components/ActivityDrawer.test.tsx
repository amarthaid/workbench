import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ActivityDrawer, activityRowProps } from "./ActivityDrawer";
import type { ActivityEvent } from "../api";

const NOW = Math.floor(Date.now() / 1000);
function ev(id: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id,
    integration: "acme",
    tool: `tool_${id}`,
    action: "EXECUTE",
    success: true,
    error: null,
    duration_ms: 120,
    created_at: NOW,
    auth_method: "oauth",
    client_name: "Claude Code",
    source_ip: "203.0.113.24",
    user_agent: "claude-code/2.1",
    ...over,
  };
}

function Page({ events, start = 2, extra }: { events: ActivityEvent[]; start?: number | null; extra?: () => React.ReactNode }) {
  const [id, setId] = useState<number | null>(start);
  return (
    <>
      <table><tbody>
        {events.map((e) => (
          <tr key={e.id} {...activityRowProps(e.id, id, setId)}><td>row {e.id}</td></tr>
        ))}
      </tbody></table>
      <input aria-label="elsewhere" />
      <ActivityDrawer events={events} selectedId={id} onSelect={setId} payloadSection={extra} />
      <output data-testid="open">{String(id)}</output>
    </>
  );
}

const open = () => screen.getByTestId("open").textContent;

describe("ActivityDrawer", () => {
  it("closes on Esc, the scrim and Close", () => {
    render(<Page events={[ev(1), ev(2), ev(3)]} />);
    expect(screen.getByRole("dialog", { name: "Call details" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(open()).toBe("null");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on the scrim and on Close", () => {
    const { unmount } = render(<Page events={[ev(1), ev(2)]} />);
    fireEvent.click(screen.getByTestId("activity-scrim"));
    expect(open()).toBe("null");
    unmount();
    render(<Page events={[ev(1), ev(2)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(open()).toBe("null");
  });

  it("moves with the arrow keys and the Newer and Older buttons", () => {
    render(<Page events={[ev(1), ev(2), ev(3)]} />);
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(open()).toBe("3");
    expect(screen.getByRole("button", { name: "Older" })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    expect(open()).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Newer" }));
    expect(open()).toBe("1");
    expect(screen.getByRole("button", { name: "Newer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(open()).toBe("2");
  });

  it("ignores the arrow keys while focus is in an input or a combobox", () => {
    render(
      <>
        <input role="combobox" aria-label="combo" />
        <Page events={[ev(1), ev(2), ev(3)]} />
      </>
    );
    fireEvent.keyDown(screen.getByLabelText("combo"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("elsewhere"), { key: "ArrowUp" });
    expect(open()).toBe("2");
  });

  it("explains a withheld origin on a call someone else made on your access", () => {
    const row = ev(2, {
      delegation: { direction: "for_me", other_email: "ana@example.com", space: "release-desk" },
      auth_method: null, client_name: null, source_ip: null, user_agent: null,
    });
    render(<Page events={[ev(1), row]} />);
    expect(screen.getByText(/ana@example.com through your Space/)).toBeInTheDocument();
    expect(screen.getByText(/not shown to you/)).toBeInTheDocument();
    expect(screen.queryByText("IP address")).not.toBeInTheDocument();
    const deleg = screen.getByRole("region", { name: "Delegated access" });
    expect(deleg).toHaveTextContent("Whose accessYours");
    expect(deleg).toHaveTextContent("Run byana@example.com");
  });

  it("shows credential, client, IP and browser when they are known", () => {
    render(<Page events={[ev(1), ev(2)]} />);
    const origin = screen.getByRole("region", { name: "Origin" });
    expect(origin).toHaveTextContent("OAuth");
    expect(origin).toHaveTextContent("Claude Code");
    expect(origin).toHaveTextContent("203.0.113.24");
    expect(origin).toHaveTextContent("claude-code/2.1");
  });

  it("shows the full error text", () => {
    render(<Page events={[ev(1), ev(2, { success: false, error: "UPSTREAM_ERROR: 405 not mergeable" })]} />);
    expect(screen.getByText("UPSTREAM_ERROR: 405 not mergeable")).toBeInTheDocument();
  });

  it("renders the payload slot", () => {
    render(<Page events={[ev(1), ev(2)]} extra={() => <button>Show arguments</button>} />);
    expect(screen.getByRole("button", { name: "Show arguments" })).toBeInTheDocument();
  });

  it("traps Tab inside the panel and returns focus to the row on close", () => {
    render(<Page events={[ev(1), ev(2)]} start={null} />);
    const row = screen.getByText("row 2").closest("tr")!;
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    const panel = screen.getByRole("dialog", { name: "Call details" });
    expect(panel).toHaveFocus();
    const close = screen.getByRole("button", { name: "Close" });
    const older = screen.getByRole("button", { name: "Older" });
    expect(older).toBeDisabled();
    const newer = screen.getByRole("button", { name: "Newer" });
    newer.focus();
    fireEvent.keyDown(newer, { key: "Tab" });
    expect(close).toHaveFocus();
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(newer).toHaveFocus();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(row).toHaveFocus();
  });
});

describe("activityRowProps", () => {
  it("opens on click and on Enter or Space, but not from a link inside the row", () => {
    const onSelect = vi.fn();
    render(
      <table><tbody>
        <tr {...activityRowProps(7, null, onSelect)}><td>r<button>link</button></td></tr>
      </tbody></table>
    );
    const row = screen.getByRole("row");
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "link" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "link" }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(3);
  });
});
