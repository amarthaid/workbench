import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchSpaces, type SpaceSummary, type SpaceVisibility } from "../spaces-api";
import { relativeTime } from "../format";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";

export const EXAMPLE_PROMPT = "Build me a Space that shows my open GitHub and Bitbucket PRs in one timeline";

const VISIBILITY: Record<SpaceVisibility, { label: string; variant: "neutral" | "blue" | "primary" }> = {
  private: { label: "Private", variant: "neutral" },
  org: { label: "Organization", variant: "blue" },
  users: { label: "Shared", variant: "primary" },
};

function SpaceCard({ space }: { space: SpaceSummary }) {
  const vis = VISIBILITY[space.visibility] ?? VISIBILITY.private;
  return (
    <div className="wb-app-cell space-gallery-cell">
      <Link className="wb-app-cell-link space-gallery-link" to={`/s/${encodeURIComponent(space.name)}`}>
        <span className="wb-app-cell-text">
          <span className="wb-app-cell-name">{space.title}</span>
          {space.description && <span className="space-gallery-desc">{space.description}</span>}
          <span className="wb-app-cell-meta">
            {space.ownerEmail} · updated {relativeTime(Math.floor(space.updatedAt / 1000))}
          </span>
        </span>
      </Link>
      <span className="wb-app-cell-action space-gallery-badges">
        {space.mine && <Badge variant="green">Yours</Badge>}
        <Badge variant={vis.variant}>{vis.label}</Badge>
      </span>
    </div>
  );
}

export default function Spaces() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["spaces"], queryFn: fetchSpaces });
  const spaces = data ?? [];

  return (
    <>
      <PageHeader title="Spaces" />
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
      ) : (
        <div className="wb-app-grid">
          {spaces.map((s) => (
            <SpaceCard key={s.name} space={s} />
          ))}
        </div>
      )}
    </>
  );
}
