import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ActivityAuth, ActivityFilterOpts } from "../api";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Select } from "./ui/Input";
import { Tabs } from "./ui/Tabs";
import "./activity-filters.css";

export type DateRange = "24h" | "7d" | "30d" | "custom";

/** What the page has applied. Changing it is what changes the query. */
export interface AppliedFilters {
  status: "all" | "error";
  range: DateRange;
  /** Custom range, local dates as yyyy-mm-dd. */
  customFrom: string;
  customTo: string;
  /** Unix seconds, fixed when the range was chosen so the query key is stable. */
  since: number;
  until?: number;
  /** "" means any. */
  integration: string;
  space: string;
  /** Personal page: the other party on a delegated call. */
  person: string;
  /** Admin page: the user whose access ran the call. */
  user: string;
  auth: ActivityAuth | "";
  delegated: boolean;
}

const DAY = 86400;
export const MAX_RANGE_DAYS = 90;

const RANGE_SECONDS: Record<Exclude<DateRange, "custom">, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
const RANGE_LABEL: Record<DateRange, string> = { "24h": "24 h", "7d": "7 days", "30d": "30 days", custom: "Custom" };
const RANGE_CHIP: Record<Exclude<DateRange, "custom">, string> = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" };

export const AUTH_LABELS: Record<ActivityAuth, string> = {
  api_key: "API key",
  oauth: "OAuth",
  session: "Portal",
  curl_token: "Curl token",
  space: "Space",
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function defaultFilters(now: number = nowSeconds()): AppliedFilters {
  return {
    status: "all",
    range: "7d",
    customFrom: "",
    customTo: "",
    since: now - RANGE_SECONDS["7d"],
    integration: "",
    space: "",
    person: "",
    user: "",
    auth: "",
    delegated: false,
  };
}

/** Start of a local yyyy-mm-dd day, as unix seconds; NaN when not a date. */
function dayStart(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() / 1000);
}

/** The since/until a range means right now. Custom needs both dates. */
export function resolveRange(
  range: DateRange,
  customFrom: string,
  customTo: string,
  now: number = nowSeconds()
): { since: number; until?: number } | null {
  if (range !== "custom") return { since: now - RANGE_SECONDS[range] };
  const from = dayStart(customFrom);
  const to = dayStart(customTo);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return { since: from, until: to + DAY - 1 };
}

/** Why a custom range cannot be applied, or null when it can. */
export function customRangeError(customFrom: string, customTo: string): string | null {
  const r = resolveRange("custom", customFrom, customTo);
  if (!r) return null;
  if (r.until! < r.since) return "The end date is before the start date.";
  if (r.until! - r.since > MAX_RANGE_DAYS * DAY) return `A range is limited to ${MAX_RANGE_DAYS} days.`;
  return null;
}

export function countActiveFilters(f: AppliedFilters): number {
  return [f.integration, f.space, f.person, f.user, f.auth].filter(Boolean).length + (f.delegated ? 1 : 0);
}

export type ActivityQueryOpts = ActivityFilterOpts & {
  status?: "error";
  integration?: string;
  /** Personal page. */
  person?: string;
  /** Admin page. */
  email?: string;
};

/**
 * Applied filters as the options of fetchActivity (`personal`) or
 * fetchAdminActivity (`admin`). Paging (`limit`, `cursor`) is the caller's.
 */
export function filtersToOpts(f: AppliedFilters, mode: "personal" | "admin"): ActivityQueryOpts {
  return {
    since: f.since,
    ...(f.until !== undefined ? { until: f.until } : {}),
    ...(f.status === "error" ? { status: "error" as const } : {}),
    ...(f.integration ? { integration: f.integration } : {}),
    ...(f.space ? { space: f.space } : {}),
    ...(f.auth ? { auth: f.auth } : {}),
    ...(f.delegated ? { delegated: true } : {}),
    ...(mode === "personal" && f.person ? { person: f.person } : {}),
    ...(mode === "admin" && f.user ? { email: f.user } : {}),
  };
}

