import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  clearUserPermission,
  disableAdminUser,
  enableAdminUser,
  fetchAdminUsers,
  getUserPermissions,
  revokeAdminUserKey,
  setUserPermission,
  type AdminPermission,
  userStatus,
  type AdminUser,
} from "../../api";
import { useAuth } from "../../context/AuthContext";
import { dayLabel, relativeTime, shortDate } from "../../format";
import { Badge } from "../ui/Badge";
import { Box, BoxRow } from "../ui/Box";
import { Button } from "../ui/Button";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Segmented } from "../ui/Segmented";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

type Action = { kind: "disable" | "enable" | "revoke"; id: string };
type UserFilter = "current" | "pending" | "all";

type Confirm = { kind: "disable" | "revoke"; user: AdminUser };

// The capability whose reset strands Spaces that use it. Resetting it while
// the user has delegated Spaces asks first.
const DELEGATE_CAPABILITY = "spaces.delegate_access";

const COLUMNS = 8;

function opposite(p: AdminPermission) {
  return p.default === "deny" ? "allow" : "deny";
}

/**
 * One user's per-capability permissions: Allow (or Deny, for a default-allow
 * capability) or Default. Only the opposite of the default can be set; Default
 * removes the rule.
 */
function PermissionsPanel({ user, label }: { user: AdminUser; label: string }) {
  const qc = useQueryClient();
  const queryKey = ["admin", "users", user.id, "permissions"];
  const { data, isLoading, isError } = useQuery({ queryKey, queryFn: () => getUserPermissions(user.id) });
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<AdminPermission | null>(null);

  const change = useMutation({
    mutationFn: ({ p, to }: { p: AdminPermission; to: "rule" | "default" }) =>
      to === "rule" ? setUserPermission(user.id, p.capability, opposite(p)) : clearUserPermission(user.id, p.capability),
    onSuccess: () => {
      setError(null);
      setConfirmReset(null);
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e) => {
      setConfirmReset(null);
      setError(e instanceof Error ? e.message : "Action failed");
    },
  });

  const choose = (p: AdminPermission, to: "rule" | "default") => {
    if (to === "default" && p.capability === DELEGATE_CAPABILITY && (data?.delegatedSpaces ?? 0) > 0) {
      setConfirmReset(p);
      return;
    }
    change.mutate({ p, to });
  };

  const n = data?.delegatedSpaces ?? 0;
  return (
    <div className="wb-perm-panel">
      <Box title="Permissions" action="Default follows the instance setting">
        <CardBody isLoading={isLoading} isError={isError} label="permissions">
          {error && <div className="ui-form-error" role="alert">{error}</div>}
          {data?.permissions.map((p) => {
            const rule = opposite(p);
            return (
              <BoxRow key={p.capability} className="wb-perm-row">
                <div className="wb-perm-text">
                  <span className="wb-perm-label">{p.label}</span>
                  <span className="wb-perm-desc">{p.description}</span>
                  <span className="wb-perm-desc">
                    {p.source === "rule"
                      ? `${rule === "allow" ? "Granted" : "Denied"} by ${p.grantedByEmail ?? p.grantedBy ?? "an admin"}${
                          p.grantedAt ? `, ${shortDate(p.grantedAt)}` : ""
                        }`
                      : `Default: ${p.default === "allow" ? "on" : "off"}`}
                  </span>
                </div>
                <Segmented
                  label={`${p.label} for ${label}`}
                  value={p.source === "rule" ? "rule" : "default"}
                  disabled={change.isPending}
                  options={[
                    { value: "rule", label: rule === "allow" ? "Allow" : "Deny" },
                    { value: "default", label: "Default" },
                  ]}
                  onChange={(to) => choose(p, to)}
                />
              </BoxRow>
            );
          })}
        </CardBody>
      </Box>
      <Modal
        open={confirmReset !== null}
        onClose={() => setConfirmReset(null)}
        title="Remove permission"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmReset(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={change.isPending}
              onClick={() => confirmReset && change.mutate({ p: confirmReset, to: "default" })}
            >
              Set to Default
            </Button>
          </>
        }
      >
        <p>
          {label} has {n} {n === 1 ? "Space" : "Spaces"} using delegated access. They will stop working for viewers
          until it is allowed again.
        </p>
      </Modal>
    </div>
  );
}

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

  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  // Pending sign-ups are decided on the Approvals tab, so the main list hides
  // them until asked.
  const [filter, setFilter] = useState<UserFilter>("current");

  const label = (u: AdminUser) => u.email ?? u.id;
  const all = data?.users ?? [];
  // Filtered in the browser over what the server sent: instant, and enough for
  // an instance with a few hundred users. The server caps the list, so the card
  // says so when it was cut off rather than pretending to search everyone.
  const q = query.trim().toLowerCase();
  const pendingCount = all.filter((u) => userStatus(u) === "pending").length;
  const inFilter = all.filter((u) => {
    const pending = userStatus(u) === "pending";
    return filter === "all" || (filter === "pending" ? pending : !pending);
  });
  const users = q ? inFilter.filter((u) => label(u).toLowerCase().includes(q)) : inFilter;
  const truncated = data !== undefined && data.total > all.length;

  return (
    <>
      {error && <div className="ui-form-error" role="alert">{error}</div>}
      <Box title="Users">
        <CardBody isLoading={isLoading} isError={isError} label="users">
          {all.length > 0 && (
            <div className="wb-box-toolbar">
              <div className="wb-toolbar-controls">
                <label className="ui-sr-only" htmlFor="admin-users-search">Search users by email</label>
                <Input
                  id="admin-users-search"
                  type="search"
                  placeholder="Search by email"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Segmented
                  label="Show users"
                  value={filter}
                  options={[
                    { value: "current", label: "Active and disabled" },
                    { value: "pending", label: `Pending (${pendingCount})` },
                    { value: "all", label: "All" },
                  ]}
                  onChange={setFilter}
                />
              </div>
              {q && <span className="ui-stat-note">Showing {users.length} of {inFilter.length} users.</span>}
            </div>
          )}
          {all.length === 0 ? (
            <EmptyState message="No users yet." />
          ) : users.length === 0 ? (
            <EmptyState
              message={
                q
                  ? `No users match "${query.trim()}".`
                  : filter === "pending"
                    ? "No sign-ups are waiting for approval."
                    : "No users in this view."
              }
            />
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
                const status = userStatus(u);
                const pending = status === "pending";
                const disabled = status === "disabled";
                const open = expanded === u.id;
                return (
                  <Fragment key={u.id}>
                  <tr>
                    <td>{label(u)}</td>
                    <td>{dayLabel(u.created_at)}</td>
                    <td>{u.last_activity ? relativeTime(u.last_activity) : "—"}</td>
                    <td className="ui-num">{u.connection_count}</td>
                    <td className="ui-num">{u.custom_app_count}</td>
                    <td>{u.has_api_key ? "Yes" : "—"}</td>
                    <td>
                      <Badge variant={pending ? "orange" : disabled ? "red" : "green"}>
                        {pending ? "Pending" : disabled ? "Disabled" : "Active"}
                      </Badge>
                    </td>
                    <td>
                      <div className="wb-toolbar-form">
                        <Button
                          variant={open ? "secondary" : "outline"}
                          size="sm"
                          aria-expanded={open}
                          aria-controls={open ? `perm-${u.id}` : undefined}
                          aria-label={`Permissions for ${label(u)}`}
                          onClick={() => setExpanded(open ? null : u.id)}
                        >
                          Permissions
                        </Button>
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
                        {(pending || disabled) && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`${pending ? "Approve" : "Enable"} ${label(u)}`}
                            disabled={act.isPending}
                            onClick={() => act.mutate({ kind: "enable", id: u.id })}
                          >
                            {pending ? "Approve" : "Enable"}
                          </Button>
                        )}
                        {!disabled && u.id !== me?.id && (
                          <Button
                            variant="danger"
                            size="sm"
                            aria-label={`Disable ${label(u)}`}
                            onClick={() => setConfirm({ kind: "disable", user: u })}
                          >
                            Disable
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr id={`perm-${u.id}`} className="wb-perm-tr">
                      <td colSpan={COLUMNS}>
                        <PermissionsPanel user={u} label={label(u)} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </DataTable>
          )}
          {truncated && data && (
            <div className="ui-stat-note">
              Loaded the first {all.length} of {data.total} users; search covers only these.
            </div>
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
