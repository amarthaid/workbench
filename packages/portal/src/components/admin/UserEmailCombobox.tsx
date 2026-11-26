import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAdminUsers } from "../../api";
import { relativeTime } from "../../format";
import { Badge } from "../ui/Badge";
import { Combobox, type ComboOption } from "../Combobox";

const USERS_STALE_MS = 10 * 60_000;
/** The server caps GET /api/admin/users at this many rows. */
const USERS_CAP = 500;
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+$/;

export interface UserEmailComboboxProps {
  /** The chosen email, or "". */
  value: string;
  onChange: (email: string) => void;
  id?: string;
}

/**
 * Pick the user whose access ran the calls. The list comes from one cached
 * request and is filtered in memory, so typing sends nothing. A full address
 * is accepted with Enter even when it is not in the list (deleted users can
 * still have activity); the server's match stays exact.
 */
export function UserEmailCombobox({ value, onChange, id }: UserEmailComboboxProps) {
  const [q, setQ] = useState("");
  const [wanted, setWanted] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: fetchAdminUsers,
    staleTime: USERS_STALE_MS,
    enabled: wanted,
  });

  const options = useMemo<ComboOption[]>(() => {
    const needle = q.trim().toLowerCase();
    const rows = (data?.users ?? [])
      .filter((u): u is typeof u & { email: string } => !!u.email)
      .filter((u) => !needle || u.email.toLowerCase().includes(needle))
      // An exact address first, so Enter on a typed full address picks it.
      .sort((a, b) => Number(b.email.toLowerCase() === needle) - Number(a.email.toLowerCase() === needle));
    return rows.map((u) => ({
      value: u.email,
      label: u.email,
      badge: u.disabled_at ? <Badge variant="neutral">Disabled</Badge> : undefined,
      meta: u.last_activity ? `last active ${relativeTime(u.last_activity)}` : "no activity",
    }));
  }, [data, q]);

  const truncated = !!data && data.total > USERS_CAP;
  const hint = "Type the full address and press Enter.";

  return (
    <Combobox
      id={id}
      aria-label="User"
      placeholder="Search by email"
      value={value}
      options={options}
      onOpen={() => setWanted(true)}
      onQueryChange={setQ}
      onSelect={(v) => {
        setQ("");
        onChange(v);
      }}
      onClear={() => onChange("")}
      onSubmitText={(text) => {
        const email = text.trim().toLowerCase();
        if (!LOOKS_LIKE_EMAIL.test(email)) return false;
        setQ("");
        onChange(email);
        return true;
      }}
      loading={wanted && isLoading}
      loadingText="Loading users…"
      notice={isError ? `Couldn't load users. ${hint}` : undefined}
      emptyState={
        <>
          Nothing matches{q.trim() ? ` “${q.trim()}”` : ""}. Deleted users can still have activity. {hint}
        </>
      }
      footer={truncated ? `Showing the first ${USERS_CAP} of ${data!.total} users. If yours is missing, ${hint.toLowerCase()}` : undefined}
    />
  );
}