export interface FieldSlot {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

export interface ActivityFiltersProps {
  value: AppliedFilters;
  /** One call per committed change: a tab, a range, Apply, a chip. */
  onChange: (next: AppliedFilters) => void;
  integrations: { name: string; label: string }[];
  /** The Space field, usually a SpaceCombobox. */
  spaceField: (slot: FieldSlot) => ReactNode;
  /** The Person (personal page) or User (admin page) field. */
  partyField: { kind: "person" | "user"; render: (slot: FieldSlot) => ReactNode };
  /** Clock for the range, injectable for tests. Unix seconds. */
  now?: () => number;
}

type Draft = Pick<AppliedFilters, "integration" | "space" | "person" | "user" | "auth" | "delegated">;

function toDraft(f: AppliedFilters): Draft {
  return { integration: f.integration, space: f.space, person: f.person, user: f.user, auth: f.auth, delegated: f.delegated };
}

const EMPTY_DRAFT: Draft = { integration: "", space: "", person: "", user: "", auth: "", delegated: false };

export function ActivityFilters({ value, onChange, integrations, spaceField, partyField, now = nowSeconds }: ActivityFiltersProps) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(value));
  const [customMode, setCustomMode] = useState(value.range === "custom");
  const [from, setFrom] = useState(value.customFrom);
  const [to, setTo] = useState(value.customTo);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLSelectElement>(null);

  const active = countActiveFilters(value);
  const party = partyField.kind;

  function openPopover() {
    setDraft(toDraft(value));
    setOpen(true);
  }

  function closePopover() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  useEffect(() => {
    if (open) firstRef.current?.focus();
  }, [open]);

  // Esc and a click outside discard the draft. A combobox with its list open
  // stops the Esc first, so this only sees one meant for the popover.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePopover();
    }
    function onDown(e: MouseEvent) {
      const wrap = wrapRef.current;
      if (!wrap) return;
      // Picking a suggestion re-renders and removes the clicked option before
      // this runs, so `contains(target)` is false for a click that was inside.
      // The event path was fixed at dispatch and still names the wrapper.
      if (!e.composedPath().includes(wrap)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  function commitRange(range: DateRange, customFrom = value.customFrom, customTo = value.customTo) {
    const r = resolveRange(range, customFrom, customTo, now());
    if (!r) return;
    onChange({ ...value, range, customFrom, customTo, since: r.since, until: r.until });
  }

  function pickRange(range: DateRange) {
    if (range === "custom") {
      setCustomMode(true);
      if (from && to && !customRangeError(from, to)) commitRange("custom", from, to);
      return;
    }
    setCustomMode(false);
    commitRange(range);
  }

  function editCustom(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
    if (nextFrom && nextTo && !customRangeError(nextFrom, nextTo)) commitRange("custom", nextFrom, nextTo);
  }

  function apply() {
    onChange({ ...value, ...draft, delegated: draft.delegated || (party === "person" && !!draft.person) });
    closePopover();
  }

  function setField<K extends keyof Draft>(key: K, v: Draft[K]) {
    setDraft((d) => ({
      ...d,
      [key]: v,
      // Picking a person only makes sense among delegated calls.
      ...(key === "person" && v ? { delegated: true } : {}),
    }));
  }

  function clear(key: keyof Draft) {
    onChange({ ...value, [key]: key === "delegated" ? false : "" });
  }

  const shownRange: DateRange = customMode ? "custom" : value.range;
  const rangeError = customMode ? customRangeError(from, to) : null;
  const rangeChip =
    value.range === "custom"
      ? `${value.customFrom} to ${value.customTo}`
      : RANGE_CHIP[value.range];

  const chips: { key: keyof Draft; text: string }[] = [];
  if (value.delegated) chips.push({ key: "delegated", text: "Delegated only" });
  if (value.integration) {
    chips.push({ key: "integration", text: `App: ${integrations.find((i) => i.name === value.integration)?.label ?? value.integration}` });
  }
  if (value.space) chips.push({ key: "space", text: `Space: ${value.space}` });
  if (value.user) chips.push({ key: "user", text: `User: ${value.user}` });
  if (value.person) chips.push({ key: "person", text: `Person: ${value.person}` });
  if (value.auth) chips.push({ key: "auth", text: `Credential: ${AUTH_LABELS[value.auth]}` });

  const slot = (key: "space" | "person" | "user"): FieldSlot => ({
    id: `${uid}-${key}`,
    value: draft[key],
    onChange: (v) => setField(key, v),
  });

  return (
    <>
      <div className="af-bar">
        <Tabs
          label="Filter activity"
          value={value.status}
          onChange={(id) => onChange({ ...value, status: id as "all" | "error" })}
          items={[{ id: "all", label: "All" }, { id: "error", label: "Errors" }]}
        />
        <div className="af-range" role="group" aria-label="Date range">
          {(Object.keys(RANGE_LABEL) as DateRange[]).map((r) => (
            <Button
              key={r}
              variant="outline"
              size="sm"
              className={shownRange === r ? "is-on" : undefined}
              aria-pressed={shownRange === r}
              onClick={() => pickRange(r)}
            >
              {RANGE_LABEL[r]}
            </Button>
          ))}
        </div>
        {customMode && (
          <div className="af-custom">
            <label className="ui-sr-only" htmlFor={`${uid}-from`}>From date</label>
            <input id={`${uid}-from`} className="ui-input" type="date" value={from} max={to || undefined} onChange={(e) => editCustom(e.target.value, to)} />
            <span aria-hidden>to</span>
            <label className="ui-sr-only" htmlFor={`${uid}-to`}>To date</label>
            <input id={`${uid}-to`} className="ui-input" type="date" value={to} min={from || undefined} onChange={(e) => editCustom(from, e.target.value)} />
            {rangeError && <span className="af-custom-error" role="alert">{rangeError}</span>}
          </div>
        )}

        <div className="af-popwrap" ref={wrapRef}>
          <button
            ref={buttonRef}
            type="button"
            className="ui-button ui-button-outline ui-button-sm"
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => (open ? closePopover() : openPopover())}
          >
            Filters{active > 0 && <> <Badge variant="neutral">{active}</Badge></>}
          </button>
          {open && (
            <div className="af-pop" role="dialog" aria-label="Filters">
              <div className="af-pop-body">
                <h3>Filters</h3>
                <div className="af-field">
                  <label className="af-lab" htmlFor={`${uid}-app`}>App</label>
                  <select
                    id={`${uid}-app`}
                    ref={firstRef}
                    className="ui-input"
                    value={draft.integration}
                    onChange={(e) => setField("integration", e.target.value)}
                  >
                    <option value="">All apps</option>
                    {integrations.map((i) => <option key={i.name} value={i.name}>{i.label}</option>)}
                  </select>
                </div>
                <div className="af-field">
                  <label className="af-lab" htmlFor={`${uid}-space`}>Space</label>
                  {spaceField(slot("space"))}
                </div>
                <div className="af-field">
                  <label className="af-lab" htmlFor={`${uid}-${party}`}>{party === "person" ? "Person" : "User"}</label>
                  {partyField.render(slot(party))}
                </div>
                <div className="af-field">
                  <label className="af-lab" htmlFor={`${uid}-auth`}>Credential</label>
                  <Select id={`${uid}-auth`} value={draft.auth} onChange={(e) => setField("auth", e.target.value as ActivityAuth | "")}>
                    <option value="">Any</option>
                    {(Object.keys(AUTH_LABELS) as ActivityAuth[]).map((a) => <option key={a} value={a}>{AUTH_LABELS[a]}</option>)}
                  </Select>
                </div>
                <label className="af-check">
                  <input type="checkbox" checked={draft.delegated} onChange={(e) => setField("delegated", e.target.checked)} />
                  Delegated calls only
                </label>
              </div>
              <div className="af-pop-foot">
                <Button variant="ghost" size="sm" onClick={() => setDraft(EMPTY_DRAFT)}>Reset</Button>
                <span className="af-sub">Nothing is requested until Apply</span>
                <Button size="sm" onClick={apply}>Apply</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="af-applied">
        <span>Showing:</span>
        <span className="af-chip">{rangeChip}</span>
        {chips.map((c) => (
          <span className="af-chip" key={c.key}>
            {c.text}
            <button type="button" aria-label={`Clear ${c.text}`} onClick={() => clear(c.key)}>×</button>
          </span>
        ))}
        {active > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onChange({ ...value, ...EMPTY_DRAFT })}
          >
            Clear all
          </Button>
        )}
      </div>
    </>
  );
}
