import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { redeemConnectLink, ConnectLinkError } from "../api";
import type { RedeemResult } from "../api";
import CdpScreencast from "../components/CdpScreencast";
import ConnectLinkProblem from "../components/ConnectLinkProblem";
import { Modal } from "../components/ui/Modal";

type BrowserInfo = Extract<RedeemResult, { type: "browser" }>;

export default function BrowserView() {
  const [search] = useSearchParams();
  const jwt = search.get("t") ?? "";
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [problem, setProblem] = useState<ConnectLinkError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const redeemed = useRef(false);

  useEffect(() => {
    if (redeemed.current) return;
    redeemed.current = true;
    if (!jwt) { setError("Missing link token."); return; }
    redeemConnectLink(jwt)
      .then((result) => {
        if (result.type === "browser") { setInfo(result); return; }
        setError("Unexpected link type.");
      })
      .catch((e) => {
        if (e instanceof ConnectLinkError) setProblem(e);
        else setError(e instanceof Error ? e.message : "Link failed");
      });
  }, [jwt]);

  if (problem) return <ConnectLinkProblem error={problem} />;
  if (error && !info) {
    return <div className="ui-loading">Error — {error}</div>;
  }
  if (!info) {
    return <div className="ui-loading">Loading browser…</div>;
  }

  return (
    <Modal open onClose={() => {}} title="Browser session" size="xl" dismissible={false}>
      <div className="modal-instructions">
        <div>You are driving the live browser. Close this tab to hand control back to your agent.</div>
      </div>
      <div style={{ padding: 0, background: "#000", marginTop: "var(--s-12)" }}>
        <CdpScreencast cdpProxyUrl={info.cdpProxyUrl} width={1024} />
      </div>
      {error && <div className="ui-form-error" style={{ marginTop: "var(--s-12)" }}>{error}</div>}
    </Modal>
  );
}
