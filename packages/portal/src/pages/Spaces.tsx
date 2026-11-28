import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSpaces, setSpaceFavorite, type SpaceSummary } from "../spaces-api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Segmented } from "../components/ui/Segmented";
import { SpaceDetailModal } from "../spaces/SpaceDetailModal";
import { SpaceTile } from "../spaces/SpaceTile";
import { EditDetailsModal } from "../spaces/EditDetailsModal";
import { SharingModal } from "../spaces/SharingModal";
import { RequestsModal } from "../spaces/RequestsModal";
import { Button } from "../components/ui/Button";
import { LARGE_FAVORITES, arrangeSpaces, isNewForMe, type SpaceFilter } from "../spaces/arrange";

export const EXAMPLE_PROMPT = "Build me a Space that shows my open GitHub and Bitbucket PRs in one timeline";

const FILTERS: { value: SpaceFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "shared", label: "Shared with me" },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-section">
      <div className="space-section-head">
        <h2 className="space-section-title">{title}</h2>
        {hint && <span className="space-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export default function Spaces() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({ queryKey: ["spaces"], queryFn: fetchSpaces });
  const spaces = data ?? [];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SpaceFilter>("all");
  const [editing, setEditing] = useState<SpaceSummary | null>(null);
  const [sharing, setSharing] = useState<SpaceSummary | null>(null);
  const [detailName, setDetailName] = useState<string | null>(null);
  const [requestsOpen, setRequestsOpen] = useState(false);
  // Only an owner's rows carry a count. The chip hides at zero.
  const pendingRequests = spaces.reduce((n, s) => n + (s.mine ? Number(s.pending_requests) || 0 : 0), 0);

  const patchRow = (name: string, patch: Partial<SpaceSummary>) =>
    qc.setQueryData<SpaceSummary[]>(["spaces"], (rows) => rows?.map((r) => (r.name === name ? { ...r, ...patch } : r)));

  // The heart moves at once and settles on what the server says (the count is
  // everyone's, not ours). A failure puts it back.
  const favorite = useMutation({
    mutationFn: (s: SpaceSummary) => setSpaceFavorite(s.name, !s.favorited),
    onMutate: (s) => {
      const before = { favorited: s.favorited, favorite_count: s.favorite_count };
      patchRow(s.name, {
        favorited: !s.favorited,
        favorite_count: Math.max(0, s.favorite_count + (s.favorited ? -1 : 1)),
      });
      return before;
    },
    onError: (_e, s, before) => before && patchRow(s.name, before),
    onSuccess: (res, s) => patchRow(s.name, res),
  });

  // Read from the list on every render, so the heart and a rename show at once,
  // and a Space that left the list closes its own modal.
  const detail = detailName ? spaces.find((s) => s.name === detailName) : undefined;

  const now = Date.now();
  const arranged = useMemo(() => arrangeSpaces(spaces, { query, filter }), [spaces, query, filter]);
  const { favorites, recent, rest } = arranged;
  const shownCount = favorites.length + recent.length + rest.length;

  const tile = (s: SpaceSummary, size: "large" | "compact") => (
    <SpaceTile
      key={s.name}
      space={s}
      size={size}
      isNew={isNewForMe(s, now)}
      onToggleFavorite={(x) => favorite.mutate(x)}
      onOpen={(x) => setDetailName(x.name)}
      onEditSharing={setSharing}
    />
  );

  return (
    <>
      <PageHeader
        title="Spaces"
        toolbar={
          spaces.length > 0 ? (
            <div className="space-toolbar">
              <Input
                type="search"
                className="space-search"
                placeholder="Search Spaces"
                aria-label="Search Spaces"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Segmented label="Show" value={filter} options={FILTERS} onChange={setFilter} />
              {pendingRequests > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-haspopup="dialog"
                  aria-label={`Requests (${pendingRequests}): people asking to open your Spaces`}
                  onClick={() => setRequestsOpen(true)}
                >
                  Requests ({pendingRequests})
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      {isLoading ? (
        <Box>
          <EmptyState message="Loading Spaces..." />
        </Box>
      ) : isError ? (
        <Box>
          <EmptyState message="Could not load Spaces." />
        </Box>
      ) : spaces.length === 0 ? (
        <Box>
          <EmptyState
            message={
              <>
                No Spaces yet. A Space is a small live app that runs on your own connections. You create one by
                asking an agent connected to workbench, for example:
              </>
            }
            action={<p className="space-example-prompt">"{EXAMPLE_PROMPT}"</p>}
          />
        </Box>
      ) : shownCount === 0 ? (
        <Box>
          <EmptyState message="No Space matches that." />
        </Box>
      ) : (
        <div className="space-sections">
          {favorites.length > 0 && (
            <Section title="Favorites">
              <div className="space-grid space-grid-large">
                {favorites.slice(0, LARGE_FAVORITES).map((s) => tile(s, "large"))}
              </div>
              {favorites.length > LARGE_FAVORITES && (
                <div className="space-grid">{favorites.slice(LARGE_FAVORITES).map((s) => tile(s, "compact"))}</div>
              )}
            </Section>
          )}
          {recent.length > 0 && (
            <Section title="Recently opened">
              <div className="space-grid">{recent.map((s) => tile(s, "compact"))}</div>
            </Section>
          )}
          {rest.length > 0 && (
            <Section
              title={favorites.length + recent.length > 0 ? "All Spaces" : "Spaces"}
              hint={favorites.length === 0 && !query && filter === "all" ? "Use the heart to keep the ones you rely on at the top." : undefined}
            >
              <div className="space-grid">{rest.map((s) => tile(s, "compact"))}</div>
            </Section>
          )}
        </div>
      )}

      {detail && !editing && !sharing && (
        <SpaceDetailModal
          space={detail}
          onClose={() => setDetailName(null)}
          onToggleFavorite={(x) => favorite.mutate(x)}
          onEditDetails={(x) => {
            setDetailName(null);
            setEditing(x);
          }}
          onEditSharing={(x) => {
            setDetailName(null);
            setSharing(x);
          }}
          onDeleted={(name) => {
            setDetailName(null);
            qc.setQueryData<SpaceSummary[]>(["spaces"], (rows) => rows?.filter((r) => r.name !== name));
            qc.removeQueries({ queryKey: ["space", name] });
          }}
        />
      )}
      <RequestsModal open={requestsOpen} onClose={() => setRequestsOpen(false)} />
      {editing && (
        <EditDetailsModal
          open
          space={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            patchRow(editing.name, { title: saved.title, description: saved.description });
            qc.setQueryData(["space", editing.name], (d: object | undefined) => (d ? { ...d, title: saved.title, description: saved.description } : d));
          }}
        />
      )}
      {sharing && (
        <SharingModal
          open
          space={sharing}
          onClose={() => setSharing(null)}
          onRequestsDecided={() => void qc.invalidateQueries({ queryKey: ["spaces"] })}
          onSaved={(saved) => {
            patchRow(sharing.name, { visibility: saved.visibility });
            void qc.invalidateQueries({ queryKey: ["spaces"] });
            void qc.invalidateQueries({ queryKey: ["space", sharing.name] });
          }}
        />
      )}
    </>
  );
}
