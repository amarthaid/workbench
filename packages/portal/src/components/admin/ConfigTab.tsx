import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAdminConfig,
  fetchAdminUsers,
  setAdminBrowserBlockedDomains,
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

      {data && (
        <BrowserBlocklist
          domains={data.browser_blocked_domains ?? []}
          allowed={data.browser_allowed_domains ?? []}
          onSaved={() => {
            setError(null);
            refresh();
          }}
          onError={onError}
        />
      )}

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

function parseDomains(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean))];
}

function DomainList({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <BoxRow>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="ui-input"
        rows={6}
        style={{ fontFamily: "monospace", resize: "vertical" }}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </BoxRow>
  );
}

function BrowserBlocklist({
  domains,
  allowed,
  onSaved,
  onError,
}: {
  domains: string[];
  allowed: string[];
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const currentBlock = domains.join("\n");
  const currentAllow = allowed.join("\n");
  const [blockText, setBlockText] = useState(currentBlock);
  const [allowText, setAllowText] = useState(currentAllow);
  const [saved, setSaved] = useState(false);

  // Follow the server's (normalised) copy after a save or a refetch.
  useEffect(() => setBlockText(currentBlock), [currentBlock]);
  useEffect(() => setAllowText(currentAllow), [currentAllow]);

  const save = useMutation({
    mutationFn: ({ block, allow }: { block: string[]; allow: string[] }) => setAdminBrowserBlockedDomains(block, allow),
    onSuccess: () => {
      setSaved(true);
      onSaved();
    },
    onError,
  });

  const nextBlock = parseDomains(blockText);
  const nextAllow = parseDomains(allowText);
  const changed = nextBlock.join("\n") !== currentBlock || nextAllow.join("\n") !== currentAllow;

  return (
    <Box title="Browser blocked domains">
      <DomainList
        id="admin-browser-blocklist"
        label="Domains agent browser tabs may not load, one per line"
        placeholder={"example.com\n*.prod.example.com"}
        value={blockText}
        onChange={(v) => {
          setSaved(false);
          setBlockText(v);
        }}
      />
      <DomainList
        id="admin-browser-allowlist"
        label="Exceptions: domains to allow even though a block entry matches, one per line"
        placeholder={"x.prod.example.com\nz.prod.example.com"}
        value={allowText}
        onChange={(v) => {
          setSaved(false);
          setAllowText(v);
        }}
      />
      <BoxRow>
        <Button disabled={!changed || save.isPending} onClick={() => save.mutate({ block: nextBlock, allow: nextAllow })}>
          Save blocklist
        </Button>
        {saved && !changed && <span role="status">Saved.</span>}
        <p className="ui-stat-note">
          Each entry also covers its subdomains; *.example.com covers only the subdomains, not example.com itself. When
          a block entry and an exception both match, the more specific one wins, and an exception wins a tie: block
          *.prod.example.com with exception x.prod.example.com allows x.prod.example.com (and its subdomains) and blocks
          every other prod host. Exceptions alone allow nothing extra, and never open loopback or the server itself.
        </p>
        <p className="ui-stat-note">
          Every HTTP(S) request is checked, including redirects, iframes and scripts; WebSocket connections are not.
          Pages that are already open stay open. Other workers pick the change up within a few seconds.
        </p>
      </BoxRow>
    </Box>
  );
}
