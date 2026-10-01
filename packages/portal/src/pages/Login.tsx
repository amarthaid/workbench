import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { fetchAuthUrl, fetchKeycloakAuthUrl, fetchProviders } from "../api";
import { safeReturnPath } from "../return-path";
import { Button } from "../components/ui/Button";
import { BrandLockup } from "../components/BrandMark";
import { useSwarm } from "../hooks/useSwarm";

export default function Login() {
  const { login, token } = useAuth();
  // The server sends a person whose account an admin disabled back here with a
  // reason, since they arrive from an SSO redirect and not from an API client.
  const [error, setError] = useState(() =>
    new URLSearchParams(window.location.search).get("error") === "account_disabled"
      ? "Your account has been disabled by an administrator."
      : ""
  );
  const [providers, setProviders] = useState<string[]>([]);

  // This only fires for a human who already holds a session and lands on
  // /login directly (e.g. a stale tab). The SSO-callback case is handled at
  // boot in AuthContext, since both callbacks return to the portal root and
  // never mount this page.
  useEffect(() => {
    if (!token) return;
    const returnTo = sessionStorage.getItem("awb_return_to");
    sessionStorage.removeItem("awb_return_to");
    window.location.href = safeReturnPath(returnTo);
  }, [login, token]);

  useEffect(() => {
    fetchProviders().then((r) => setProviders(r.providers)).catch(() => {});
  }, []);

  const handleGoogle = async () => {
    try {
      const { url } = await fetchAuthUrl();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start sign in");
    }
  };

  const handleKeycloak = async () => {
    try {
      const { url } = await fetchKeycloakAuthUrl();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start sign in");
    }
  };

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  // Below the two-column breakpoint the aside stacks above the form: centre the mark, shrink it,
  // pull it above the copy pinned at the bottom, and drop the ambient field.
  const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 880px)").matches;
  // The prototype mark assumes a 16:9-ish frame; a tall aside (narrow stacked
  // layout, or simply a tall desktop viewport) needs it centred instead of
  // offset, or it runs past the right edge. Measured here (inside the hook's
  // mount effect, after layout) rather than during render, since the canvas
  // fills its aside via CSS and isn't sized yet on the first render pass.
  const tallAside = () => {
    const el = canvasRef.current;
    return !el || el.clientHeight === 0 || el.clientWidth / el.clientHeight < 1.3;
  };
  useSwarm(canvasRef, {
    ground: dark ? "dark" : "accent",
    markX: () => (narrow || tallAside() ? 0.5 : 0.66),
    // On narrow (stacked) layouts the copy is pinned to the bottom of the
    // aside, so the mark is pulled well above centre to leave it clear. A
    // tall desktop column has more room: nudge it up just enough that it
    // doesn't touch the copy block below.
    markY: () => (narrow ? 0.36 : tallAside() ? 0.42 : 0.5),
    markFrac: narrow ? 0.6 : undefined,
    ambient: !narrow,
  });

  return (
    <div className="login-shell">
      <aside className="login-art" data-ground={dark ? "dark" : "accent"}>
        <canvas ref={canvasRef} className="login-art-canvas" aria-hidden="true" />
        <div className="login-art-copy">
          <div className="login-art-brand">
            <BrandLockup compact />
          </div>
          <div>
            <h1 className="login-art-title">Connect your agent's toolbelt.</h1>
            <p className="login-art-sub">
              One sign-in pairs your agent sessions to the tools you already use. Credentials stay encrypted on
              your own instance.
            </p>
          </div>
        </div>
      </aside>

      <section className="login-form">
        <div className="login-card">
          <h1 className="login-title">Sign in</h1>
          <p className="login-sub">
            Choose how you want to identify yourself to this workbench.
          </p>

          {error && <div className="ui-form-error">{error}</div>}

          {providers.includes("google") && (
            <Button onClick={handleGoogle} variant="outline" size="lg" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </Button>
          )}

          {providers.includes("keycloak") && (
            <Button onClick={handleKeycloak} variant="outline" size="lg" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8" r="4"/>
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              </svg>
              Continue with Keycloak
            </Button>
          )}

          {providers.length === 0 && (
            <div className="ui-form-error">No auth provider configured</div>
          )}
        </div>
      </section>
    </div>
  );
}
