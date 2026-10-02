import { useQuery } from "@tanstack/react-query";
import { fetchAdminTopTools, UNSTORED_MESSAGE } from "../../api";
import { durationLabel } from "../../format";
import { Box } from "../ui/Box";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

export default function TopToolsCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "top-tools"],
    queryFn: fetchAdminTopTools,
    staleTime: ADMIN_STALE_MS,
  });
  const tools = data?.tools ?? [];
  return (
    <Box title="Top tools (7 days)">
      <CardBody isLoading={isLoading} isError={isError} label="top tools">
        {data && !data.stored ? (
          <EmptyState message={UNSTORED_MESSAGE} />
        ) : tools.length === 0 ? (
          <EmptyState message="No tool calls in the last 7 days." />
        ) : (
          <DataTable
            caption="Most-called tools in the last 7 days"
            head={
              <tr>
                <th scope="col">Tool</th>
                <th scope="col" className="ui-num">Calls</th>
                <th scope="col" className="ui-num">Errors</th>
                <th scope="col" className="ui-num">Avg time</th>
              </tr>
            }
          >
            {tools.map((t) => (
              <tr key={`${t.integration}/${t.tool}`}>
                <td><code className="wb-mono">{t.tool ?? "—"}</code></td>
                <td className="ui-num">{t.calls}</td>
                <td className={`ui-num${t.errors > 0 ? " wb-status-bad" : ""}`}>{t.errors}</td>
                <td className="ui-num">{durationLabel(t.avg_ms)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </CardBody>
    </Box>
  );
}
