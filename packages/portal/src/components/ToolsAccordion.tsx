import { useId, useState } from "react";
import type { SpaceTool } from "../spaces-api";
import { Badge } from "./ui/Badge";
import { Markdown } from "./ui/Markdown";
import { ChevronDownIcon } from "./ui/Icons";
import { effectLabel } from "../spaces/ToolList";

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

/**
 * A comma and a space for the accessible name only. Without it a button's name
 * runs its parts together ("Acme2 reads"). The space is a real text node, which
 * a flex container never paints.
 */
function Sep() {
  return (
    <>
      <span className="ui-sr-only">,</span>{" "}
    </>
  );
}

/** "2 reads", "1 write", "1 delete": one vocabulary for the summary and the app headers. */
function EffectChips({ counts: c, accessible = false }: { counts: Counts; accessible?: boolean }) {
  const sep = accessible ? <Sep /> : null;
  return (
    <span className="space-detail-chips">
      {c.read > 0 && (
        <>
          {sep}
          <Badge variant="blue">{c.read} {c.read === 1 ? "read" : "reads"}</Badge>
        </>
      )}
      {c.write > 0 && (
        <>
          {sep}
          <Badge variant="orange">{c.write} {c.write === 1 ? "write" : "writes"}</Badge>
        </>
      )}
      {c.delete > 0 && (
        <>
          {sep}
          <Badge variant="red">{c.delete} {c.delete === 1 ? "delete" : "deletes"}</Badge>
        </>
      )}
    </span>
  );
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
        <Sep />
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

function AppBox({ app, tools, defaultOpen, baseId, showChips }: { app: string; tools: SpaceTool[]; defaultOpen: boolean; baseId: string; showChips: boolean }) {
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
        {showChips && <EffectChips counts={c} accessible />}
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

export interface ToolsAccordionProps {
  tools: SpaceTool[];
  /**
   * Which apps start open. "auto" opens the first, or all when there are two
   * or fewer apps. "all" and "none" are for the app detail page.
   */
  defaultOpen?: "auto" | "all" | "none";
  /**
   * The list belongs to one app: no app header is drawn, just the summary and
   * the tool rows. When omitted, a single group only drops the header chips.
   */
  singleApp?: boolean;
}

/**
 * Tools grouped by app: a summary of effects, then one box per app whose rows
 * expand to the tool's description and what its effect means.
 */
export function ToolsAccordion({ tools, defaultOpen = "auto", singleApp }: ToolsAccordionProps) {
  const baseId = useId();
  const groups = groupByApp(tools);
  const totals = countEffects(tools);
  const single = singleApp ?? groups.length === 1;
  const openAt = (i: number) => (defaultOpen === "all" ? true : defaultOpen === "none" ? false : i === 0 || groups.length <= 2);
  const summary = (inset: boolean) => (
    <div className={`space-detail-tool-summary${inset ? " is-inset" : ""}`}>
      <EffectChips counts={totals} />
    </div>
  );
  if (singleApp) {
    // One app: its name is already the page or dialog title, so the tools go
    // straight under the summary with no app header.
    return (
      <>
        {summary(true)}
        <ul className="space-detail-tool-list">
          {tools.map((t, i) => (
            <ToolRow key={t.name} tool={t} panelId={`${baseId}-t${i}`} />
          ))}
        </ul>
      </>
    );
  }
  return (
    <>
      {summary(false)}
      {groups.map((g, i) => (
        <AppBox key={g.app} app={g.app} tools={g.tools} defaultOpen={openAt(i)} baseId={`${baseId}-a${i}`} showChips={!single} />
      ))}
    </>
  );
}
