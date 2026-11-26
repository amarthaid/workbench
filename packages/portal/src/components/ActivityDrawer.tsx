import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ActivityEvent } from "../api";
import { dayLabel, durationLabel, timeLabel } from "../format";
import { Button } from "./ui/Button";
import "./activity-filters.css";

/**
 * Props that make a table row open the drawer from the mouse or the keyboard.
 * A click on a link or button inside the row (a Person or Space filter link)
 * is that control's own and does not open the drawer.
 */
export function activityRowProps(id: number, selectedId: number | null, onSelect: (id: number) => void) {
  return {
    tabIndex: 0,
    className: `af-row${selectedId === id ? " is-open" : ""}`,
    "aria-selected": selectedId === id,
    onClick: (e: MouseEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest("a, button, input, select")) return;
      onSelect(id);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(id);
      }
    },
  };
}

const AUTH_NAMES: Record<string, string> = {
  api_key: "API key",
  oauth: "OAuth",
  session: "Portal",
  curl_token: "Curl token",
};

export interface ActivityDrawerProps {
  /** Rows as listed, newest first. Newer and Older walk this list. */
  events: (ActivityEvent & { user_email?: string | null; actor_email?: string | null })[];
  /** The open row, or null when the drawer is closed. */
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** Admin view: the owner is the row's user, not "you". */
  admin?: boolean;
  appLabel?: (integration: string) => string;
  spaceTitle?: (name: string) => string;
  /** Admin only: the arguments and result block, fetched on its own click. */
  payloadSection?: (event: ActivityEvent) => ReactNode;
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
    el.getAttribute("role") === "combobox"
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="af-kv">
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ActivityDrawer({ events, selectedId, onSelect, admin, appLabel, spaceTitle, payloadSection }: ActivityDrawerProps) {
  const index = events.findIndex((e) => e.id === selectedId);
  const event = index >= 0 ? events[index] : null;
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const live = useRef({ index, events, onSelect });
  live.current = { index, events, onSelect };
  const isOpen = event !== null;

  // Focus moves in on open and back to the row that opened it on close.
  useEffect(() => {
    if (!isOpen) return;
    opener.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const el = opener.current;
      opener.current = null;
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    };
  }, [isOpen]);

  // A new row starts at the top.
  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0 });
  }, [selectedId]);

  useEffect(() => {
    if (!isOpen) return;
    function step(d: number) {
      const { index: i, events: list, onSelect: select } = live.current;
      const next = list[i + d];
      if (next) select(next.id);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Escape") {
        live.current.onSelect(null);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (isTyping(e.target)) return;
      e.preventDefault();
      // Down goes to the older call, the next row in the list.
      step(e.key === "ArrowDown" ? 1 : -1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  // Tab stays inside the panel.
  function trap(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
    );
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!event) return null;

  const app = event.integration ? (appLabel ? appLabel(event.integration) : event.integration) : "Unknown";
  const d = event.delegation ?? null;
  const space = d?.space ? (spaceTitle ? spaceTitle(d.space) : d.space) : null;
  const originAll = [event.auth_method, event.client_name, event.source_ip, event.user_agent];
  const withheld = d?.direction === "for_me" && originAll.every((v) => v === null || v === undefined);

  let whose: ReactNode = null;
  let runBy: ReactNode = null;
  if (d) {
    if (admin) {
      whose = event.user_email ?? "Unknown";
      runBy = event.actor_email ?? "Unknown";
    } else if (d.direction === "for_me") {
      whose = "Yours";
      runBy = d.other_email ?? "Someone";
    } else {
      whose = d.other_email ?? "Someone else";
      runBy = "You";
    }
  }

  const name = event.tool ?? event.action;

  return createPortal(
    <>
      <div className="af-scrim" data-testid="activity-scrim" onClick={() => onSelect(null)} />
      <aside
        ref={panelRef}
        className="af-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Call details"
        tabIndex={-1}
        onKeyDown={trap}
      >
        <div className="af-drawer-head">
          <div>
            <h2><code className="wb-mono">{name}</code></h2>
            <span className="af-sub">{app} · {dayLabel(event.created_at)} {timeLabel(event.created_at)}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>Close</Button>
        </div>

        <div className="af-drawer-body" ref={bodyRef}>
          <section className="af-sec" aria-label="Call">
            <h3>Call</h3>
            <Rows
              rows={[
                ["When", `${dayLabel(event.created_at)}, ${timeLabel(event.created_at)}`],
                ["App", app],
                ["Tool", event.tool ? <code className="wb-mono">{event.tool}</code> : null],
                ["Duration", event.duration_ms === null ? null : durationLabel(event.duration_ms)],
                [
                  "Status",
                  <span key="s" className={event.success ? "wb-status-ok" : "wb-status-bad"}>
                    <span aria-hidden>{event.success ? "✓" : "✕"}</span> {event.success ? "Succeeded" : "Failed"}
                  </span>,
                ],
              ]}
            />
            {!event.success && event.error && <div className="af-err">{event.error}</div>}
          </section>

          {d && (
            <section className="af-sec" aria-label="Delegated access">
              <h3>Delegated access</h3>
              <Rows rows={[["Whose access", whose], ["Run by", runBy], ["Space", space]]} />
            </section>
          )}

          <section className="af-sec" aria-label="Origin">
            <h3>Origin</h3>
            {withheld ? (
              <p className="space-muted">
                Made by {d?.other_email ?? "someone"} through your Space. Their IP address and browser are not shown to you.
              </p>
            ) : originAll.every((v) => !v) ? (
              <p className="space-muted">No origin was recorded for this call.</p>
            ) : (
              <Rows
                rows={[
                  ["Agent", event.client_name],
                  ["Signed in with", event.auth_method ? (AUTH_NAMES[event.auth_method] ?? event.auth_method) : null],
                  ["IP address", event.source_ip],
                  ["User agent", event.user_agent ? <code className="wb-mono">{event.user_agent}</code> : null],
                ]}
              />
            )}
          </section>

          {payloadSection && (
            <section className="af-sec" aria-label="Arguments and result">
              <h3>Arguments and result</h3>
              {payloadSection(event)}
            </section>
          )}
        </div>

        <div className="af-drawer-foot">
          <Button variant="outline" size="sm" disabled={index <= 0} onClick={() => onSelect(events[index - 1].id)}>Newer</Button>
          <span className="af-sub">Arrow keys move between calls</span>
          <Button variant="outline" size="sm" disabled={index >= events.length - 1} onClick={() => onSelect(events[index + 1].id)}>Older</Button>
        </div>
      </aside>
    </>,
    document.body
  );
}
