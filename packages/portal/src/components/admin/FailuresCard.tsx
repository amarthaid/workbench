import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchAdminActivity, UNSTORED_MESSAGE } from "../../api";
import { dayLabel, timeLabel } from "../../format";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

// The last few failed calls, so "why is someone complaining" does not need a
// trip to the Activity tab. Reuses the activity endpoint's error filter.
export default function FailuresCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "recent-failures"],
    queryFn: () => fetchAdminActivity({ status: "error", limit: 5 }),
    staleTime: ADMIN_STALE_MS,
  });
  const events = data?.events ?? [];
  return (
    <Box title="Recent failures" action={<Link to="/admin/activity">All activity</Link>}>
      <CardBody isLoading={isLoading} isError={isError} label="recent failures">
        {data && !data.stored ? (
          <EmptyState message={UNSTORED_MESSAGE} />
        ) : events.length === 0 ? (
          <EmptyState message="No failed calls." />
        ) : (
          <DataTable
            caption="Most recent failed tool calls"
            head={
              <tr>
                <th scope="col">Time</th>
                <th scope="col">User</th>
                <th scope="col">Tool</th>
              </tr>
            }
          >
            {events.map((e) => (
              <tr key={e.id}>
                <td className="wb-cell-time">{dayLabel(e.created_at)} {timeLabel(e.created_at)}</td>
                <td>{e.user_email ?? "—"}</td>
                <td>
                  <code className="wb-mono">{e.tool ?? "—"}</code>
                  {e.error && <div className="wb-cell-error" title={e.error}>{e.error}</div>}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </CardBody>
    </Box>
  );
}
