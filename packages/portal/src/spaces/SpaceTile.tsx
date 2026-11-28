import { Link } from "react-router-dom";
import type { SpaceSummary, SpaceVisibility } from "../spaces-api";
import { relativeTime } from "../format";
import { Badge } from "../components/ui/Badge";
import { DoorOpenIcon, HeartIcon } from "../components/ui/Icons";
import { coverFor, coverInitial } from "./cover";

export const VISIBILITY: Record<SpaceVisibility, { label: string; variant: "neutral" | "blue" | "primary" }> = {
  private: { label: "Private", variant: "neutral" },
  org: { label: "Everyone signed in", variant: "blue" },
  users: { label: "Shared", variant: "primary" },
};

export type TileSize = "large" | "compact";

interface Props {
  space: SpaceSummary;
  size: TileSize;
  isNew: boolean;
  onToggleFavorite: (space: SpaceSummary) => void;
  onOpen: (space: SpaceSummary) => void;
  onEditSharing: (space: SpaceSummary) => void;
}

/** The generated cover, with the Space's initial on it. Decorative: the title is the label. */
export function Cover({ space, showInitial = true }: { space: Pick<SpaceSummary, "name" | "title">; showInitial?: boolean }) {
  const c = coverFor(space.name);
  return (
    <span
      className="space-cover"
      data-pattern={c.pattern}
      aria-hidden="true"
      style={{ ["--cover-from" as string]: c.from, ["--cover-to" as string]: c.to, ["--cover-angle" as string]: `${c.angle}deg` }}
    >
      {showInitial && <span className="space-cover-initial">{coverInitial(space.title)}</span>}
    </span>
  );
}

/** "Delegated" while the Space runs with its owner's connections, "Delegated, paused" while it waits for the owner to confirm. Nothing otherwise. */
export function DelegatedBadge({ space }: { space: SpaceSummary }) {
  if (space.delegation_suspended) return <Badge variant="neutral">Delegated, paused</Badge>;
  return space.delegate_access ? <Badge variant="orange">Delegated</Badge> : null;
}

export function SpaceTile({ space, size, isNew, onToggleFavorite, onOpen, onEditSharing }: Props) {
  const vis = VISIBILITY[space.visibility] ?? VISIBILITY.private;
  // A private Space has no audience to count, and nobody wants "0".
  const showCount = space.favorite_count > 0;
  const used = space.viewers_30d;

  return (
    <article className={`space-tile space-tile-${size}`}>
      <div className="space-tile-cover">
        <Cover space={space} />
        <div className="space-tile-actions">
          {/* Revealed on hover and on focus within the tile, so a keyboard user can reach it. */}
          <Link
            className="space-tile-icon-button space-tile-open"
            to={`/s/${encodeURIComponent(space.name)}`}
            aria-label={`Open ${space.title}`}
            title="Open"
            onClick={(e) => e.stopPropagation()}
          >
            <DoorOpenIcon />
          </Link>
          <button
            type="button"
            className={`space-tile-icon-button space-tile-heart${space.favorited ? " is-on" : ""}`}
            aria-pressed={space.favorited}
            aria-label={`Favorite ${space.title}`}
            title={space.favorited ? "Remove from favorites" : "Add to favorites"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(space);
            }}
          >
            <HeartIcon filled={space.favorited} />
            {showCount && <span className="space-tile-count">{space.favorite_count}</span>}
          </button>
        </div>
      </div>
      <div className="space-tile-body">
        {/* A real button: Enter and Space open the detail, and the title is its name. */}
        <button type="button" className="space-tile-link" aria-haspopup="dialog" onClick={() => onOpen(space)}>
          {space.title}
        </button>
        {space.description && <span className="space-tile-desc">{space.description}</span>}
        <span className="space-tile-meta">
          {space.mine ? "You" : space.ownerEmail} · updated {relativeTime(Math.floor(space.updatedAt / 1000))}
          {used !== undefined && ` · ${used} ${used === 1 ? "person" : "people"} this month`}
        </span>
        <span className="space-tile-badges">
          {isNew && <Badge variant="green">New</Badge>}
          {space.mine && <Badge variant="green">Yours</Badge>}
          {space.mine ? (
            // The owner can change the audience from here: the badge that says who
            // can open it is also the way to change it.
            <button
              type="button"
              className="space-tile-badge-button"
              aria-label={`Change who can open ${space.title}. Now: ${vis.label}`}
              title="Change who can open this"
              onClick={(e) => {
                e.stopPropagation();
                onEditSharing(space);
              }}
            >
              <Badge variant={vis.variant}>{vis.label}</Badge>
            </button>
          ) : (
            <Badge variant={vis.variant}>{vis.label}</Badge>
          )}
          <DelegatedBadge space={space} />
        </span>
      </div>
    </article>
  );
}
