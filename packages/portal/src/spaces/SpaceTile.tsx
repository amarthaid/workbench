import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { SpaceSummary, SpaceVisibility } from "../spaces-api";
import { relativeTime } from "../format";
import { Badge } from "../components/ui/Badge";
import { HeartIcon, MoreIcon } from "../components/ui/Icons";
import { coverFor, coverInitial } from "./cover";

const VISIBILITY: Record<SpaceVisibility, { label: string; variant: "neutral" | "blue" | "primary" }> = {
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
  onEditDetails: (space: SpaceSummary) => void;
  onEditSharing: (space: SpaceSummary) => void;
}

/** The generated cover, with the Space's initial on it. Decorative: the title is the label. */
function Cover({ space }: { space: SpaceSummary }) {
  const c = coverFor(space.name);
  return (
    <span
      className="space-cover"
      data-pattern={c.pattern}
      aria-hidden="true"
      style={{ ["--cover-from" as string]: c.from, ["--cover-to" as string]: c.to, ["--cover-angle" as string]: `${c.angle}deg` }}
    >
      <span className="space-cover-initial">{coverInitial(space.title)}</span>
    </span>
  );
}

function OwnerMenu({ space, onEditDetails, onEditSharing }: Pick<Props, "space" | "onEditDetails" | "onEditSharing">) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="space-tile-menu" ref={ref}>
      <button
        type="button"
        className="space-tile-icon-button"
        aria-label={`Manage ${space.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="space-menu-list space-tile-menu-list" role="menu">
          <button
            type="button"
            role="menuitem"
            className="space-menu-item"
            onClick={() => {
              setOpen(false);
              onEditDetails(space);
            }}
          >
            Edit details
          </button>
          <button
            type="button"
            role="menuitem"
            className="space-menu-item"
            onClick={() => {
              setOpen(false);
              onEditSharing(space);
            }}
          >
            Sharing
          </button>
        </div>
      )}
    </div>
  );
}

export function SpaceTile({ space, size, isNew, onToggleFavorite, onEditDetails, onEditSharing }: Props) {
  const vis = VISIBILITY[space.visibility] ?? VISIBILITY.private;
  // A private Space has no audience to count, and nobody wants "0".
  const showCount = space.favorite_count > 0;
  const used = space.viewers_30d;

  return (
    <article className={`space-tile space-tile-${size}`}>
      <div className="space-tile-cover">
        <Cover space={space} />
        <div className="space-tile-actions">
          <button
            type="button"
            className={`space-tile-icon-button space-tile-heart${space.favorited ? " is-on" : ""}`}
            aria-pressed={space.favorited}
            aria-label={`Favorite ${space.title}`}
            title={space.favorited ? "Remove from favorites" : "Add to favorites"}
            onClick={() => onToggleFavorite(space)}
          >
            <HeartIcon filled={space.favorited} />
            {showCount && <span className="space-tile-count">{space.favorite_count}</span>}
          </button>
          {space.mine && <OwnerMenu space={space} onEditDetails={onEditDetails} onEditSharing={onEditSharing} />}
        </div>
      </div>
      <div className="space-tile-body">
        <Link className="space-tile-link" to={`/s/${encodeURIComponent(space.name)}`}>
          {space.title}
        </Link>
        {space.description && <span className="space-tile-desc">{space.description}</span>}
        <span className="space-tile-meta">
          {space.mine ? "You" : space.ownerEmail} · updated {relativeTime(Math.floor(space.updatedAt / 1000))}
          {used !== undefined && ` · ${used} ${used === 1 ? "person" : "people"} this month`}
        </span>
        <span className="space-tile-badges">
          {isNew && <Badge variant="green">New</Badge>}
          {space.mine && <Badge variant="green">Yours</Badge>}
          <Badge variant={vis.variant}>{vis.label}</Badge>
          {space.delegation_suspended ? (
            <Badge variant="neutral">Delegated, paused</Badge>
          ) : (
            space.delegate_access && <Badge variant="orange">Delegated</Badge>
          )}
        </span>
      </div>
    </article>
  );
}
