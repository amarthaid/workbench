import { useQuery } from "@tanstack/react-query";
import { fetchAdminStats, UNSTORED_MESSAGE } from "../../api";
import { StatStrip } from "../ui/StatStrip";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

function trend(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? "no calls in either window" : "no calls in the 24h before";
  const pct = Math.round(((cur - prev) / prev) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}% vs the 24h before`;
}

// The headline numbers. Usage figures need audit events in the database; the
// user and connection counts do not, so they still show when audit is elsewhere.
export default function StatsCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: fetchAdminStats,
    staleTime: ADMIN_STALE_MS,
  });
  return (
    <CardBody isLoading={isLoading} isError={isError} label="usage stats">
      {data && (
        <StatStrip
          stats={[
            { label: "Calls (24h)", value: data.stored ? data.calls_24h : "—" },
            {
              label: "Error rate (24h)",
              value: !data.stored ? "—" : data.calls_24h === 0 ? "—" : `${Math.round((data.errors_24h / data.calls_24h) * 100)}%`,
            },
            { label: "Active users (7d)", value: data.stored ? `${data.active_users_7d} of ${data.total_users}` : "—" },
            { label: "Needs reconnect", value: data.needs_reconnect },
            { label: "Disabled users", value: data.disabled_users },
          ]}
          note={data.stored ? `Calls: ${trend(data.calls_24h, data.calls_prev_24h)}.` : UNSTORED_MESSAGE}
        />
      )}
    </CardBody>
  );
}
