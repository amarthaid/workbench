import { Fragment } from "react";
import type { ActivityEvent, IntegrationSummary } from "../api";
import { DataTable } from "./ui/DataTable";
import IntegrationLogo from "./IntegrationLogo";
import { dayLabel, timeLabel, durationLabel } from "../format";

export interface AppLabel {
  label: string;
  logo?: string;
  /** True when the app was deleted — render muted, not as a live app. */
  deleted?: boolean;
}

// Shared by every page that shows an integration by name: resolve a stable
// name to its display name and logo, falling back to the name itself when the
// registry hasn't loaded or doesn't know it.
export function integrationLookup(integrations: IntegrationSummary[]): (name: string) => AppLabel {
  const map = new Map<string, AppLabel>();
  integrations.forEach((i) => map.set(i.name, { label: i.displayName || i.name, logo: i.logo }));
  // A custom-app key no longer in the registry is a deleted app — show that
  // instead of leaking the raw `custom:<uuid>` key.
  return (name: string) => map.get(name) ?? (name.startsWith("custom:") ? { label: "Deleted app", deleted: true } : { label: name });
}

// Rows arrive newest-first; walk them in order and emit a group header row
// whenever the day changes. No sorting here — the server already ordered them.
function groupByDay(events: ActivityEvent[]): { day: string; events: ActivityEvent[] }[] {
  const groups: { day: string; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const day = dayLabel(e.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(e);
    else groups.push({ day, events: [e] });
  }
  return groups;
}

export function ActivityTable({
  events,
  caption,
  appFor,
}: {
  events: ActivityEvent[];
  caption: string;
  /** Map an integration name to its display name + logo; name-only if unknown. */
  appFor?: (name: string) => AppLabel;
}) {
  const app: (name: string) => AppLabel = appFor ?? ((n) => ({ label: n }));

  return (
    <DataTable
      caption={caption}
      head={
        <tr>
          <th scope="col">Time</th>
          <th scope="col">App</th>
          <th scope="col">Tool</th>
          <th scope="col" className="ui-num">Duration</th>
          <th scope="col">Status</th>
        </tr>
      }
    >
      {groupByDay(events).map((g) => (
        <Fragment key={g.day}>
          <tr className="wb-day-row">
            <th scope="colgroup" colSpan={5}>{g.day}</th>
          </tr>
          {g.events.map((e) => (
            <tr key={e.id}>
              <td className="wb-cell-time">{timeLabel(e.created_at)}</td>
              <td>
                {e.integration ? (
                  <span className="wb-cell-app">
                    <IntegrationLogo
                      name={e.integration}
                      displayName={app(e.integration).label}
                      logo={app(e.integration).logo}
                      size={16}
                    />
                    {app(e.integration).deleted ? (
                      <span className="wb-app-deleted">{app(e.integration).label}</span>
                    ) : (
                      app(e.integration).label
                    )}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td>
                <code className="wb-mono">{e.tool ?? "—"}</code>
                {!e.success && e.error && (
                  <div className="wb-cell-error" title={e.error}>{e.error}</div>
                )}
              </td>
              <td className="ui-num">{durationLabel(e.duration_ms)}</td>
              <td>
                <span className={e.success ? "wb-status-ok" : "wb-status-bad"}>
                  <span aria-hidden>{e.success ? "✓" : "✕"}</span> {e.success ? "Succeeded" : "Failed"}
                </span>
              </td>
            </tr>
          ))}
        </Fragment>
      ))}
    </DataTable>
  );
}
