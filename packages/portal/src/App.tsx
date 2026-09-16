import { useEffect } from "react";
import { Routes, Route, Navigate, useLocation, Outlet } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Login from "./pages/Login";
import Connect from "./pages/Connect";
import ConnectResult from "./pages/ConnectResult";
import BrowserView from "./pages/BrowserView";
import AuthorizeChoose from "./pages/AuthorizeChoose";
import { AppShell } from "./components/shell/AppShell";
import Home from "./pages/Home";
import Apps from "./pages/Apps";
import AppDetail from "./pages/AppDetail";
import Agents from "./pages/Agents";
import Files from "./pages/Files";
import Vault from "./pages/Vault";
import Activity from "./pages/Activity";
import Settings from "./pages/Settings";

function Boot({ label = "Loading" }: { label?: string }) {
  return (
    <div className="ui-loading">
      <span>{label}…</span>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const dest = location.pathname + location.search;

  // SSO always returns to the portal root, so remember where the human was
  // headed. A connect link is useless if login drops them on the dashboard.
  // This is a side effect, so it runs in an effect, not during render.
  useEffect(() => {
    if (!isLoading && !user) {
      sessionStorage.setItem("awb_return_to", dest);
    }
  }, [isLoading, user, dest]);

  if (isLoading) return <Boot label="Verifying session" />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Public: handles both the signed-out (show a picker) and signed-in
          (silently resume) cases itself — RequireAuth's unconditional
          redirect-to-/login doesn't fit either branch. */}
      <Route path="/authorize/choose" element={<AuthorizeChoose />} />
      {/* Full-bleed authenticated pages: a connect handoff and the remote
          browser view both want the whole viewport, so they stay outside the
          shell. */}
      <Route path="/connect/:integration" element={<RequireAuth><Connect /></RequireAuth>} />
      {/* Where every finished connect lands — the provider callback redirects
          here with a status, and the cookie flow navigates here itself. */}
      <Route path="/connected/:integration" element={<RequireAuth><ConnectResult /></RequireAuth>} />
      <Route path="/browser" element={<RequireAuth><BrowserView /></RequireAuth>} />

      <Route
        element={
          <RequireAuth>
            <AppShell>
              <Outlet />
            </AppShell>
          </RequireAuth>
        }
      >
        <Route path="/" element={<Home />} />
        <Route path="/apps" element={<Apps />} />
        <Route path="/apps/:name" element={<AppDetail />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/files" element={<Files />} />
        <Route path="/vault" element={<Vault />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}

export default App;
