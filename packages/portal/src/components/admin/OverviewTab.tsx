import { useState } from "react";
import { Tabs } from "../ui/Tabs";
import ActivityCard from "./ActivityCard";
import ConnectionsCard from "./ConnectionsCard";
import CustomAppsCard from "./CustomAppsCard";
import InstanceCard from "./InstanceCard";
import ProfilesCard from "./ProfilesCard";

// The instance summary is always on screen; the detail views are tabs. Only the
// open view is mounted, so a view loads when it is opened — the browser-profiles
// card walks every profile on disk and should not run just because the Overview
// was opened.
const VIEWS = [
  { id: "activity", label: "Activity" },
  { id: "connections", label: "Connections" },
  { id: "custom-apps", label: "Custom apps" },
  { id: "profiles", label: "Browser profiles" },
];

export default function OverviewTab() {
  const [view, setView] = useState("activity");
  return (
    <div className="wb-section-gap">
      <InstanceCard />
      <div className="wb-page-toolbar">
        <Tabs items={VIEWS} value={view} onChange={setView} label="Overview details" />
      </div>
      <div role="tabpanel" aria-label={VIEWS.find((v) => v.id === view)?.label}>
        {view === "activity" && <ActivityCard />}
        {view === "connections" && <ConnectionsCard />}
        {view === "custom-apps" && <CustomAppsCard />}
        {view === "profiles" && <ProfilesCard />}
      </div>
    </div>
  );
}
