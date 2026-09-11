import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  startIntegrationAuth,
  disconnectIntegration,
  type IntegrationSummary,
  type ApiKeyField,
} from "../api";
import CookieAuthPopup from "../components/CookieAuthPopup";
import ApiKeyAuthModal from "../components/ApiKeyAuthModal";
import { ConfirmDialog } from "../components/dialogs/ConfirmDialog";
import { InstanceUrlDialog } from "../components/dialogs/InstanceUrlDialog";

interface CookieAuthState {
  integration: string;
  loginUrl: string;
  cdpProxyUrl: string;
}

interface ApiKeyAuthState {
  integration: string;
  displayName?: string;
  fields: ApiKeyField[];
}

/**
 * The connect/disconnect state machine, owned in one place so that Home, Apps
 * and the app detail page all drive the same flow rather than each keeping a
 * private copy. Render `dialogs` somewhere in the consuming page — everything
 * the flow needs to put on screen lives in there.
 */
export function useConnectFlow() {
  const qc = useQueryClient();

  const [cookieAuth, setCookieAuth] = useState<CookieAuthState | null>(null);
  const [apiKeyAuth, setApiKeyAuth] = useState<ApiKeyAuthState | null>(null);
  const [pendingInstance, setPendingInstance] = useState<IntegrationSummary | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function refresh() {
    qc.invalidateQueries({ queryKey: ["connections"] });
    qc.invalidateQueries({ queryKey: ["integrations"] });
  }

  async function start(integ: IntegrationSummary, instanceUrl?: string) {
    setError(null);
    setBusy(integ.name);
    // This connect started inside the portal, so the result page should offer a
    // way back rather than telling the human to close the tab. A marker left by
    // an abandoned connect link earlier in the same tab would say otherwise.
    sessionStorage.removeItem("awb_connect_origin");
    try {
      const result = await startIntegrationAuth(integ.name, instanceUrl);

      if (result.type === "cookie") {
        // Cookie connect always returns login_required: open the live view so
        // the human logs in and clicks Capture. Nothing identifying travels
        // with it — the live view authenticates with the portal bearer and the
        // server resolves this user's own session from it.
        setCookieAuth({
          integration: integ.name,
          loginUrl: result.loginUrl,
          cdpProxyUrl: result.cdpProxyUrl,
        });
        return;
      }
      if (result.type === "oauth2") {
        window.location.href = result.url;
        return;
      }
      if (result.type === "apikey") {
        setApiKeyAuth({ integration: integ.name, displayName: integ.displayName, fields: result.fields });
        return;
      }
      setError(`Manual auth required for ${integ.displayName || integ.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connect failed");
    } finally {
      setBusy(null);
    }
  }

  function connect(integ: IntegrationSummary) {
    setError(null);
    if (integ.instance) {
      setPendingInstance(integ);
      return;
    }
    void start(integ);
  }

  function disconnect(name: string) {
    setError(null);
    setPendingDisconnect(name);
  }

  async function confirmDisconnect() {
    const name = pendingDisconnect;
    setPendingDisconnect(null);
    if (!name) return;
    setBusy(name);
    try {
      await disconnectIntegration(name);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(null);
    }
  }

  const dialogs = (
    <>
      {pendingInstance?.instance && (
        <InstanceUrlDialog
          open
          config={pendingInstance.instance}
          onCancel={() => setPendingInstance(null)}
          onSubmit={(url) => {
            const integ = pendingInstance;
            setPendingInstance(null);
            void start(integ, url);
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title={`Disconnect ${pendingDisconnect ?? ""}`}
        body="Stored credentials for this integration will be removed. Agents will lose access to its tools until you connect it again."
        confirmLabel="Disconnect"
        destructive
        onCancel={() => setPendingDisconnect(null)}
        onConfirm={confirmDisconnect}
      />

      {cookieAuth && (
        <CookieAuthPopup
          integration={cookieAuth.integration}
          loginUrl={cookieAuth.loginUrl}
          cdpProxyUrl={cookieAuth.cdpProxyUrl}
          onClose={() => setCookieAuth(null)}
          onSuccess={refresh}
        />
      )}

      {apiKeyAuth && (
        <ApiKeyAuthModal
          integration={apiKeyAuth.integration}
          displayName={apiKeyAuth.displayName}
          fields={apiKeyAuth.fields}
          onClose={() => setApiKeyAuth(null)}
          onSuccess={refresh}
        />
      )}
    </>
  );

  return { connect, disconnect, error, busy, dialogs };
}
