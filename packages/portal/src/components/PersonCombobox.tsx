import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchActivityPeople } from "../api";
import { Combobox, type ComboOption } from "./Combobox";

const PEOPLE_STALE_MS = 10 * 60_000;

export interface PersonComboboxProps {
  /** The date range the suggestions cover; part of the cache key. */
  since?: number;
  until?: number;
  /** The chosen person's email, or "". */
  value: string;
  onChange: (email: string) => void;
  id?: string;
}

/**
 * The other parties on the viewer's delegated calls. One request per date
 * range, then filtered in memory: typing never reaches the network.
 */
export function PersonCombobox({ since, until, value, onChange, id }: PersonComboboxProps) {
  const [q, setQ] = useState("");
  const [wanted, setWanted] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["activity", "people", since, until],
    queryFn: () => fetchActivityPeople({ since, until }),
    staleTime: PEOPLE_STALE_MS,
    enabled: wanted,
  });

  const options = useMemo<ComboOption[]>(() => {
    const needle = q.trim().toLowerCase();
    return (data?.people ?? [])
      .filter((p) => !needle || p.email.toLowerCase().includes(needle))
      .map((p) => ({ value: p.email, label: p.email, meta: `${p.count} ${p.count === 1 ? "call" : "calls"}` }));
  }, [data, q]);

  return (
    <Combobox
      id={id}
      aria-label="Person"
      placeholder="People on delegated calls"
      value={value}
      options={options}
      onOpen={() => setWanted(true)}
      onQueryChange={setQ}
      onSelect={(v) => {
        setQ("");
        onChange(v);
      }}
      onClear={() => onChange("")}
      loading={wanted && isLoading}
      loadingText="Loading people…"
      notice={isError ? "Couldn't load people." : undefined}
      emptyState={q.trim() ? "Nothing matches." : "No delegated calls in this date range."}
    />
  );
}
