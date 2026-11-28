import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAuthUrl, fetchKeycloakAuthUrl, fetchWaitingState, type WaitingState } from "../api";
import { beginLoginCeremony } from "../login-nonce";
import { Button } from "../components/ui/Button";
import { BrandLockup } from "../components/BrandMark";

// Poll schedule while the tab is visible: 5s, doubling to a 60s cap. A focus or
// visibility change polls at once and restarts the schedule at 5s.
export const POLL_START_MS = 5_000;
export const POLL_CAP_MS = 60_000;

type Phase = WaitingState | "checking";

const STATUS_TEXT: Record<Phase, string> = {
  checking: "Checking your request.",
  pending: "Waiting for approval. An admin will review your request.",
  declined: "Request declined.",
  active: "Approved. Signing you in.",
  none: "Your session for this request expired.",
};

function Step({ n, status, current, label, children }: {
  n: number;
  status: "done" | "current" | "todo" | "declined";
  current?: boolean;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="waiting-step" data-status={status} aria-current={current ? "step" : undefined}>
      <span className="waiting-marker" aria-hidden="true">{status === "done" ? "✓" : n}</span>
      <span className="waiting-label">{label}</span>
      {children}
    </li>
  );
}

export default function Waiting() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [startError, setStartError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delay = useRef(POLL_START_MS);
  const inFlight = useRef(false);
  const stopped = useRef(false);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const startSignIn = useCallback(async (provider: "google" | "keycloak" | null) => {
    try {
      const nonce = beginLoginCeremony();
      const { url } = provider === "keycloak" ? await fetchKeycloakAuthUrl(undefined, nonce) : await fetchAuthUrl(undefined, nonce);
      window.location.href = url;
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start sign in");
    }
  }, []);

  const poll = useCallback(async () => {
    if (stopped.current || inFlight.current) return;
    clear();
    inFlight.current = true;
    let next = true;
    try {
      const { state, provider } = await fetchWaitingState();
      if (stopped.current) return;
      setPhase(state);
      if (state !== "pending") {
        next = false;
        stopped.current = true;
        if (state === "active") void startSignIn(provider);
      }
    } catch {
      // A network error is not news: keep the last state and back off.
    } finally {
      inFlight.current = false;
    }
    if (next && !stopped.current && !document.hidden) {
      const wait = delay.current;
      delay.current = Math.min(delay.current * 2, POLL_CAP_MS);
      timer.current = setTimeout(() => void poll(), wait);
    }
  }, [startSignIn]);

  useEffect(() => {
    stopped.current = false;
    const refetch = () => {
      if (document.hidden) return;
      delay.current = POLL_START_MS;
      void poll();
    };
    const onVisibility = () => {
      if (document.hidden) clear();
      else refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refetch);
    refetch();
    return () => {
      stopped.current = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refetch);
    };
  }, [poll]);

  const declined = phase === "declined";
  const active = phase === "active";
  const none = phase === "none";

  return (
    <div className="login-shell">
      <aside className="login-art" data-ground="accent">
        <div className="login-art-copy">
          <div className="login-art-brand">
            <BrandLockup compact />
          </div>
          <div>
            <h1 className="login-art-title">Almost there.</h1>
            <p className="login-art-sub">
              New accounts are approved by an admin before first use. This page continues on its own once you are in.
            </p>
          </div>
        </div>
      </aside>

      <section className="login-form">
        <div className="login-card">
          <h1 className="login-title">{none ? "Request expired" : "Account request"}</h1>

          {none ? (
            <>
              <p className="login-sub">Your session for this request expired. Sign in again to check on it.</p>
              <Button variant="outline" size="lg" type="button" onClick={() => window.location.assign("/login")}>
                Back to sign in
              </Button>
            </>
          ) : (
            <>
              <ol className="waiting-steps" aria-label="Account approval progress">
                <Step n={1} status="done" label="Signed in" />
                {declined ? (
                  <Step n={2} status="declined" current label="Request declined">
                    <p className="waiting-note">Your account request was declined. Try again later or contact an admin.</p>
                  </Step>
                ) : (
                  <Step n={2} status={active ? "done" : "current"} current={!active} label="Waiting for approval">
                    {!active && (
                      <p className="waiting-note">
                        <span className="waiting-loader" aria-hidden="true" />{" "}
                        An admin will review your request. You can leave this page open.
                      </p>
                    )}
                  </Step>
                )}
                <Step n={3} status={active ? "done" : "todo"} current={active} label="Active" />
              </ol>
              {declined && (
                <Button variant="outline" size="lg" type="button" onClick={() => window.location.assign("/login")}>
                  Back to sign in
                </Button>
              )}
            </>
          )}

          <div className="login-sub" role="status" aria-live="polite">
            {startError || STATUS_TEXT[phase]}
          </div>
        </div>
      </section>
    </div>
  );
}
