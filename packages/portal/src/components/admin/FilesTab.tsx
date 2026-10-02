import { useQuery } from "@tanstack/react-query";
import { fetchAdminFiles } from "../../api";
import { formatBytes } from "../../format";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { StatStrip } from "../ui/StatStrip";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

function age(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Sizes and ages only; no file name or content. The server walks the workspace
// volume, so this loads only when the tab is opened.
export default function FilesTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "files"],
    queryFn: fetchAdminFiles,
    staleTime: ADMIN_STALE_MS,
  });
  return (
    <CardBody isLoading={isLoading} isError={isError} label="files stats">
      {data && (
        <div className="wb-section-gap">
          <StatStrip
            stats={[
              { label: "Disk used", value: formatBytes(data.bytes) },
              { label: "Files", value: data.files },
              { label: "Users with files", value: data.users },
              { label: "Oldest file", value: age(data.oldest_age_seconds) },
            ]}
            note="File names and contents are never shown here."
          />
          <Box title="Largest users">
            {data.top_users.length === 0 ? (
              <EmptyState message="No files stored." />
            ) : (
              <DataTable
                caption="Users holding the most file data"
                head={
                  <tr>
                    <th scope="col">User</th>
                    <th scope="col" className="ui-num">Files</th>
                    <th scope="col" className="ui-num">Size</th>
                  </tr>
                }
              >
                {data.top_users.map((u, i) => (
                  <tr key={`${u.email}-${i}`}>
                    <td>{u.email ?? "—"}</td>
                    <td className="ui-num">{u.files}</td>
                    <td className="ui-num">{formatBytes(u.bytes)}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Box>
          {data.largest.length > 0 && (
            <Box title="Largest files">
              <DataTable
                caption="Largest single files"
                head={
                  <tr>
                    <th scope="col">Owner</th>
                    <th scope="col" className="ui-num">Size</th>
                    <th scope="col" className="ui-num">Age</th>
                  </tr>
                }
              >
                {data.largest.map((f, i) => (
                  <tr key={i}>
                    <td>{f.email ?? "—"}</td>
                    <td className="ui-num">{formatBytes(f.bytes)}</td>
                    <td className="ui-num">{age(f.age_seconds)}</td>
                  </tr>
                ))}
              </DataTable>
            </Box>
          )}
        </div>
      )}
    </CardBody>
  );
}
