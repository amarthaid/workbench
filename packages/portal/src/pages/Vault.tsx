import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchVaultSecrets, deleteVaultSecret, type VaultSecret } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { ListRow } from "../components/ui/ListRow";
import { RowAction, RowActions } from "../components/ui/RowActions";
import { ListSkeleton } from "../components/ui/ListSkeleton";
import { CopyChip } from "../components/ui/CopyChip";
import { ClockIcon, KeyIcon } from "../components/ui/Icons";
import { TypedNameConfirm } from "../components/dialogs/TypedNameConfirm";


export function relativeTime(sec: number | null, nowSec: number = Math.floor(Date.now() / 1000)): string {
  if (sec === null || sec === undefined) return "never";
  const d = Math.max(0, nowSec - sec);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export default function Vault() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<VaultSecret | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({ queryKey: ["vault"], queryFn: fetchVaultSecrets });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["vault"] });

  const remove = useMutation({
    mutationFn: (name: string) => deleteVaultSecret(name),
    onSuccess: () => {
      setPendingDelete(null);
      void invalidate();
    },
    onError: (e: Error) => setDeleteError(e.message),
  });

  const secrets = data ?? [];

  return (
    <>
      <PageHeader title="Vault" />

      <Box
        title="Secrets"
        action={
          <>
            <Button variant="outline" onClick={() => navigate("/vault/one-time")}>
              <ClockIcon />
              One-time link
            </Button>
            <Button onClick={() => navigate("/vault/new")}>Add secret</Button>
          </>
        }
      >
        {isLoading && <ListSkeleton rows={3} />}
        {isError && <div className="ui-form-error">Couldn't load your vault.</div>}

        {!isLoading && !isError && secrets.length === 0 && (
          <EmptyState
            message="No secrets yet. Add a password or API key here, then tell your agent to use {{vault:NAME}} where the value goes."
            action={<Button onClick={() => navigate("/vault/new")}>Add secret</Button>}
          />
        )}

        {secrets.map((s) => (
          <ListRow
            key={s.name}
            icon={<KeyIcon />}
            title={s.name}
            chips={
              <CopyChip
                text={`{{vault:${s.name}}}`}
                label={`Copy reference for ${s.name}`}
                tooltip="Copies the reference, never the value"
              />
            }
            subtitle={
              <>
                {s.description && <div>{s.description}</div>}
                <div>
                  Updated {relativeTime(s.updated_at)}, last used {relativeTime(s.last_used_at)}
                </div>
              </>
            }
            actions={
              <RowActions>
                <Link
                  className="ui-row-action"
                  aria-label={`Replace ${s.name}`}
                  to={`/vault/${encodeURIComponent(s.name)}/replace`}
                >
                  Replace
                </Link>
                <RowAction
                  danger
                  aria-label={`Delete ${s.name}`}
                  onClick={() => {
                    setDeleteError(null);
                    setPendingDelete(s);
                  }}
                >
                  Delete
                </RowAction>
              </RowActions>
            }
          />
        ))}
      </Box>

      {pendingDelete && (
        <TypedNameConfirm
          title="Delete this secret?"
          name={pendingDelete.name}
          nameLabel="secret name"
          confirmLabel="Delete secret"
          busyLabel="Deleting…"
          busy={remove.isPending}
          error={deleteError}
          impact={
            <p>
              References to <code>{`{{vault:${pendingDelete.name}}}`}</code> will stop working.
              Agents and pages that use it will fail on their next use. This cannot be undone.
            </p>
          }
          onConfirm={() => remove.mutate(pendingDelete.name)}
          onCancel={() => {
            if (remove.isPending) return;
            setPendingDelete(null);
            setDeleteError(null);
          }}
        />
      )}
    </>
  );
}
