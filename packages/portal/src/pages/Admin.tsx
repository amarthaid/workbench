import { useState } from "react";
import { PageHeader } from "../components/ui/PageHeader";
import { Tabs } from "../components/ui/Tabs";
import { EmptyState } from "../components/ui/EmptyState";

// One page, one tab per admin concern. Later sub-projects append to TABS
// (Users, Config) and render their panel below.
const TABS = [{ id: "overview", label: "Overview" }];

export default function Admin() {
  const [tab, setTab] = useState("overview");
  return (
    <>
      <PageHeader title="Admin" toolbar={<Tabs items={TABS} value={tab} onChange={setTab} label="Admin sections" />} />
      {tab === "overview" && <EmptyState message="Nothing to show here yet." />}
    </>
  );
}
