import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setSpaceFavorite, type SpaceSummary } from "../spaces-api";
import { SpaceDetailModal } from "./SpaceDetailModal";
import { SpaceTile, type TileSize } from "./SpaceTile";
import { EditDetailsModal } from "./EditDetailsModal";
import { SharingModal } from "./SharingModal";
import { isNewForMe } from "./arrange";

/**
 * Everything a page needs to show Space tiles that work: the tile itself, the
 * favorite heart (optimistic, settles on the server's answer), and the detail,
 * edit and sharing modals the tile opens. The Spaces page and Home both use it,
 * over the same `["spaces"]` list.
 */
export function useSpaceGallery(spaces: SpaceSummary[]): {
  tile: (s: SpaceSummary, size: TileSize) => ReactNode;
  modals: ReactNode;
} {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SpaceSummary | null>(null);
  const [sharing, setSharing] = useState<SpaceSummary | null>(null);
  const [detailName, setDetailName] = useState<string | null>(null);

  const patchRow = (name: string, patch: Partial<SpaceSummary>) =>
    qc.setQueryData<SpaceSummary[]>(["spaces"], (rows) => rows?.map((r) => (r.name === name ? { ...r, ...patch } : r)));

  // The heart moves at once and settles on what the server says (the count is
  // everyone's, not ours). A failure puts it back.
  const favorite = useMutation({
    mutationFn: (s: SpaceSummary) => setSpaceFavorite(s.name, !s.favorited),
    onMutate: (s) => {
      const before = { favorited: s.favorited, favorite_count: s.favorite_count };
      patchRow(s.name, {
        favorited: !s.favorited,
        favorite_count: Math.max(0, s.favorite_count + (s.favorited ? -1 : 1)),
      });
      return before;
    },
    onError: (_e, s, before) => before && patchRow(s.name, before),
    onSuccess: (res, s) => patchRow(s.name, res),
  });

  // Read from the list on every render, so the heart and a rename show at once,
  // and a Space that left the list closes its own modal.
  const detail = detailName ? spaces.find((s) => s.name === detailName) : undefined;
  const now = Date.now();

  const tile = (s: SpaceSummary, size: TileSize) => (
    <SpaceTile
      key={s.name}
      space={s}
      size={size}
      isNew={isNewForMe(s, now)}
      onToggleFavorite={(x) => favorite.mutate(x)}
      onOpen={(x) => setDetailName(x.name)}
      onEditSharing={setSharing}
    />
  );

  const modals = (
    <>
      {detail && !editing && !sharing && (
        <SpaceDetailModal
          space={detail}
          onClose={() => setDetailName(null)}
          onToggleFavorite={(x) => favorite.mutate(x)}
          onEditDetails={(x) => {
            setDetailName(null);
            setEditing(x);
          }}
          onEditSharing={(x) => {
            setDetailName(null);
            setSharing(x);
          }}
          onDeleted={(name) => {
            setDetailName(null);
            qc.setQueryData<SpaceSummary[]>(["spaces"], (rows) => rows?.filter((r) => r.name !== name));
            qc.removeQueries({ queryKey: ["space", name] });
          }}
        />
      )}
      {editing && (
        <EditDetailsModal
          open
          space={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            patchRow(editing.name, { title: saved.title, description: saved.description });
            qc.setQueryData(["space", editing.name], (d: object | undefined) => (d ? { ...d, title: saved.title, description: saved.description } : d));
          }}
        />
      )}
      {sharing && (
        <SharingModal
          open
          space={sharing}
          onClose={() => setSharing(null)}
          onRequestsDecided={() => void qc.invalidateQueries({ queryKey: ["spaces"] })}
          onSaved={(saved) => {
            patchRow(sharing.name, { visibility: saved.visibility });
            void qc.invalidateQueries({ queryKey: ["spaces"] });
            void qc.invalidateQueries({ queryKey: ["space", sharing.name] });
          }}
        />
      )}
    </>
  );

  return { tile, modals };
}
