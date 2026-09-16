import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchVaultSecrets, putVaultSecret, deleteVaultSecret, type VaultSecret } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { DataTable } from "../components/ui/DataTable";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const NAME_HELP = "Lowercase letters, digits, and _ . - only (max 64).";

export function relativeTime(sec: number | null, nowSec: number = Math.floor(Date.now() / 1000)): string {
  if (sec === null || sec === undefined) return "never";
  const d = Math.max(0, nowSec - sec);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

type Editing = { mode: "add" } | { mode: "replace"; secret: VaultSecret };

export default function Vault() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<VaultSecret | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({ queryKey: ["vault"], queryFn: fetchVaultSecrets });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["vault"] });

  function openAdd() {
    setEditing({ mode: "add" });
    setName("");
    setDescription("");
    setValue("");
    setShowValue(false);
    setFormError(null);
  }
  function openReplace(secret: VaultSecret) {
    setEditing({ mode: "replace", secret });
    setName(secret.name);
    setDescription(secret.description ?? "");
    setValue("");
    setShowValue(false);
    setFormError(null);
  }
  // The value never outlives the dialog: cleared on close, success or cancel.
  function closeEditor() {
    if (save.isPending) return;
    setEditing(null);
    setValue("");
    setShowValue(false);
  }

  const save = useMutation({
    // Wrapped rather than passed by reference: TanStack Query v5 calls
    // mutationFn with a (variables, context) pair, and forwarding that
    // straight to putVaultSecret would leak the context object into its
    // call args.
    mutationFn: (input: { name: string; value: string; description?: string }) => putVaultSecret(input),
    onSuccess: () => {
      setEditing(null);
      setValue("");
      void invalidate();
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const remove = useMutation({
    mutationFn: (name: string) => deleteVaultSecret(name),
    onSuccess: () => {
      setPendingDelete(null);
      void invalidate();
    },
    onError: (e: Error) => setDeleteError(e.message),
  });

  function submit() {
    if (!NAME_RE.test(name)) return setFormError(NAME_HELP);
    if (value === "") return setFormError("Value cannot be empty.");
    setFormError(null);
    save.mutate({ name, value, description: description || undefined });
  }

  const secrets = data ?? [];

  return (
    <>
      <PageHeader title="Vault" actions={<Button onClick={openAdd}>Add secret</Button>} />

      <Box
        title="Secrets"
        action={
          <span className="ui-stat-note">
            Encrypted at rest. Agents can use a secret but never read it — values are write-only here too.
          </span>
        }
      >
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
                  <Button variant="ghost" onClick={() => openReplace(s)}>
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
        open={editing !== null}
        onClose={closeEditor}
        title={editing?.mode === "replace" ? "Replace value" : "Add secret"}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={closeEditor} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          autoComplete="off"
        >
          <label className="ui-field">
            <span className="ui-field-label">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={editing?.mode === "replace"}
              placeholder="site_password"
              autoComplete="off"
            />
          </label>
          <label className="ui-field">
            <span className="ui-field-label">Description</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
          </label>
          <label className="ui-field">
            <span className="ui-field-label">Value</span>
            <Input
              type={showValue ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <Button type="button" variant="ghost" onClick={() => setShowValue((v) => !v)}>
            {showValue ? "Hide" : "Show"} while typing
          </Button>
          <p className="ui-stat-note">The value is never shown again after saving.</p>
          {formError && <div className="ui-form-error">{formError}</div>}
        </form>
      </Modal>

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
