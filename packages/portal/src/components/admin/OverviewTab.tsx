import FailuresCard from "./FailuresCard";
import InstanceCard from "./InstanceCard";
import StatsCard from "./StatsCard";
import TopToolsCard from "./TopToolsCard";

// Each card loads on its own, so a slow aggregate does not blank the others.
export default function OverviewTab() {
  return (
    <div className="wb-section-gap">
      <StatsCard />
      <TopToolsCard />
      <FailuresCard />
      <InstanceCard />
    </div>
  );
}
