import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import {
  SpaceApiError,
  callSpaceTool,
  deleteSpaceKv,
  fetchSpace,
  fetchSpaceKv,
  fetchSpaceKvKeys,
  grantSpaceConsent,
  putSpaceKv,
  revokeSpaceConsent,
  type DelegationOff,
  type SpaceDetail,
  type SpaceSharing,
  type SpaceTool,
} from "../spaces-api";
import { createSpaceBridge, runsAsOwner, type ConfirmRequest } from "../spaces/bridge";
import { SpaceToolList } from "../spaces/ToolList";
import { ConfirmActionModal } from "../spaces/ConfirmActionModal";
import { SharingModal } from "../spaces/SharingModal";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { BrandLockup, BrandMark } from "../components/BrandMark";
import { LOCKUP } from "@a-workbench/brand";

type Stopped = "paused" | "navigated" | null;

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-center page-center-stack">
      <BrandLockup />
      <div className="space-card">{children}</div>
    </div>
  );
}

/** Display names of integrations the viewer must connect before approving. */
export function unconnectedIntegrations(tools: SpaceTool[]): string[] {
  const names = new Map<string, string>();
  for (const t of tools) {
    if (t.missing || t.connected !== false) continue;
    names.set(t.integration, t.integrationName || t.integration);
  }
  return [...names.values()];
}

