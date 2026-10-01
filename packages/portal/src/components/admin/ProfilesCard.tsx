import { useQuery } from "@tanstack/react-query";
import { fetchAdminProfiles } from "../../api";
import { formatBytes, relativeTime } from "../../format";
import { Badge } from "../ui/Badge";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { CardBody } from "./CardBody";

export default function ProfilesCard() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["admin", "profiles"], queryFn: fetchAdminProfiles });
  const profiles = data?.profiles ?? [];
  return (
    <Box title="Browser profiles">
      <CardBody isLoading={isLoading} isError={isError} label="browser profiles">
        {data?.this_worker_only && (
          <div className="ui-stat-note">Cluster mode is on: only this worker's profiles are listed.</div>
        )}
        {profiles.length === 0 ? (
          <EmptyState message="No browser profiles." />
        ) : (
          <DataTable
            caption="Browser profiles on disk"
            head={
              <tr>
                <th scope="col">User</th>
                <th scope="col" className="ui-num">Size</th>
                <th scope="col">Last used</th>
                <th scope="col">Status</th>
              </tr>
            }
          >
            {profiles.map((p) => (
              <tr key={p.name}>
                <td>{p.email ?? p.name}</td>
                <td className="ui-num">{formatBytes(p.bytes)}</td>
                <td>{p.last_used ? relativeTime(p.last_used) : "—"}</td>
                <td>
                  <Badge variant={p.live ? "green" : "neutral"}>{p.live ? "Live" : "Idle"}</Badge>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </CardBody>
    </Box>
  );
}
