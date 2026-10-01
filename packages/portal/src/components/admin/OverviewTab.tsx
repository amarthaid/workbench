import ActivityCard from "./ActivityCard";
import ConnectionsCard from "./ConnectionsCard";
import CustomAppsCard from "./CustomAppsCard";
import InstanceCard from "./InstanceCard";
import ProfilesCard from "./ProfilesCard";

export default function OverviewTab() {
  return (
    <div className="wb-section-gap">
      <InstanceCard />
      <ActivityCard />
      <ConnectionsCard />
      <CustomAppsCard />
      <ProfilesCard />
    </div>
  );
}
