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
  type SpaceDetail,
} from "../spaces-api";
import { createSpaceBridge, type ConfirmRequest } from "../spaces/bridge";
import { SpaceToolList } from "../spaces/ToolList";
import { ConfirmActionModal } from "../spaces/ConfirmActionModal";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { BrandLockup } from "../components/BrandMark";

type Stopped = "paused" | "navigated" | null;

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-center page-center-stack">
      <BrandLockup />
      <div className="space-card">{children}</div>
    </div>
  );
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
  return (
    <div className="page-center page-center-stack">
      <BrandLockup />
      <div className="space-consent">
        <h1 className="space-consent-title">{space.title}</h1>
        <p className="space-muted">by {space.ownerEmail}</p>
        {space.description && <p className="space-consent-desc">{space.description}</p>}
        <p className="space-consent-explain">
          This Space runs as you, with your connections. Approve the tools it can use below. Tools tagged Asks first
          need your OK every time they run.
        </p>
        <SpaceToolList tools={space.tools} />
        {error && <p className="ui-form-error">{error}</p>}
        <div className="space-consent-actions">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={onApprove} disabled={busy}>{busy ? "Approving..." : "Approve"}</Button>
        </div>
      </div>
    </div>
  );
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
}: {
  space: SpaceDetail;
  onConsentRequired: () => void;
  onStopped: (why: "paused" | "navigated") => void;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const { user } = useAuth();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Fixed at mount: a refetch mints a new sig, and changing src would reload
  // the frame, which the bridge rightly treats as a navigation.
  const [src] = useState(space.appUrl);
  const [pending, setPending] = useState<Pending | null>(null);
  const [banners, setBanners] = useState<{ integration: string; name: string }[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  // The bridge reads these through refs so it is created once per mount.
  const spaceRef = useRef(space);
  spaceRef.current = space;
  const emailRef = useRef(user?.email ?? "");
  emailRef.current = user?.email ?? "";
  const pendingRef = useRef<Pending | null>(null);
  const callbacks = useRef({ onConsentRequired, onStopped });
  callbacks.current = { onConsentRequired, onStopped };

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
        setBanners((prev) =>
          prev.some((b) => b.integration === integration) ? prev : [...prev, { integration, name: integrationName }]
        ),
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
          <Link to="/spaces" className="space-bar-back" aria-label="All Spaces">Spaces</Link>
          <span className="space-bar-name">{space.title}</span>
          <span className="space-bar-owner">by {space.ownerEmail}</span>
        </div>
        <div className="space-bar-right">
          <span className="space-bar-as">Running as you</span>
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
            <div key={b.integration} className="space-banner" role="status">
              <span>{b.name} is not connected, so this Space cannot use it.</span>
              <a href={`/apps/${encodeURIComponent(b.integration)}`} target="_blank" rel="noopener">
                Connect {b.name}
              </a>
              <button
                type="button"
                className="ui-button ui-button-ghost ui-button-xs"
                onClick={() => setBanners((prev) => prev.filter((x) => x.integration !== b.integration))}
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

  const { data, error, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchSpace(name),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const setConsented = (consented: boolean) =>
    queryClient.setQueryData<SpaceDetail>(queryKey, (d) => (d ? { ...d, consented } : d));

  const approve = useMutation({
    mutationFn: () => grantSpaceConsent(name),
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

  if (!data.consented) {
    return (
      <ConsentScreen
        space={data}
        busy={approve.isPending}
        error={approve.error ? "Could not record your approval. Try again." : null}
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
      onStopped={setStopped}
      onConsentRequired={() => {
        // The author changed the tool list: ask again, over the new list.
        setConsented(false);
        void queryClient.invalidateQueries({ queryKey });
      }}
    />
  );
}
