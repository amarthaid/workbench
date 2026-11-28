import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchWorkspaceFiles,
  downloadWorkspaceFile,
  uploadWorkspaceFile,
  deleteWorkspaceFile,
  type WorkspaceFile,
} from "../api";
import { relativeTime } from "../format";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Input, Select } from "../components/ui/Input";
import { ListRow } from "../components/ui/ListRow";
import { RowAction, RowActions } from "../components/ui/RowActions";
import { ListSkeleton } from "../components/ui/ListSkeleton";
import { DownloadIcon, FileIcon, type FileKind } from "../components/ui/Icons";
import { ConfirmDialog } from "../components/dialogs/ConfirmDialog";
import { useUndoableAction } from "../hooks/useUndoableAction";

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
 * Returns null when there is nothing sensible to say: an unparseable date, or
 * a file already past its expiry, so the caller drops the line rather than
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

/**
 * Shorten a name to `max` characters by cutting the middle, so the tail (the
 * timestamp and extension that tell two files apart) survives. Names that
 * already fit are returned unchanged.
 */
export function middleTruncate(name: string, max: number): string {
  if (name.length <= max || max < 3) return name;
  const tail = Math.ceil((max - 1) / 2);
  const headLen = max - 1 - tail;
  return `${name.slice(0, headLen)}…${name.slice(name.length - tail)}`;
}

const NAME_MAX = 44;
// Above this many files the list is long enough to want sort and a name filter.
const LIST_TOOLS_THRESHOLD = 15;

function fileKind(name: string): FileKind {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (["csv", "tsv", "xls", "xlsx"].includes(ext)) return "table";
  if (["pdf", "doc", "docx", "txt", "md", "rtf"].includes(ext)) return "document";
  if (["zip", "gz", "tgz", "tar", "7z"].includes(ext)) return "archive";
  if (["json", "js", "ts", "html", "xml", "yml", "yaml", "py", "sh"].includes(ext)) return "code";
  return "other";
}

type SortKey = "newest" | "expiring" | "size";

function sortFiles(files: WorkspaceFile[], key: SortKey): WorkspaceFile[] {
  const copy = [...files];
  if (key === "newest") copy.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  else if (key === "expiring") copy.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  else copy.sort((a, b) => b.bytes - a.bytes);
  return copy;
}

function FileName({ name }: { name: string }) {
  const short = middleTruncate(name, NAME_MAX);
  if (short === name) return <>{name}</>;
  return (
    <span title={name}>
      <span aria-hidden="true">{short}</span>
      <span className="ui-sr-only">{name}</span>
    </span>
  );
}

export default function Files() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [sort, setSort] = useState<SortKey>("newest");
  const [filter, setFilter] = useState("");

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

  // A single delete is recoverable for a few seconds instead of asking first.
  const undoable = useUndoableAction<string>({ run: (name) => remove.mutate(name) });

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
  const showTools = files.length > LIST_TOOLS_THRESHOLD;

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = showTools && q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;
    return sortFiles(filtered, showTools ? sort : "newest");
  }, [files, filter, sort, showTools]);

  // Only files that still exist can be selected (a delete elsewhere drops them).
  const selectedNames = files.filter((f) => selected.has(f.name)).map((f) => f.name);

  function toggle(name: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function downloadSelected() {
    setError(null);
    const failed: string[] = [];
    for (const name of selectedNames) {
      try {
        await downloadWorkspaceFile(name);
      } catch {
        failed.push(name);
      }
    }
    if (failed.length > 0) {
      setError(`Could not download ${failed.length} of ${selectedNames.length} files: ${failed.join(", ")}`);
    }
  }

  async function deleteSelected() {
    const names = selectedNames;
    setBulkBusy(true);
    setError(null);
    const failed: string[] = [];
    // One at a time: the endpoint deletes a single file, and a failure in the
    // middle should not hide which files are still there.
    for (const name of names) {
      try {
        await deleteWorkspaceFile(name);
      } catch {
        failed.push(name);
      }
    }
    setBulkBusy(false);
    setConfirmBulk(false);
    setSelected(new Set(failed));
    if (failed.length > 0) {
      setError(`Could not delete ${failed.length} of ${names.length} files: ${failed.join(", ")}`);
    }
    void invalidate();
  }

  const count = selectedNames.length;

  const headerActions = (
    <div className="ui-list-tools">
      {showTools && (
        <>
          <Input
            type="search"
            aria-label="Filter files"
            placeholder="Filter by name"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Select aria-label="Sort files" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="newest">Newest</option>
            <option value="expiring">Expiring soonest</option>
            <option value="size">Largest</option>
          </Select>
        </>
      )}
      {count > 0 && (
        <>
          <span className="ui-stat-note">{count} selected</span>
          <Button variant="outline" size="sm" onClick={() => void downloadSelected()}>
            Download selected
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfirmBulk(true)}>
            Delete selected
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </>
      )}
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
    </div>
  );

  return (
    <>
      <PageHeader title="Files" />

      <Box
        title="Workspace"
        titleAside={
          data ? (
            <span className="ui-stat-note">
              {formatBytes(data.usedBytes)} of {formatBytes(data.quotaBytes)} · files are
              deleted {data.ttlHours}h after they are written
            </span>
          ) : null
        }
        action={headerActions}
      >
        {error && <div className="ui-form-error">{error}</div>}

        {isLoading && <ListSkeleton rows={4} />}
        {isError && <div className="ui-form-error">Couldn't load your files.</div>}

        {!isLoading && !isError && files.length === 0 && (
          <EmptyState
            message="Nothing here yet. Browser downloads land in this workspace, and anything you upload can be put into a page or handed to another app."
            action={
              <Button onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
                Upload file
              </Button>
            }
          />
        )}

        {visible.map((f) => (
          <ListRow
            key={f.name}
            leading={
              <input
                type="checkbox"
                aria-label={`Select ${f.name}`}
                checked={selected.has(f.name)}
                onChange={() => toggle(f.name)}
              />
            }
            icon={<FileIcon kind={fileKind(f.name)} />}
            title={<FileName name={f.name} />}
            subtitle={`${formatBytes(f.bytes)} · written ${relativeTime(Date.parse(f.mtime) / 1000)}`}
            chips={
              <Badge variant={isUrgent(f.expiresAt) ? "orange" : "neutral"}>{expiryLabel(f.expiresAt)}</Badge>
            }
            actions={
              <>
                <RowActions>
                  <RowAction
                    aria-label={`Download ${f.name}`}
                    onClick={() => void download(f.name)}
                    disabled={busy === f.name}
                  >
                    <DownloadIcon />
                  </RowAction>
                </RowActions>
                <RowActions reveal>
                  <RowAction
                    danger
                    aria-label={`Delete ${f.name}`}
                    onClick={() => undoable.schedule(f.name, f.name)}
                  >
                    Delete
                  </RowAction>
                </RowActions>
              </>
            }
          />
        ))}
      </Box>

      <ConfirmDialog
        open={confirmBulk}
        title={`Delete ${count} ${count === 1 ? "file" : "files"}?`}
        body={`${count} ${count === 1 ? "file" : "files"} will be removed immediately. This cannot be undone.`}
        confirmLabel={bulkBusy ? "Deleting…" : `Delete ${count} ${count === 1 ? "file" : "files"}`}
        destructive
        onCancel={() => {
          if (!bulkBusy) setConfirmBulk(false);
        }}
        onConfirm={() => {
          if (!bulkBusy) void deleteSelected();
        }}
      />
    </>
  );
}
