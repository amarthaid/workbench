import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchWorkspaceFiles,
  downloadWorkspaceFile,
  uploadWorkspaceFile,
  deleteWorkspaceFile,
  type WorkspaceFile,
} from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { DataTable } from "../components/ui/DataTable";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * Time left before the reaper takes this file.
 *
 * Shown per row and shown prominently: retention is age only, so a file goes
 * 24h after it was written whether or not anyone is using it, and that is the
 * thing people are surprised by. A countdown explains it better than a tooltip.
 */
export function expiryLabel(expiresAt: string, now: Date = new Date()): string {
  const ms = Date.parse(expiresAt) - now.getTime();
  if (Number.isNaN(ms)) return "unknown";
  if (ms <= 0) return "expiring";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

/**
 * The same countdown phrased for a sentence rather than a badge.
 *
 * Returns null when there is nothing sensible to say — an unparseable date, or
 * a file already past its expiry — so the caller drops the line rather than
 * printing "deleted on its own expiring".
 */
export function expiresInPhrase(expiresAt: string, now: Date = new Date()): string | null {
  const label = expiryLabel(expiresAt, now);
  if (!label.endsWith(" left")) return null;
  return label.slice(0, -" left".length);
}

function isUrgent(expiresAt: string, now: Date = new Date()): boolean {
  return Date.parse(expiresAt) - now.getTime() < 3_600_000;
}

export default function Files() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The file pending confirmation. Deleting is immediate and irreversible, and
  // the file may be the result of twenty minutes of driving a browser, so a
  // misclick must not be enough to lose it.
  const [pendingDelete, setPendingDelete] = useState<WorkspaceFile | null>(null);
  // Separate from `error` on purpose: a failed delete belongs inside the dialog
  // the user is looking at, and showing it in both places at once would be two
  // copies of one problem.
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["workspace-files"],
    queryFn: fetchWorkspaceFiles,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["workspace-files"] });

  const upload = useMutation({
    mutationFn: uploadWorkspaceFile,
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: deleteWorkspaceFile,
    onSuccess: () => {
      setPendingDelete(null);
      void invalidate();
    },
    // Keep the dialog open on failure so the message lands somewhere the user
    // is already looking, rather than behind a panel that just closed.
    onError: (e: Error) => setDeleteError(e.message),
  });

  function closeDeleteDialog() {
    if (remove.isPending) return;
    setPendingDelete(null);
    setDeleteError(null);
  }

  async function download(name: string) {
    setBusy(name);
    setError(null);
    try {
      await downloadWorkspaceFile(name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const files: WorkspaceFile[] = data?.files ?? [];

  return (
    <>
      <PageHeader
        title="Files"
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              className="ui-sr-only"
              aria-label="Choose a file to upload"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = "";
              }}
            />
            <Button onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? "Uploading…" : "Upload file"}
            </Button>
          </>
        }
      />

      <Box
        title="Workspace"
        action={
          data ? (
            <span className="ui-stat-note">
              {formatBytes(data.usedBytes)} of {formatBytes(data.quotaBytes)} · files are
              deleted {data.ttlHours}h after they are written
            </span>
          ) : null
        }
      >
        {error && <div className="ui-form-error">{error}</div>}

        {isLoading && <div className="ui-loading">Loading files…</div>}
        {isError && <div className="ui-form-error">Couldn't load your files.</div>}

        {!isLoading && !isError && files.length === 0 && (
          <EmptyState
            message="Nothing here yet. Browser downloads land in this workspace, and anything you upload can be put into a page or handed to another app."
          />
        )}

        {files.length > 0 && (
          <DataTable
            caption="Files in your workspace"
            head={
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Size</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="ui-sr-only">Actions</span>
                </th>
              </tr>
            }
          >
            {files.map((f) => (
              <tr key={f.name}>
                <td>{f.name}</td>
                <td>{formatBytes(f.bytes)}</td>
                <td>
                  <Badge variant={isUrgent(f.expiresAt) ? "orange" : "neutral"}>
                    {expiryLabel(f.expiresAt)}
                  </Badge>
                </td>
                <td>
                  <Button
                    variant="ghost"
                    onClick={() => void download(f.name)}
                    disabled={busy === f.name}
                  >
                    {busy === f.name ? "Downloading…" : "Download"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDeleteError(null);
                      setPendingDelete(f);
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
        onClose={closeDeleteDialog}
        title="Delete this file?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={closeDeleteDialog} disabled={remove.isPending}>
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
          <strong>{pendingDelete?.name}</strong> will be removed immediately. This cannot be
          undone.
        </p>
        {pendingDelete && expiresInPhrase(pendingDelete.expiresAt) && (
          <p className="ui-stat-note">
            It would have expired on its own in {expiresInPhrase(pendingDelete.expiresAt)}.
          </p>
        )}
        {deleteError && <div className="ui-form-error">{deleteError}</div>}
      </Modal>
    </>
  );
}
