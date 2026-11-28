import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSpaces } from "../spaces-api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Segmented } from "../components/ui/Segmented";
import { RequestsModal } from "../spaces/RequestsModal";
import { useSpaceGallery } from "../spaces/useSpaceGallery";
import { Button } from "../components/ui/Button";
import { LARGE_FAVORITES, arrangeSpaces, type SpaceFilter } from "../spaces/arrange";

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
  const { data, isLoading, isError } = useQuery({ queryKey: ["spaces"], queryFn: fetchSpaces });
  const spaces = data ?? [];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SpaceFilter>("all");
  const [requestsOpen, setRequestsOpen] = useState(false);
  // Only an owner's rows carry a count. The chip hides at zero.
  const pendingRequests = spaces.reduce((n, s) => n + (s.mine ? Number(s.pending_requests) || 0 : 0), 0);

  const { tile, modals } = useSpaceGallery(spaces);

  const arranged = useMemo(() => arrangeSpaces(spaces, { query, filter }), [spaces, query, filter]);
  const { favorites, recent, rest } = arranged;
  const shownCount = favorites.length + recent.length + rest.length;

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

      <RequestsModal open={requestsOpen} onClose={() => setRequestsOpen(false)} />
      {modals}
    </>
  );
}
