import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchSpace, type SpaceSummary, type SpaceTool } from "../spaces-api";
import { relativeTime } from "../format";
import { Modal } from "../components/ui/Modal";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { HeartIcon } from "../components/ui/Icons";
import { Cover, VISIBILITY } from "./SpaceTile";
import { DeleteSpaceDialog, openersLine } from "./DeleteSpaceDialog";

interface Props {
  space: SpaceSummary;
  onClose: () => void;
  onToggleFavorite: (space: SpaceSummary) => void;
  onEditDetails: (space: SpaceSummary) => void;
  onEditSharing: (space: SpaceSummary) => void;
  onDeleted: (name: string) => void;
}

function groupByApp(tools: SpaceTool[]): { app: string; names: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const t of tools) {
    const app = t.integrationName || t.integration;
    groups.set(app, [...(groups.get(app) ?? []), t.name]);
  }
  return [...groups].map(([app, names]) => ({ app, names }));
}

/**
 * What the gallery tile does not have room for: the whole title and description,
 * who owns it, what it can do, and (for the owner) the actions. Everything but
 * the tool names comes from the list row, so it shows at once.
 */
export function SpaceDetailModal({ space, onClose, onToggleFavorite, onEditDetails, onEditSharing, onDeleted }: Props) {
  const [deleting, setDeleting] = useState(false);
  const vis = VISIBILITY[space.visibility] ?? VISIBILITY.private;
  const detail = useQuery({ queryKey: ["space", space.name], queryFn: () => fetchSpace(space.name) });
  const groups = detail.data ? groupByApp(detail.data.tools ?? []) : [];
  const opened = space.mine ? openersLine(space.viewers_30d) : null;

  return (
    <>
      <Modal
        open
        size="lg"
        // The delete dialog is on top: Escape and the backdrop belong to it.
        onClose={deleting ? () => {} : onClose}
        className="space-detail-modal"
        title={space.title}
        footer={
          <>
            {space.mine && (
              <>
                <Button variant="outline" onClick={() => onEditDetails(space)}>
                  Edit details
                </Button>
                <Button variant="outline" onClick={() => onEditSharing(space)}>
                  Edit sharing
                </Button>
                <Button variant="outline" className="space-detail-delete" onClick={() => setDeleting(true)}>
                  Delete Space
                </Button>
              </>
            )}
            <Link className="ui-button ui-button-primary ui-button-md" to={`/s/${encodeURIComponent(space.name)}`}>
              Open
            </Link>
          </>
        }
      >
        <div className="space-detail-hero">
          <Cover space={space} />
        </div>
        <div className="space-detail-head">
          <Badge variant={vis.variant}>{vis.label}</Badge>
        </div>
        {space.description && <p className="space-detail-desc">{space.description}</p>}
        <dl className="space-detail-facts">
          <dt>Owner</dt>
          <dd>{space.mine ? "You" : space.ownerEmail}</dd>
          <dt>Updated</dt>
          <dd>{relativeTime(Math.floor(space.updatedAt / 1000))}</dd>
          <dt>Likes</dt>
          <dd>
            <button
              type="button"
              className={`space-detail-heart${space.favorited ? " is-on" : ""}`}
              aria-pressed={space.favorited}
              aria-label={`Favorite ${space.title}`}
              title={space.favorited ? "Remove from favorites" : "Add to favorites"}
              onClick={() => onToggleFavorite(space)}
            >
              <HeartIcon filled={space.favorited} />
              <span>{space.favorite_count}</span>
            </button>
          </dd>
          {opened && (
            <>
              <dt>Opened</dt>
              <dd>{opened}</dd>
            </>
          )}
        </dl>
        <section className="space-detail-tools" aria-label="Tools">
          <h3 className="space-detail-subhead">Tools</h3>
          {detail.isLoading ? (
            <p className="space-muted">Loading tools...</p>
          ) : detail.isError ? (
            <p className="space-muted">Could not load the tools.</p>
          ) : groups.length === 0 ? (
            <p className="space-muted">This Space uses no tools.</p>
          ) : (
            groups.map((g) => (
              <div key={g.app} className="space-detail-app">
                <span className="space-detail-app-name">{g.app}</span>
                <ul className="space-detail-tool-names">
                  {g.names.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      </Modal>
      {deleting && (
        <DeleteSpaceDialog
          space={space}
          sharedWith={detail.data?.users?.length}
          openers={space.mine ? space.viewers_30d : undefined}
          onClose={() => setDeleting(false)}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}
