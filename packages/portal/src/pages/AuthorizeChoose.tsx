import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { fetchProviders, fetchAuthUrl, fetchKeycloakAuthUrl, fetchAuthorizeInfo, SERVER_URL, type AuthorizeInfo } from "../api";
import { beginLoginCeremony } from "../login-nonce";
import { Button } from "../components/ui/Button";
import { BrandLockup } from "../components/BrandMark";

// Lands here from the server's GET /authorize — an MCP agent is asking a
// human to authenticate to workbench itself (not connect one integration).
// This is the same provider choice /login offers, carrying the agent's
// ticket through. Once signed in, the human sees an explicit consent
// screen naming the requesting client and where the resulting access will
// go, and must click Approve — nothing here auto-submits. A silently
// resumed session is exactly what let an attacker's crafted link mint an
// authorization code for a victim without any approval action.
export default function AuthorizeChoose() {
  const [search] = useSearchParams();
  const ticket = search.get("ticket") ?? "";
  // Deliberately NOT read from the URL: this form posts a live session
  // token, so its target must come only from our own build-time config
  // (SERVER_URL), never from a query param a crafted link could set to an
  // attacker's origin.
  const resumeUrl = `${SERVER_URL}/authorize/resume`;
  const resumeError = search.get("error");
  const { user, token, isLoading } = useAuth();
  const [providers, setProviders] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<AuthorizeInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [denied, setDenied] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    fetchProviders().then((r) => setProviders(r.providers)).catch(() => {});
  }, []);

  // Load what the human is being asked to approve. Read-only — never
  // consumes the ticket, so it is safe to fetch on every render of this page.
  useEffect(() => {
    if (!ticket || !user || !token) return;
    fetchAuthorizeInfo(ticket)
      .then(setInfo)
      .catch((err) => setInfoError(err instanceof Error ? err.message : "Failed to load request"));
  }, [ticket, user, token]);

  function handleApprove() {
    setApproving(true);
    formRef.current?.submit();
  }

  async function handleProvider(name: "google" | "keycloak") {
    setError(null);
    try {
      const nonce = beginLoginCeremony();
      const { url } =
        name === "google" ? await fetchAuthUrl(ticket, nonce) : await fetchKeycloakAuthUrl(ticket, nonce);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start sign in");
    }
  }

  if (!ticket) {
    return (
      <div className="page-center page-center-stack">
        <BrandLockup />
        <div className="login-card">
          <div className="ui-form-error">Missing or invalid link. Ask your agent to try again.</div>
        </div>
      </div>
    );
  }

  // Show the provider picker when there's no usable session yet (or a prior
  // resume attempt just failed). Otherwise — once signed in — show the
  // explicit consent screen below; nothing here ever submits on its own.
  const showChoice = !isLoading && (!user || !token || !!resumeError);
  const showConsent = !isLoading && !!user && !!token && !resumeError && !denied;

  return (
    <div className="page-center">
      <form ref={formRef} method="POST" action={resumeUrl} hidden>
        <input type="hidden" name="ticket" value={ticket} />
        <input type="hidden" name="token" value={token ?? ""} />
      </form>

      <section className="login-form login-form-stack">
        <BrandLockup />
        <div className="login-card">
          <h1 className="login-title">Approve agent access</h1>

          {denied ? (
            <p className="login-sub">Access denied. You may close this tab.</p>
          ) : showConsent ? (
            <>
              {infoError ? (
                <div className="ui-form-error">{infoError}</div>
              ) : !info ? (
                <p className="login-sub">Loading request…</p>
              ) : (
                <>
                  <p className="login-sub">
                    <strong>{info.clientName ?? "An unnamed application"}</strong> is requesting access to
                    your workbench account. If you approve, it will receive your credentials and the
                    resulting access will be delivered to <strong>{info.redirectOrigin}</strong>.
                  </p>
                  <p className="login-sub">Only approve this if you started this request yourself.</p>
                  <Button onClick={handleApprove} disabled={approving} size="lg" type="button">
                    {approving ? "Approving…" : "Approve"}
                  </Button>
                  <Button onClick={() => setDenied(true)} disabled={approving} variant="outline" size="lg" type="button">
                    Deny
                  </Button>
                </>
              )}
            </>
          ) : (
            <>
              <p className="login-sub">
                An agent is requesting access to your workbench. Sign in to continue.
              </p>

              {!showChoice ? (
                <p className="login-sub">Signing in…</p>
              ) : (
                <>
                  {(error || resumeError) && (
                    <div className="ui-form-error">
                      {error ?? "Your session couldn't be resumed automatically. Sign in again."}
                    </div>
                  )}

                  {providers.includes("google") && (
                    <Button onClick={() => handleProvider("google")} variant="outline" size="lg" type="button">
                      Continue with Google
                    </Button>
                  )}

                  {providers.includes("keycloak") && (
                    <Button onClick={() => handleProvider("keycloak")} variant="outline" size="lg" type="button">
                      Continue with Keycloak
                    </Button>
                  )}

                  {providers.length === 0 && (
                    <div className="ui-form-error">No auth provider configured</div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