function ConsentScreen({
  space,
  onApprove,
  onCancel,
  busy,
  error,
}: {
  space: SpaceDetail;
  onApprove: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  // A delegated Space runs with the owner's connections (the detail's
  // `connected` flags are the owner's), so the viewer has nothing to connect
  // and is never blocked: they are told who needs to reconnect instead.
  const delegated = runsAsOwner(space);
  const needed = unconnectedIntegrations(space.tools);
  const blocked = !delegated && needed.length > 0;
  return (
    <div className="page-center page-center-stack">
      <BrandLockup />
      <div className="space-consent">
        <h1 className="space-consent-title">{space.title}</h1>
        <p className="space-muted">by {space.ownerEmail}</p>
        {space.description && <p className="space-consent-desc">{space.description}</p>}
        {delegated ? (
          <p className="space-consent-explain">
            <strong>These tools run with {space.ownerEmail}'s access, not yours.</strong> Your own connections are not
            used. Every call is logged under your name and theirs. Tools tagged Asks first need your OK every time they
            run.
          </p>
        ) : (
          <p className="space-consent-explain">
            This Space runs as you, with your connections. Approve the tools it can use below. Tools tagged Asks first
            need your OK every time they run.
          </p>
        )}
        <SpaceToolList
          tools={space.tools}
          connectHref={delegated ? undefined : (integration) => `/apps/${encodeURIComponent(integration)}`}
        />
        {blocked && (
          <div className="space-consent-needs" role="status">
            <span>
              <strong>Connect {needed.join(", ")} to continue.</strong> This Space acts through your own connections, so
              each integration it uses has to be connected on your account before you can approve it.
            </span>
            <span>Connect in the new tab, then come back here. This page updates when you return.</span>
          </div>
        )}
        {delegated && needed.length > 0 && (
          <div className="space-consent-needs" role="status">
            <span>
              {space.ownerEmail} needs to reconnect {needed.join(", ")}. Calls to those tools will fail until they do.
            </span>
          </div>
        )}
        {error && <p className="ui-form-error">{error}</p>}
        <div className="space-consent-actions">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={onApprove} disabled={busy || blocked}>{busy ? "Approving..." : "Approve"}</Button>
        </div>
      </div>
    </div>
  );
}

/** A notice across the top of a running Space. `connect` adds a Connect link. */
interface Banner {
  key: string;
  text: string;
  connect?: { integration: string; name: string };
}

interface Pending {
  request: ConfirmRequest;
  resolve: (allowed: boolean) => void;
}

function SpaceRunner({
  space,
  onConsentRequired,
  onStopped,
  onRevoke,
  revoking,
  onSharingSaved,
  onDelegationOff,
}: {
  space: SpaceDetail;
  onDelegationOff: (off: DelegationOff) => void;
  onConsentRequired: () => void;
  onStopped: (why: "paused" | "navigated") => void;
  onRevoke: () => void;
  revoking: boolean;
  onSharingSaved: (sharing: SpaceSharing) => void;
}) {
  const { user } = useAuth();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Fixed at mount: a refetch mints a new sig, and changing src would reload
  // the frame, which the bridge rightly treats as a navigation.
  const [src] = useState(space.appUrl);
  const [pending, setPending] = useState<Pending | null>(null);
  const [banners, setBanners] = useState<Banner[]>([]);
  const addBanner = (b: Banner) => setBanners((prev) => (prev.some((x) => x.key === b.key) ? prev : [...prev, b]));
  const [menuOpen, setMenuOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);

  // The bridge reads these through refs so it is created once per mount.
  const spaceRef = useRef(space);
  spaceRef.current = space;
  const emailRef = useRef(user?.email ?? "");
  emailRef.current = user?.email ?? "";
  const pendingRef = useRef<Pending | null>(null);
  const callbacks = useRef({ onConsentRequired, onStopped, onDelegationOff });
  callbacks.current = { onConsentRequired, onStopped, onDelegationOff };

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const name = spaceRef.current.name;
    const bridge = createSpaceBridge({
      frame,
      getSpace: () => spaceRef.current,
      api: {
        call: (body) => callSpaceTool(name, body),
        kvKeys: () => fetchSpaceKvKeys(name),
        kvGet: (key) => fetchSpaceKv(name, key),
        kvSet: (key, value) => putSpaceKv(name, key, value),
        kvDelete: (key) => deleteSpaceKv(name, key),
      },
      me: async () => ({ email: emailRef.current }),
      confirm: (request) =>
        new Promise<boolean>((resolve) => {
          const p = { request, resolve };
          pendingRef.current = p;
          setPending(p);
        }),
      onNotConnected: (integration, integrationName) =>
        addBanner({
          key: `connect:${integration}`,
          text: `${integrationName} is not connected, so this Space cannot use it.`,
          connect: { integration, name: integrationName },
        }),
      // The owner's connection: only the owner can fix it, so no Connect link.
      onOwnerNotConnected: (integration, message) => addBanner({ key: `owner:${integration}`, text: message }),
      onToolNotDelegable: (tool, message) => addBanner({ key: `not-delegable:${tool}`, text: message }),
      onDelegationOff: (reason, message) => callbacks.current.onDelegationOff({ reason, message }),
      onConsentRequired: () => callbacks.current.onConsentRequired(),
      onPaused: () => callbacks.current.onStopped("paused"),
      onNavigatedAway: () => callbacks.current.onStopped("navigated"),
    });
    return () => {
      bridge.dispose();
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  const settle = useCallback((allowed: boolean) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    p?.resolve(allowed);
  }, []);

  return (
    <div className="space-shell">
      <header className="space-bar">
        <div className="space-bar-title">
          <Link to="/" className="space-bar-home" aria-label="workbench home">
            <BrandMark size={LOCKUP.compact.mark} />
          </Link>
          <Link to="/spaces" className="space-bar-back" aria-label="All Spaces">Spaces</Link>
          <span className="space-bar-name">{space.title}</span>
          <span className="space-bar-owner">by {space.ownerEmail}</span>
        </div>
        <div className="space-bar-right">
          {runsAsOwner(space) ? (
            <span className="space-bar-as space-bar-as-delegated" title={`Tools run with ${space.ownerEmail}'s access`}>
              Using {space.ownerEmail}'s delegated access
            </span>
          ) : (
            <span className="space-bar-as">Running as you</span>
          )}
          <div className="space-menu">
            <Button
              variant="outline"
              size="xs"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              Menu
            </Button>
            {menuOpen && (
              <div className="space-menu-list" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="space-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setToolsOpen(true);
                  }}
                >
                  View tools
                </button>
                {space.mine && (
                  <button
                    type="button"
                    role="menuitem"
                    className="space-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setSharingOpen(true);
                    }}
                  >
                    Sharing
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="space-menu-item"
                  disabled={revoking}
                  onClick={() => {
                    setMenuOpen(false);
                    onRevoke();
                  }}
                >
                  Revoke access
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {banners.length > 0 && (
        <div className="space-banners">
          {banners.map((b) => (
            <div key={b.key} className="space-banner" role="status">
              <span>{b.text}</span>
              {b.connect && (
                <a href={`/apps/${encodeURIComponent(b.connect.integration)}`} target="_blank" rel="noopener">
                  Connect {b.connect.name}
                </a>
              )}
              <button
                type="button"
                className="ui-button ui-button-ghost ui-button-xs"
                onClick={() => setBanners((prev) => prev.filter((x) => x.key !== b.key))}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <iframe
        ref={frameRef}
        className="space-frame"
        title={space.title}
        src={src}
        sandbox="allow-scripts allow-forms"
        allow=""
        referrerPolicy="no-referrer"
      />

      <ConfirmActionModal request={pending?.request ?? null} onAllow={() => settle(true)} onDeny={() => settle(false)} />

      <Modal open={toolsOpen} onClose={() => setToolsOpen(false)} title="Tools this Space can use" size="lg">
        <SpaceToolList tools={space.tools} />
      </Modal>

      {space.mine && (
        <SharingModal
          open={sharingOpen}
          space={space}
          onClose={() => setSharingOpen(false)}
          onSaved={onSharingSaved}
        />
      )}
    </div>
  );
}

export default function SpaceShell() {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = ["space", name];
  const [stopped, setStopped] = useState<Stopped>(null);
  const [mountKey, setMountKey] = useState(0);
  // Set when a call answered DELEGATION_OFF while the Space was running.
  const [offDuringRun, setOffDuringRun] = useState<DelegationOff | null>(null);
  const [retrying, setRetrying] = useState(false);

  const { data, error, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchSpace(name),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // On the consent page, coming back from connecting in another tab re-checks
  // which integrations are connected. The running Space does not need this.
  const awaitingConsent = !!data && !data.consented;
  useEffect(() => {
    if (!awaitingConsent) return;
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [awaitingConsent, refetch]);

  const setConsented = (consented: boolean) =>
    queryClient.setQueryData<SpaceDetail>(queryKey, (d) => (d ? { ...d, consented } : d));

  const approve = useMutation({
    mutationFn: () => grantSpaceConsent(name, data?.consent_hash),
    // The viewer's connections, or the Space itself, changed since this page
    // loaded: show the new state.
    onError: (e) => {
      if (e instanceof SpaceApiError && (e.code === "INTEGRATION_NOT_CONNECTED" || e.code === "CONSENT_CHANGED")) {
        void refetch();
      }
    },
    onSuccess: () => {
      setStopped(null);
      setConsented(true);
    },
  });

  const revoke = useMutation({
    mutationFn: () => revokeSpaceConsent(name),
    onSuccess: () => setConsented(false),
  });

  if (isLoading) {
    return (
      <div className="ui-loading">
        <span>Loading Space...</span>
      </div>
    );
  }

  if (error || !data) {
    const notFound = error instanceof SpaceApiError && error.status === 404;
    return (
      <CenterCard>
        <h1 className="space-card-title">{notFound ? "Space not found" : "Could not load this Space"}</h1>
        <p className="space-muted">
          {notFound ? "This Space does not exist or was not shared with you." : (error as Error | null)?.message}
        </p>
        <div className="space-consent-actions">
          {!notFound && <Button variant="outline" onClick={() => void refetch()}>Try again</Button>}
          <Link to="/spaces" className="ui-button ui-button-primary ui-button-md">Go to Spaces</Link>
        </div>
      </CenterCard>
    );
  }

  // A viewer of a delegated Space whose shared access is off: nothing in it
  // can run, and their own access is never used instead.
  const off = offDuringRun ?? (!data.mine && data.delegation_off ? data.delegation_off : null);
  if (off) {
    return (
      <CenterCard>
        <h1 className="space-card-title">{off.reason === "tools_changed" ? "Space paused" : "Shared access is off"}</h1>
        <p className="space-muted">{off.message}</p>
        <div className="space-consent-actions">
          <Button
            variant="outline"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              try {
                const r = await refetch();
                // Back on (or never delegated any more): run the Space again.
                if (r.data && !r.data.delegation_off) {
                  setOffDuringRun(null);
                  setMountKey((k) => k + 1);
                }
              } finally {
                setRetrying(false);
              }
            }}
          >
            {retrying ? "Checking..." : "Try again"}
          </Button>
          <Link to="/spaces" className="ui-button ui-button-primary ui-button-md">Go to Spaces</Link>
        </div>
      </CenterCard>
    );
  }

  if (!data.consented) {
    return (
      <ConsentScreen
        space={data}
        busy={approve.isPending}
        error={
          approve.error
            ? approve.error instanceof SpaceApiError && approve.error.code === "INTEGRATION_NOT_CONNECTED"
              ? approve.error.message
              : approve.error instanceof SpaceApiError && approve.error.code === "CONSENT_CHANGED"
                ? "This Space changed. Review it again."
              : "Could not record your approval. Try again."
            : null
        }
        onApprove={() => approve.mutate()}
        onCancel={() => navigate("/spaces")}
      />
    );
  }

  if (stopped) {
    return (
      <CenterCard>
        <h1 className="space-card-title">{stopped === "paused" ? "Space paused" : "Space stopped"}</h1>
        <p className="space-muted">
          {stopped === "paused"
            ? "This Space asked for too many confirmations in a short time, so it was paused."
            : "This Space navigated away and was stopped."}
        </p>
        <div className="space-consent-actions">
          <Link to="/spaces" className="ui-button ui-button-outline ui-button-md">Go to Spaces</Link>
          <Button
            onClick={() => {
              setStopped(null);
              setMountKey((k) => k + 1);
            }}
          >
            Reload Space
          </Button>
        </div>
      </CenterCard>
    );
  }

  return (
    <SpaceRunner
      key={mountKey}
      space={data}
      revoking={revoke.isPending}
      onRevoke={() => revoke.mutate()}
      onSharingSaved={() => {
        // Read the whole detail again: a save can change more than the fields
        // it answers with (the mode, the pause, the owner's own consent).
        void queryClient.invalidateQueries({ queryKey });
        void queryClient.invalidateQueries({ queryKey: ["spaces"] });
      }}
      onStopped={setStopped}
      onDelegationOff={setOffDuringRun}
      onConsentRequired={() => {
        // The author changed the tool list: ask again, over the new list.
        setConsented(false);
        void queryClient.invalidateQueries({ queryKey });
      }}
    />
  );
}
