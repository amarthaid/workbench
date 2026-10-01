import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  disableAdminUser,
  enableAdminUser,
  fetchAdminUsers,
  revokeAdminUserKey,
  type AdminUser,
} from "../../api";
import { useAuth } from "../../context/AuthContext";
import { dayLabel, relativeTime } from "../../format";
import { Badge } from "../ui/Badge";
import { Box } from "../ui/Box";
import { Button } from "../ui/Button";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Modal } from "../ui/Modal";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

type Action = { kind: "disable" | "enable" | "revoke"; id: string };
type Confirm = { kind: "disable" | "revoke"; user: AdminUser };

export default function UsersTab() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: fetchAdminUsers,
    staleTime: ADMIN_STALE_MS,
  });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: ({ kind, id }: Action) =>
      kind === "disable" ? disableAdminUser(id) : kind === "enable" ? enableAdminUser(id) : revokeAdminUserKey(id),
    onSuccess: () => {
      setConfirm(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (e) => {
      setConfirm(null);
      setError(e instanceof Error ? e.message : "Action failed");
    },
  });

  const users = data?.users ?? [];
  const label = (u: AdminUser) => u.email ?? u.id;

  return (
    <>
      {error && <div className="ui-form-error" role="alert">{error}</div>}
      <Box title="Users">
        <CardBody isLoading={isLoading} isError={isError} label="users">
          {users.length === 0 ? (
            <EmptyState message="No users yet." />
          ) : (
            <DataTable
              caption="All users"
              head={
                <tr>
                  <th scope="col">User</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Last active</th>
                  <th scope="col" className="ui-num">Connections</th>
                  <th scope="col" className="ui-num">Apps</th>
                  <th scope="col">API key</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="ui-sr-only">Actions</span></th>
                </tr>
              }
            >
              {users.map((u) => {
                const disabled = u.disabled_at !== null;
                return (
                  <tr key={u.id}>
                    <td>{label(u)}</td>
                    <td>{dayLabel(u.created_at)}</td>
                    <td>{u.last_activity ? relativeTime(u.last_activity) : "—"}</td>
                    <td className="ui-num">{u.connection_count}</td>
                    <td className="ui-num">{u.custom_app_count}</td>
                    <td>{u.has_api_key ? "Yes" : "—"}</td>
                    <td>
                      <Badge variant={disabled ? "red" : "green"}>{disabled ? "Disabled" : "Active"}</Badge>
                    </td>
                    <td>
                      <div className="wb-toolbar-form">
                        {u.has_api_key && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Revoke key for ${label(u)}`}
                            onClick={() => setConfirm({ kind: "revoke", user: u })}
                          >
                            Revoke key
                          </Button>
                        )}
                        {disabled ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Enable ${label(u)}`}
                            disabled={act.isPending}
                            onClick={() => act.mutate({ kind: "enable", id: u.id })}
                          >
                            Enable
                          </Button>
                        ) : (
                          u.id !== me?.id && (
                            <Button
                              variant="danger"
                              size="sm"
                              aria-label={`Disable ${label(u)}`}
                              onClick={() => setConfirm({ kind: "disable", user: u })}
                            >
                              Disable
                            </Button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </CardBody>
      </Box>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "disable" ? "Disable user" : "Revoke API key"}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={act.isPending}
              onClick={() => confirm && act.mutate({ kind: confirm.kind, id: confirm.user.id })}
            >
              {confirm?.kind === "disable" ? "Disable" : "Revoke key"}
            </Button>
          </>
        }
      >
        {confirm?.kind === "disable" ? (
          <p>
            Disable {confirm && label(confirm.user)}? They are signed out of the portal, and agents using their API key
            or OAuth login stop working. Their connections and files are kept, and you can enable them again.
          </p>
        ) : (
          <p>
            Revoke the API key for {confirm && label(confirm.user)}? Agents using it stop working until they create a
            new one.
          </p>
        )}
      </Modal>
    </>
  );
}
