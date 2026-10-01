import { useQuery } from "@tanstack/react-query";
import { fetchAdminInstance } from "../../api";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { CardBody } from "./CardBody";

export default function InstanceCard() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["admin", "instance"], queryFn: fetchAdminInstance });
  const rows: [string, string | number][] = data
    ? [
        ["Version", data.version],
        ["Database", data.db_backend],
        ["Cluster", data.cluster_enabled ? "On" : "Off"],
        ["Audit log", data.audit_stored ? data.audit_log_dest : `${data.audit_log_dest} (not in database)`],
        ["Users", data.user_count],
        ["Admins", data.admin_count],
      ]
    : [];
  return (
    <Box title="Instance">
      <CardBody isLoading={isLoading} isError={isError} label="instance info">
        <DataTable
          caption="Instance settings"
          head={
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Value</th>
            </tr>
          }
        >
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </DataTable>
      </CardBody>
    </Box>
  );
}
