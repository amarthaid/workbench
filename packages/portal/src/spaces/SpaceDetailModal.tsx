import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchSpace, type SpaceSummary, type SpaceTool } from "../spaces-api";
import { relativeTime } from "../format";
import { Modal } from "../components/ui/Modal";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Markdown } from "../components/ui/Markdown";
import { ChevronDownIcon, ClockIcon, EyeIcon, HeartIcon } from "../components/ui/Icons";
import { Cover, VISIBILITY } from "./SpaceTile";
import { DeleteSpaceDialog } from "./DeleteSpaceDialog";
import { effectLabel } from "./ToolList";

interface Props {
  space: SpaceSummary;
  onClose: () => void;
  onToggleFavorite: (space: SpaceSummary) => void;
  onEditDetails: (space: SpaceSummary) => void;
  onEditSharing: (space: SpaceSummary) => void;
  onDeleted: (name: string) => void;
}

const EFFECT_SENTENCE: Record<string, string> = {
  Reads: "Only reads data. Never changes anything.",
  Writes: "Changes data in the connected app.",
  "Deletes or changes": "Can delete or overwrite data.",
};

interface Counts {
  read: number;
  write: number;
  delete: number;
}

function countEffects(tools: SpaceTool[]): Counts {
  const c: Counts = { read: 0, write: 0, delete: 0 };
  for (const t of tools) {
    if (t.missing) continue;
    const label = effectLabel(t).label;
    if (label === "Reads") c.read++;
    else if (label === "Writes") c.write++;
    else c.delete++;
  }
  return c;
}

function ToolRow({ tool, panelId }: { tool: SpaceTool; panelId: string }) {
  const [open, setOpen] = useState(false);
  const effect = effectLabel(tool);
  if (tool.missing) {
    return (
      <li className="space-detail-tool">
        <div className="space-detail-tool-head is-static">
          <span className="space-detail-tool-chevron" aria-hidden="true" />
          <span className="wb-mono space-detail-tool-name">{tool.name}</span>
          <Badge variant="neutral">Missing</Badge>
        </div>
      </li>
    );
  }
  return (
    <li className="space-detail-tool">
      <button type="button" className="space-detail-tool-head" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
        <span className={`space-detail-tool-chevron${open ? " is-open" : ""}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
        <span className="wb-mono space-detail-tool-name">{tool.name}</span>
        <Badge variant={effect.variant}>{effect.label}</Badge>
      </button>
      {open && (
        <div id={panelId} className="space-detail-tool-panel">
          {tool.description?.trim() && (
            <div className="space-detail-tool-text">
              <Markdown>{tool.description}</Markdown>
            </div>
          )}
          <p className="space-detail-tool-effect">{EFFECT_SENTENCE[effect.label]}</p>
        </div>
      )}
    </li>
  );
}

function AppBox({ app, tools, defaultOpen, baseId }: { app: string; tools: SpaceTool[]; defaultOpen: boolean; baseId: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const c = countEffects(tools);
  const bodyId = `${baseId}-body`;
  return (
    <div className="ui-box space-detail-app">
      <button type="button" className="space-detail-app-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <span className={`space-detail-tool-chevron${open ? " is-open" : ""}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
        <span className="space-detail-app-name">{app}</span>
        <span className="space-detail-chips">
          {c.read > 0 && <Badge variant="blue">{c.read} {c.read === 1 ? "read" : "reads"}</Badge>}
          {c.write > 0 && <Badge variant="orange">{c.write} {c.write === 1 ? "write" : "writes"}</Badge>}
          {c.delete > 0 && <Badge variant="red">{c.delete} {c.delete === 1 ? "delete" : "deletes"}</Badge>}
        </span>
      </button>
      {open && (
        <ul id={bodyId} className="space-detail-tool-list">
          {tools.map((t, i) => (
            <ToolRow key={t.name} tool={t} panelId={`${baseId}-t${i}`} />
          ))}
        </ul>
      )}
    </div>
  );
}

function groupByApp(tools: SpaceTool[]): { app: string; tools: SpaceTool[] }[] {
  const groups = new Map<string, SpaceTool[]>();
  for (const t of tools) {
    const app = t.integrationName || t.integration;
    groups.set(app, [...(groups.get(app) ?? []), t]);
  }
  return [...groups].map(([app, list]) => ({ app, tools: list }));
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
  const baseId = useId();
  const allTools = detail.data?.tools ?? [];
  const groups = groupByApp(allTools);
  const totals = countEffects(allTools);
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
              <Badge variant={vis.variant}>{vis.label}</Badge>
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
        {space.description && <p className="space-detail-desc">{space.description}</p>}
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
        <section className="space-detail-tools" aria-label="Tools">
          <h3 className="space-detail-subhead">Tools</h3>
          {detail.isLoading ? (
            <p className="space-muted">Loading tools...</p>
          ) : detail.isError ? (
            <p className="space-muted">Could not load the tools.</p>
          ) : allTools.length === 0 ? (
            <p className="space-muted">This Space uses no tools.</p>
          ) : (
            <>
              <div className="space-detail-tool-summary">
                {totals.read > 0 && <Badge variant="blue">{totals.read} read</Badge>}
                {totals.write > 0 && <Badge variant="orange">{totals.write} write</Badge>}
                {totals.delete > 0 && <Badge variant="red">{totals.delete} delete</Badge>}
              </div>
              {groups.map((g, i) => (
                <AppBox key={g.app} app={g.app} tools={g.tools} defaultOpen={i === 0 || groups.length <= 2} baseId={`${baseId}-a${i}`} />
              ))}
            </>
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
