import { useState } from "react";
import { PageHeader } from "../components/ui/PageHeader";
import { Tabs } from "../components/ui/Tabs";
import OverviewTab from "../components/admin/OverviewTab";
import UsersTab from "../components/admin/UsersTab";
import ConfigTab from "../components/admin/ConfigTab";

// One page, one tab per admin concern.
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "config", label: "Config" },
];

export default function Admin() {
  const [tab, setTab] = useState("overview");
  return (
    <>
      <PageHeader title="Admin" toolbar={<Tabs items={TABS} value={tab} onChange={setTab} label="Admin sections" />} />
      {tab === "overview" && <OverviewTab />}
      {tab === "users" && <UsersTab />}
      {tab === "config" && <ConfigTab />}
    </>
  );
}
