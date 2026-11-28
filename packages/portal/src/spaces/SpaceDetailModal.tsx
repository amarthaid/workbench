import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchSpace, type SpaceSummary } from "../spaces-api";
import { relativeTime } from "../format";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { ClockIcon, DoorOpenIcon, EyeIcon, HeartIcon } from "../components/ui/Icons";
import { AudienceIndicator, Cover, DelegatedIndicator } from "./SpaceTile";
import { DeleteSpaceDialog } from "./DeleteSpaceDialog";
import { EditableDescription, EditableTitle, useDetailsSave, type DetailsSaved } from "./InlineDetails";
import { ToolsAccordion } from "../components/ToolsAccordion";

interface Props {
  space: SpaceSummary;
  onClose: () => void;
  onToggleFavorite: (space: SpaceSummary) => void;
  /** The owner saved a new title or description in place. */
  onDetailsSaved: (name: string, saved: DetailsSaved) => void;
  onEditSharing: (space: SpaceSummary) => void;
  onDeleted: (name: string) => void;
}

/**
 * What the gallery tile does not have room for: the whole title and description,
 * who owns it, what it can do, and (for the owner) the actions. Everything but
 * the tool names comes from the list row, so it shows at once.
 */
export function SpaceDetailModal({ space, onClose, onToggleFavorite, onDetailsSaved, onEditSharing, onDeleted }: Props) {
  const [deleting, setDeleting] = useState(false);
  const details = useDetailsSave(space, (saved) => onDetailsSaved(space.name, saved));
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
        ariaLabel={space.title}
        hero={
          <div className="space-detail-hero">
            <Cover space={space} showInitial={false} />
            <div className="space-detail-hero-text">
              <EditableTitle space={space} editable={space.mine} details={details} />
              <div className="space-detail-hero-row">
                <p className="space-detail-credit">
                  <span className="space-detail-avatar" aria-hidden="true">
                    {(space.ownerEmail.trim().charAt(0) || "?").toUpperCase()}
                  </span>
                  <span>{space.mine ? "by you" : `by ${space.ownerEmail}`}</span>
                </p>
                <div className="space-detail-hero-side">
                  <span className="space-detail-chips">
                    <AudienceIndicator space={space} />
                    <DelegatedIndicator space={space} />
                  </span>
                </div>
              </div>
            </div>
          </div>
        }
        footer={
          <>
            {space.mine && (
              <>
                <Button variant="outline" onClick={() => onEditSharing(space)}>
                  Edit sharing
                </Button>
                <Button variant="outline" className="space-detail-delete" onClick={() => setDeleting(true)}>
                  Delete Space
                </Button>
              </>
            )}
            <Link className="ui-button ui-button-primary ui-button-md space-detail-open" to={`/s/${encodeURIComponent(space.name)}`}>
              <DoorOpenIcon />
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
        <EditableDescription space={space} editable={space.mine} details={details} />
        {space.mine && (
          <p className="space-muted space-detail-hint">
            What it can do (its tools) is set by the agent that built it. If an agent deploys this Space again, it sets the title
            and description again.
          </p>
        )}
        {details.error && (
          <p className="ui-form-error" role="alert">
            {details.error}
          </p>
        )}
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
