import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import type { SpaceSummary, SpaceVisibility } from "../spaces-api";
import { relativeTime } from "../format";
import { Badge } from "../components/ui/Badge";
import { DelegateIcon, DelegatePausedIcon, DoorOpenIcon, GlobeIcon, HeartIcon, LockIcon, UsersIcon } from "../components/ui/Icons";
import { coverFor, coverInitial } from "./cover";

type Variant = "neutral" | "blue" | "primary" | "orange";

export const VISIBILITY: Record<SpaceVisibility, { label: string; variant: "neutral" | "blue" | "primary" }> = {
  private: { label: "Private", variant: "neutral" },
  org: { label: "Everyone signed in", variant: "blue" },
  users: { label: "Shared", variant: "primary" },
};

// What each audience looks like as an icon, and what it means in full.
const AUDIENCE: Record<SpaceVisibility, { icon: ReactNode; tip: string }> = {
  private: { icon: <LockIcon />, tip: "Only you can open this" },
  users: { icon: <UsersIcon />, tip: "Shared with specific people" },
  org: { icon: <GlobeIcon />, tip: "Everyone signed in to this workbench can open it" },
};

/** The small square itself, tinted like the Badge of the same variant. Decorative: the caller names it. */
function Glyph({ variant, dashed = false, children }: { variant: Variant; dashed?: boolean; children: ReactNode }) {
  return (
    <span className={`space-indicator ui-badge-${variant}${dashed ? " is-paused" : ""}`}>
      {children}
    </span>
  );
}

/** Who can open the Space, as an icon with a native title. */
export function AudienceIndicator({ space }: { space: SpaceSummary }) {
  const vis = VISIBILITY[space.visibility] ?? VISIBILITY.private;
  const aud = AUDIENCE[space.visibility] ?? AUDIENCE.private;
  return (
    // The native title is the hover text: a custom tooltip is clipped by the dialog's overflow.
    <span role="img" tabIndex={0} aria-label={`Audience: ${vis.label}`} title={aud.tip}>
      <Glyph variant={vis.variant}>{aud.icon}</Glyph>
    </span>
  );
}

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

/** Delegated while the Space runs with its owner's connections; paused while it waits for the owner to confirm. Nothing otherwise. */
export function DelegatedIndicator({ space }: { space: SpaceSummary }) {
  const paused = !!space.delegation_suspended;
  if (!paused && !space.delegate_access) return null;
  const tip = paused
    ? "Delegation is paused until the owner confirms"
    : "Runs with the owner's connections, so viewers need no accounts of their own";
  return (
    <span role="img" tabIndex={0} aria-label={paused ? "Delegated, paused" : "Delegated"} title={tip}>
      <Glyph variant={paused ? "neutral" : "orange"} dashed={paused}>
        {paused ? <DelegatePausedIcon /> : <DelegateIcon />}
      </Glyph>
    </span>
  );
}

export function SpaceTile({ space, size, isNew, onToggleFavorite, onOpen, onEditSharing }: Props) {
  const vis = VISIBILITY[space.visibility] ?? VISIBILITY.private;
  const aud = AUDIENCE[space.visibility] ?? AUDIENCE.private;
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
              <Glyph variant={vis.variant}>{aud.icon}</Glyph>
            </button>
          ) : (
            <AudienceIndicator space={space} />
          )}
          <DelegatedIndicator space={space} />
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
        </span>
      </div>
    </article>
  );
}
