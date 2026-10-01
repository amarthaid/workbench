import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

// UX only: the server's /api/admin gate is the real check. This keeps a
// non-admin from landing on a page whose every request would 403.
export default function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user?.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
