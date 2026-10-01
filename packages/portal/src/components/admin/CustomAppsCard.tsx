import { useQuery } from "@tanstack/react-query";
import { fetchAdminCustomApps } from "../../api";
import { dayLabel } from "../../format";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { CardBody } from "./CardBody";

export default function CustomAppsCard() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["admin", "custom-apps"], queryFn: fetchAdminCustomApps });
  const apps = data?.apps ?? [];
  return (
    <Box title="Custom apps">
      <CardBody isLoading={isLoading} isError={isError} label="custom apps">
        {apps.length === 0 ? (
          <EmptyState message="No custom apps." />
        ) : (
          <>
            <DataTable
              caption="Custom apps across all users"
              head={
                <tr>
                  <th scope="col">App</th>
                  <th scope="col">Owner</th>
                  <th scope="col">URL</th>
                  <th scope="col">Added</th>
                </tr>
              }
            >
              {apps.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.owner_email ?? "—"}</td>
                  <td><code className="wb-mono">{a.base_url}</code></td>
                  <td>{dayLabel(a.created_at)}</td>
                </tr>
              ))}
            </DataTable>
            {data && data.total > apps.length && (
              <div className="ui-stat-note">Showing the latest {apps.length} of {data.total}.</div>
            )}
          </>
        )}
      </CardBody>
    </Box>
  );
}
