import { useQuery } from "@tanstack/react-query";
import { fetchAdminVault } from "../../api";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { StatStrip } from "../ui/StatStrip";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

// Counts and ages only. A secret's name is information too, so none is listed.
export default function VaultTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "vault"],
    queryFn: fetchAdminVault,
    staleTime: ADMIN_STALE_MS,
  });
  return (
    <CardBody isLoading={isLoading} isError={isError} label="vault stats">
      {data && (
        <div className="wb-section-gap">
          <StatStrip
            stats={[
              { label: "Secrets", value: data.secrets },
              { label: "Users with secrets", value: data.users_with_secrets },
              { label: `Unused ${data.stale_days}+ days`, value: data.stale },
              { label: "Pending one-time links", value: data.pending_links },
            ]}
            note="Names and values are never shown here."
          />
          <Box title="Top holders">
            {data.top_holders.length === 0 ? (
              <EmptyState message="No secrets stored." />
            ) : (
              <DataTable
                caption="Users holding the most secrets"
                head={
                  <tr>
                    <th scope="col">User</th>
                    <th scope="col" className="ui-num">Secrets</th>
                  </tr>
                }
              >
                {data.top_holders.map((h, i) => (
                  <tr key={`${h.email}-${i}`}>
                    <td>{h.email ?? "—"}</td>
                    <td className="ui-num">{h.secrets}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Box>
        </div>
      )}
    </CardBody>
  );
}
