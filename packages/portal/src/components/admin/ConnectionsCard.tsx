import { useQuery } from "@tanstack/react-query";
import { fetchAdminConnections } from "../../api";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { CardBody } from "./CardBody";

export default function ConnectionsCard() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["admin", "connections"], queryFn: fetchAdminConnections });
  const rows = data?.integrations ?? [];
  return (
    <Box title="Connections">
      <CardBody isLoading={isLoading} isError={isError} label="connections">
        {rows.length === 0 ? (
          <EmptyState message="No connections yet." />
        ) : (
          <DataTable
            caption="Connections by integration"
            head={
              <tr>
                <th scope="col">Integration</th>
                <th scope="col" className="ui-num">Connected</th>
                <th scope="col" className="ui-num">Needs reconnect</th>
              </tr>
            }
          >
            {rows.map((r) => (
              <tr key={r.integration}>
                <td>{r.integration}</td>
                <td className="ui-num">{r.connected}</td>
                <td className={`ui-num${r.needs_reconnect > 0 ? " wb-status-bad" : ""}`}>{r.needs_reconnect}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </CardBody>
    </Box>
  );
}
