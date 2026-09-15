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

function isUrgent(expiresAt: string, now: Date = new Date()): boolean {
  return Date.parse(expiresAt) - now.getTime() < 3_600_000;
}

export default function Files() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
    onSuccess: () => void invalidate(),
    onError: (e: Error) => setError(e.message),
  });

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
                    onClick={() => remove.mutate(f.name)}
                    disabled={remove.isPending}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Box>
    </>
  );
}
