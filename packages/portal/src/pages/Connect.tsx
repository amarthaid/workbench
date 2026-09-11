import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchIntegrations, redeemConnectLink, connectCapture, ConnectLinkError } from "../api";
import type { RedeemResult, IntegrationSummary } from "../api";
import CdpScreencast from "../components/CdpScreencast";
import ConnectLinkProblem from "../components/ConnectLinkProblem";
import { ConnectPair } from "../components/ConnectPair";
import { BrandLockup } from "../components/BrandMark";
import IntegrationLogo from "../components/IntegrationLogo";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";

type CookieInfo = Extract<RedeemResult, { type: "cookie" }>;

export default function Connect() {
  const { integration = "" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const jwt = search.get("t") ?? "";

  const [info, setInfo] = useState<CookieInfo | null>(null);
  const [problem, setProblem] = useState<ConnectLinkError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [starting, setStarting] = useState(false);

  // Named from the registry, not from the link: the token is an opaque claim
  // until the server has verified it, so nothing inside it drives what the
  // human is shown.
  const { data } = useQuery<{ integrations: IntegrationSummary[] }>({
    queryKey: ["integrations"],
    queryFn: fetchIntegrations,
  });
  const integ = useMemo(
    () => data?.integrations.find((i) => i.name === integration),
    [data, integration]
  );
  const label = integ?.displayName || integration;

  // Redeeming consumes the link, so it waits for an explicit accept. Doing it
  // on mount meant opening the tab and closing it burned the link for good.
  async function handleStart() {
    setStarting(true);
    setError(null);
    // Set before the handoff: the provider round trip leaves the SPA entirely,
    // and the result page reads this to know it is talking to someone whose
    // agent sent them here.
    sessionStorage.setItem("awb_connect_origin", "link");
    try {
      const result = await redeemConnectLink(jwt);
      if (result.type === "oauth2") { window.location.href = result.url; return; }
      if (result.type === "cookie") { setInfo(result); return; }
      setError("Unexpected link type.");
    } catch (e) {
      if (e instanceof ConnectLinkError) setProblem(e);
      else setError(e instanceof Error ? e.message : "Link failed");
    } finally {
      setStarting(false);
    }
  }

  async function handleCapture() {
    setCapturing(true);
    setError(null);
    try {
      await connectCapture(jwt);
      navigate(`/connected/${encodeURIComponent(integration)}?status=ok`, { replace: true });
    } catch (e) {
      if (e instanceof ConnectLinkError) setProblem(e);
      else setError(e instanceof Error ? e.message : "Capture failed");
    } finally {
      setCapturing(false);
    }
  }

  if (problem) return <ConnectLinkProblem error={problem} />;

  if (!jwt) {
    return <div className="ui-loading">Missing link token. Ask your agent for a new connect link.</div>;
  }

  if (!info) {
    return (
      <div className="page-center page-center-stack">
        <BrandLockup />
        <div className="connect-result-card">
          <ConnectPair
            logo={<IntegrationLogo name={integration} displayName={label} logo={integ?.logo} size={44} />}
            label={label}
          />
          <h1 className="connect-result-title">Connect {label}?</h1>
          <p className="connect-result-detail">
            Your agent asked to connect this app to workbench. You'll sign in with {label}, and workbench
            stores the credential encrypted on this instance.
          </p>
          <Button onClick={handleStart} disabled={starting}>
            {starting ? "Starting…" : "Connect"}
          </Button>
          {error && <p className="ui-form-error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <Modal open onClose={() => {}} title={<>Connect <span>{label}</span></>}
      size="xl"
      dismissible={false}
      footer={
        <Button onClick={handleCapture} disabled={capturing}>
          {capturing ? "Capturing…" : "Capture session"}
        </Button>
      }
    >
      <div className="modal-instructions">
        <div><b>01</b> — Log in to the remote browser below.</div>
        <div><b>02</b> — Click "Capture session" once authenticated.</div>
      </div>
      <div style={{ padding: 0, background: "#000", marginTop: "var(--s-12)" }}>
        <CdpScreencast cdpProxyUrl={info.cdpProxyUrl} width={1024} />
      </div>
      {error && <div className="ui-form-error" style={{ marginTop: "var(--s-12)" }}>{error}</div>}
    </Modal>
  );
}
