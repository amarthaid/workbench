import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchVaultSecrets, deleteVaultSecret, type VaultSecret } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { DataTable } from "../components/ui/DataTable";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";


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
      <PageHeader
        title="Vault"
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate("/vault/one-time")}>
              One-time link
            </Button>
            <Button onClick={() => navigate("/vault/new")}>Add secret</Button>
          </>
        }
      />

      <Box title="Secrets">
        {isLoading && <div className="ui-loading">Loading…</div>}
        {isError && <div className="ui-form-error">Couldn't load your vault.</div>}

        {!isLoading && !isError && secrets.length === 0 && (
          <EmptyState message="No secrets yet. Add a password or API key here, then tell your agent to use {{vault:NAME}} where the value goes." />
        )}

        {secrets.length > 0 && (
          <DataTable
            caption="Secrets in your vault"
            head={
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Reference</th>
                <th scope="col">Description</th>
                <th scope="col">Updated</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="ui-sr-only">Actions</span>
                </th>
              </tr>
            }
          >
            {secrets.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td>
                  <code>{`{{vault:${s.name}}}`}</code>
                </td>
                <td>{s.description ?? ""}</td>
                <td>{relativeTime(s.updated_at)}</td>
                <td>{relativeTime(s.last_used_at)}</td>
                <td>
                  <Button variant="ghost" onClick={() => navigate(`/vault/${encodeURIComponent(s.name)}/replace`)}>
                    Replace
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDeleteError(null);
                      setPendingDelete(s);
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Box>

      <Modal
        open={pendingDelete !== null}
        onClose={() => {
          if (!remove.isPending) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        title="Delete this secret?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => pendingDelete && remove.mutate(pendingDelete.name)}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        <p>
          <strong>{pendingDelete?.name}</strong> will be removed immediately. Any agent referencing
          it will fail on its next use. This cannot be undone.
        </p>
        {deleteError && <div className="ui-form-error">{deleteError}</div>}
      </Modal>
    </>
  );
}
