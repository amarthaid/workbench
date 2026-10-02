import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAdminConfig,
  fetchAdminUsers,
  setAdminCustomAppsPolicy,
  setAdminIntegrationEnabled,
  type AdminConfig,
} from "../../api";
import { Badge } from "../ui/Badge";
import { Box, BoxRow } from "../ui/Box";
import { Button } from "../ui/Button";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

type Policy = AdminConfig["custom_apps_policy"];
type Row = AdminConfig["integrations"][number];

export default function ConfigTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "config"],
    queryFn: fetchAdminConfig,
    staleTime: ADMIN_STALE_MS,
  });
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Row | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "config"] });
  const onError = (e: unknown) => {
    setConfirm(null);
    setError(e instanceof Error ? e.message : "Action failed");
  };

  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => setAdminIntegrationEnabled(name, enabled),
    onSuccess: () => {
      setConfirm(null);
      setError(null);
      refresh();
    },
    onError,
  });

  const integrations = data?.integrations ?? [];

  return (
    <div className="wb-section-gap">
      {error && <div className="ui-form-error" role="alert">{error}</div>}

      <Box title="Integrations">
        <CardBody isLoading={isLoading} isError={isError} label="config">
          {integrations.length === 0 ? (
            <EmptyState message="No integrations are registered." />
          ) : (
            <DataTable
              caption="Integrations and whether they are enabled"
              head={
                <tr>
                  <th scope="col">Integration</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="ui-sr-only">Actions</span></th>
                </tr>
              }
            >
              {integrations.map((i) => (
                <tr key={i.name}>
                  <td>{i.display_name}</td>
                  <td>
                    <Badge variant={i.enabled ? "green" : "neutral"}>{i.enabled ? "Enabled" : "Disabled"}</Badge>
                  </td>
                  <td>
                    {i.enabled ? (
                      <Button
                        variant="danger"
                        size="sm"
                        aria-label={`Disable ${i.display_name}`}
                        onClick={() => setConfirm(i)}
                      >
                        Disable
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Enable ${i.display_name}`}
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate({ name: i.name, enabled: true })}
                      >
                        Enable
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </CardBody>
      </Box>

      {data && <CustomAppsPolicy policy={data.custom_apps_policy} onSaved={refresh} onError={onError} />}

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Disable integration"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={toggle.isPending}
              onClick={() => confirm && toggle.mutate({ name: confirm.name, enabled: false })}
            >
              Disable
            </Button>
          </>
        }
      >
        <p>
          Disable {confirm?.display_name} for every user? Its tools disappear from search and execution and it can't be
          connected. Existing connections are kept, and enabling it again restores everything. Other workers pick the
          change up within a few seconds.
        </p>
      </Modal>
    </div>
  );
}

function CustomAppsPolicy({
  policy,
  onSaved,
  onError,
}: {
  policy: Policy;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [mode, setMode] = useState<Policy["mode"]>(policy.mode);
  const [userIds, setUserIds] = useState<string[]>(policy.user_ids);
  const [saved, setSaved] = useState(false);

  // Follow the server's copy after a save or a refetch.
  useEffect(() => {
    setMode(policy.mode);
    setUserIds(policy.user_ids);
  }, [policy.mode, policy.user_ids]);

  const { data: users } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: fetchAdminUsers,
    staleTime: ADMIN_STALE_MS,
    enabled: mode === "allowlist",
  });

  const save = useMutation({
    mutationFn: (p: Policy) => setAdminCustomAppsPolicy(p),
    onSuccess: () => {
      setSaved(true);
      onSaved();
    },
    onError,
  });

  const next: Policy = { mode, user_ids: mode === "allowlist" ? userIds : [] };
  const changed =
    next.mode !== policy.mode ||
    next.user_ids.length !== policy.user_ids.length ||
    next.user_ids.some((id) => !policy.user_ids.includes(id));

  function toggleUser(id: string) {
    setSaved(false);
    setUserIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  return (
    <Box title="Custom apps">
      <BoxRow>
        <label htmlFor="admin-custom-apps-mode">Who can add custom apps</label>
        <Select
          id="admin-custom-apps-mode"
          value={mode}
          onChange={(e) => {
            setSaved(false);
            setMode(e.target.value as Policy["mode"]);
          }}
        >
          <option value="all">Everyone</option>
          <option value="none">No one</option>
          <option value="allowlist">Only selected users</option>
        </Select>
      </BoxRow>

      {mode === "allowlist" && (
        <BoxRow>
          <fieldset>
            <legend className="ui-sr-only">Users who can add custom apps</legend>
            {(users?.users ?? []).map((u) => (
              <label key={u.id} className="wb-toolbar-form">
                <input type="checkbox" checked={userIds.includes(u.id)} onChange={() => toggleUser(u.id)} />
                {u.email ?? u.id}
              </label>
            ))}
          </fieldset>
        </BoxRow>
      )}

      <BoxRow>
        <Button disabled={!changed || save.isPending} onClick={() => save.mutate(next)}>
          Save policy
        </Button>
        {saved && !changed && <span role="status">Saved.</span>}
        <p className="ui-stat-note">
          Excluded users keep their existing apps but agents stop seeing their tools. Other workers pick the change up
          within a few seconds.
        </p>
      </BoxRow>
    </Box>
  );
}
