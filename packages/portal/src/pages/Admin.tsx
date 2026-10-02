import { Navigate, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/ui/PageHeader";
import { Tabs } from "../components/ui/Tabs";
import ActivityCard from "../components/admin/ActivityCard";
import ConfigTab from "../components/admin/ConfigTab";
import ConnectionsCard from "../components/admin/ConnectionsCard";
import CustomAppsCard from "../components/admin/CustomAppsCard";
import FilesTab from "../components/admin/FilesTab";
import OverviewTab from "../components/admin/OverviewTab";
import ProfilesCard from "../components/admin/ProfilesCard";
import UsersTab from "../components/admin/UsersTab";
import VaultTab from "../components/admin/VaultTab";

// One route per tab (/admin, /admin/activity, ...) so each tab is a history
// entry. Only the open tab is mounted, so a view loads when it is opened — the
// browser-profiles card walks every profile on disk and should not run just
// because the admin page was opened.
const TABS = [
  { id: "overview", label: "Overview", path: "/admin", Body: OverviewTab },
  { id: "activity", label: "Activity", path: "/admin/activity", Body: ActivityCard },
  { id: "connections", label: "Connections", path: "/admin/connections", Body: ConnectionsCard },
  { id: "custom-apps", label: "Custom apps", path: "/admin/custom-apps", Body: CustomAppsCard },
  { id: "profiles", label: "Browser profiles", path: "/admin/profiles", Body: ProfilesCard },
  { id: "vault", label: "Vault", path: "/admin/vault", Body: VaultTab },
  { id: "files", label: "Files", path: "/admin/files", Body: FilesTab },
  { id: "users", label: "Users", path: "/admin/users", Body: UsersTab },
  { id: "config", label: "Config", path: "/admin/config", Body: ConfigTab },
];

export default function Admin() {
  const section = useParams()["*"] || "overview";
  const navigate = useNavigate();
  const current = TABS.find((t) => t.id === section);
  // An unknown section is a mistyped URL, not a page.
  if (!current) return <Navigate to="/admin" replace />;
  const { Body } = current;
  return (
    <>
      <PageHeader
        title="Admin"
        toolbar={
          <Tabs
            items={TABS}
            value={current.id}
            onChange={(id) => navigate(TABS.find((t) => t.id === id)!.path)}
            label="Admin sections"
          />
        }
      />
      <div className="wb-section-gap" role="tabpanel" aria-label={current.label}>
        <Body />
      </div>
    </>
  );
}
