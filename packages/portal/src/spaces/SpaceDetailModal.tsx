import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchSpace, type SpaceSummary } from "../spaces-api";
import { relativeTime } from "../format";
import { Modal } from "../components/ui/Modal";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { ClockIcon, EyeIcon, HeartIcon } from "../components/ui/Icons";
import { Cover, DelegatedBadge, VISIBILITY } from "./SpaceTile";
import { DeleteSpaceDialog } from "./DeleteSpaceDialog";
import { ToolsAccordion } from "../components/ToolsAccordion";

interface Props {
  space: SpaceSummary;
  onClose: () => void;
  onToggleFavorite: (space: SpaceSummary) => void;
  onEditDetails: (space: SpaceSummary) => void;
  onEditSharing: (space: SpaceSummary) => void;
  onDeleted: (name: string) => void;
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
  const allTools = detail.data?.tools ?? [];
  const opened = space.mine && space.viewers_30d !== undefined ? space.viewers_30d : null;

  return (
    <>
      <Modal
        open
        size="lg"
        // The delete dialog is on top: Escape and the backdrop belong to it.
        onClose={deleting ? () => {} : onClose}
        className="space-detail-modal"
        hero={
          <div className="space-detail-hero">
            <Cover space={space} showInitial={false} />
            <div className="space-detail-hero-text">
              <span className="space-detail-chips">
                <Badge variant={vis.variant}>{vis.label}</Badge>
                <DelegatedBadge space={space} />
              </span>
              <h2 className="space-detail-hero-title">{space.title}</h2>
              <p className="space-detail-credit">
                <span className="space-detail-avatar" aria-hidden="true">
                  {(space.ownerEmail.trim().charAt(0) || "?").toUpperCase()}
                </span>
                <span>{space.mine ? "by you" : `by ${space.ownerEmail}`}</span>
              </p>
            </div>
          </div>
        }
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
        <div className="space-detail-facts-line">
          <button
            type="button"
            className={`space-detail-heart${space.favorited ? " is-on" : ""}`}
            aria-pressed={space.favorited}
            aria-label={`Favorite ${space.title}`}
            title={space.favorited ? "Remove from favorites" : "Add to favorites"}
            onClick={() => onToggleFavorite(space)}
          >
            <HeartIcon filled={space.favorited} />
            <span>
              {space.favorite_count} {space.favorite_count === 1 ? "like" : "likes"}
            </span>
          </button>
          {opened !== null && (
            <span className="space-detail-fact">
              <EyeIcon />
              {opened} opened it in 30 days
            </span>
          )}
          <span className="space-detail-fact">
            <ClockIcon />
            Updated {relativeTime(Math.floor(space.updatedAt / 1000))}
          </span>
        </div>
        {space.description && <p className="space-detail-desc">{space.description}</p>}
        <section className="space-detail-tools" aria-label="Tools">
          <h3 className="space-detail-subhead">Tools</h3>
          {detail.isLoading ? (
            <p className="space-muted">Loading tools...</p>
          ) : detail.isError ? (
            <p className="space-muted">Could not load the tools.</p>
          ) : allTools.length === 0 ? (
            <p className="space-muted">This Space uses no tools.</p>
          ) : (
            <ToolsAccordion tools={allTools} />
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
