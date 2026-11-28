import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchAdminSpaces, type AdminSpaceItem } from "../../api";
import { relativeTime } from "../../format";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/Input";
import { Cover } from "../../spaces/SpaceTile";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";
import "./spaces-tab.css";

// Same floor as the Space picker: one letter matches too much to be worth a request.
const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

function audience(s: AdminSpaceItem): string {
  if (s.visibility === "org") return "Everyone signed in";
  if (s.visibility === "users") return `Specific people (${s.share_count})`;
  return "Only me";
}

const ago = (ms: number) => relativeTime(Math.floor(ms / 1000));

function SpaceCard({ space }: { space: AdminSpaceItem }) {
  const [open, setOpen] = useState(false);
  const n = space.openers_30d;
  const more = n - space.openers.length;
  const summary = n === 0 ? "No one opened it in 30 days" : `${n} ${n === 1 ? "person" : "people"} opened it in 30 days`;
  return (
    <article className="admin-space">
      <div className="admin-space-cover">
        <Cover space={space} />
      </div>
      <div className="admin-space-body">
      <header className="admin-space-head">
        <h3 className="admin-space-title">{space.title}</h3>
        <code className="admin-space-name">{space.name}</code>
      </header>
      <div className="admin-space-meta">
        <span>{space.owner_email ?? "No owner"}</span>
        <Badge variant="neutral">{audience(space)}</Badge>
        <span>updated {ago(space.updated_at)}</span>
      </div>
      {space.description && <p className="admin-space-desc">{space.description}</p>}
      <div className="admin-space-foot">
        <span>{space.favorite_count} {space.favorite_count === 1 ? "like" : "likes"}</span>
        {n === 0 ? (
          <span>{summary}</span>
        ) : (
          <button
            type="button"
            className="admin-space-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {summary}
          </button>
        )}
      </div>
      {open && (
        <ul className="admin-space-openers" aria-label={`People who opened ${space.title}`}>
          {space.openers.map((o) => (
            <li key={o.email}>
              <span>{o.email}</span>
              <span className="admin-space-when">{ago(o.last_opened_at)}</span>
            </li>
          ))}
          {more > 0 && <li className="admin-space-when">and {more} more</li>}
        </ul>
      )}
      </div>
    </article>
  );
}

// Read only. The server pages by keyset cursor, so a page is one cheap request
// however many Spaces exist; the search box narrows by name or title.
export default function SpacesTab() {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = typed.trim();
    // Under the floor means the full list, like clearing the box.
    const next = t.length >= MIN_CHARS ? t : "";
    const id = setTimeout(() => setQ(next), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [typed]);

  const query = useInfiniteQuery({
    queryKey: ["admin", "spaces", "list", q],
    queryFn: ({ pageParam }) => fetchAdminSpaces({ q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.has_more ? (last.next_cursor ?? undefined) : undefined),
    staleTime: ADMIN_STALE_MS,
  });

  const spaces = query.data?.pages.flatMap((p) => p.spaces) ?? [];

  return (
    <div className="wb-section-gap">
      <div className="admin-spaces-bar">
        <Input
          type="search"
          aria-label="Search Spaces"
          placeholder="Search by name or title"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      <CardBody isLoading={query.isLoading} isError={query.isError} label="Spaces">
        {spaces.length === 0 ? (
          <EmptyState message={q ? "No Space matches this search." : "No Spaces yet."} />
        ) : (
          <div className="admin-spaces-grid">
            {spaces.map((s) => <SpaceCard key={s.name} space={s} />)}
          </div>
        )}
        {query.hasNextPage && (
          <div className="admin-spaces-more">
            <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </CardBody>
    </div>
  );
}
