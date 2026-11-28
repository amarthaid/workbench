import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { searchAdminSpaces } from "../admin-spaces-api";
import { Combobox, type ComboOption } from "./Combobox";

export interface LocalSpace {
  name: string;
  title?: string;
  meta?: string;
}

export type SpaceSource = { kind: "local"; spaces: LocalSpace[] } | { kind: "remote" };

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;
const SEARCH_STALE_MS = 10 * 60_000;

export interface SpaceComboboxProps {
  source: SpaceSource;
  /** The chosen Space's name, or "". */
  value: string;
  onChange: (name: string) => void;
  id?: string;
  placeholder?: string;
  "aria-label"?: string;
}

/**
 * Pick one Space. A local source filters a list the page already holds, with
 * no requests. A remote source searches every Space on the server: nothing is
 * sent under two characters, only 250 ms after the last keystroke, a newer
 * keystroke aborts the request in flight, and every query string is cached.
 */
export function SpaceCombobox(props: SpaceComboboxProps) {
  return props.source.kind === "local"
    ? <LocalSpaceCombobox {...props} spaces={props.source.spaces} />
    : <RemoteSpaceCombobox {...props} />;
}

type Rest = Omit<SpaceComboboxProps, "source">;

function LocalSpaceCombobox({ spaces, value, onChange, id, placeholder, ...rest }: Rest & { spaces: LocalSpace[] }) {
  const [q, setQ] = useState("");
  const options = useMemo<ComboOption[]>(() => {
    const needle = q.trim().toLowerCase();
    return spaces
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || (s.title ?? "").toLowerCase().includes(needle))
      .map((s) => ({ value: s.name, label: s.title || s.name, meta: s.meta }));
  }, [spaces, q]);
  const shownName = spaces.find((s) => s.name === value)?.title || value;
  return (
    <Combobox
      id={id}
      aria-label={rest["aria-label"] ?? "Space"}
      placeholder={placeholder ?? "Search your Spaces"}
      value={value}
      displayValue={shownName}
      options={options}
      onQueryChange={setQ}
      onSelect={(v) => {
        setQ("");
        onChange(v);
      }}
      onClear={() => onChange("")}
      emptyState={q.trim() ? "Nothing matches." : "You have no Spaces yet."}
    />
  );
}

function RemoteSpaceCombobox({ value, onChange, id, placeholder, ...rest }: Rest) {
  const [typed, setTyped] = useState("");
  const [settled, setSettled] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef<{ q: string; ctrl: AbortController } | null>(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  function onQueryChange(raw: string) {
    setTyped(raw);
    const q = raw.trim();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // A newer query is about to replace the one in flight: stop it.
      if (inflight.current && inflight.current.q !== q) inflight.current.ctrl.abort();
      setSettled(q);
    }, DEBOUNCE_MS);
  }

  const enabled = settled.length >= MIN_CHARS;
  const { data, isFetching, isError } = useQuery({
    queryKey: ["admin", "spaces", settled],
    enabled,
    staleTime: SEARCH_STALE_MS,
    retry: false,
    queryFn: ({ signal }) => {
      const ctrl = new AbortController();
      signal.addEventListener("abort", () => ctrl.abort());
      inflight.current = { q: settled, ctrl };
      return searchAdminSpaces(settled, ctrl.signal).finally(() => {
        if (inflight.current?.ctrl === ctrl) inflight.current = null;
      });
    },
  });

  // What the person picked, by slug: the box shows its title, the value stays the slug.
  const [picked, setPicked] = useState<{ name: string; title: string } | null>(null);
  const shownName = picked && picked.name === value && picked.title ? picked.title : value;

  const trimmed = typed.trim();
  const short = trimmed.length < MIN_CHARS;
  // Between a keystroke and the settled query, do not show the previous
  // query's rows as if they answered this one.
  const current = !short && settled === trimmed;
  const options = useMemo<ComboOption[]>(
    () =>
      current && data
        ? data.spaces.map((s) => ({
            value: s.name,
            label: s.name,
            meta: s.owner_email ? `owner ${s.owner_email}` : s.title,
          }))
        : [],
    [current, data]
  );

  return (
    <Combobox
      id={id}
      aria-label={rest["aria-label"] ?? "Space"}
      placeholder={placeholder ?? "Search all Spaces"}
      value={value}
      displayValue={shownName}
      options={options}
      onQueryChange={onQueryChange}
      onSelect={(v) => {
        const hit = data?.spaces.find((s) => s.name === v);
        setPicked(hit ? { name: hit.name, title: hit.title } : null);
        clearTimeout(timer.current);
        setTyped("");
        setSettled("");
        onChange(v);
      }}
      onClear={() => onChange("")}
      notice={short ? "Type 2 or more characters to search all Spaces." : isError && current ? "Search failed. Keep typing to retry." : undefined}
      loading={!short && (!current || isFetching)}
      loadingText={`Searching “${trimmed}”…`}
      emptyState={`Nothing matches “${trimmed}”.`}
      footer={
        data && current
          ? data.has_more
            ? `Showing ${data.spaces.length}, more match. Keep typing to narrow.`
            : `Showing ${data.spaces.length}`
          : undefined
      }
    />
  );
}
