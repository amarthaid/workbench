import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { safeReturnPath } from "../return-path";

interface AuthUser {
  id: string;
  email: string | null;
  isAdmin?: boolean;
  /** False when an admin's custom-app policy excludes this user. */
  canCreateCustomApps?: boolean;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  login: (token: string) => void;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

function readBootToken(): { token: string | null; fromHash: boolean } {
  if (typeof window === "undefined") return { token: null, fromHash: false };
  const hash = window.location.hash;
  if (hash.startsWith("#token=")) {
    const bootToken = decodeURIComponent(hash.slice(7));
    localStorage.setItem("awb_token", bootToken);
    // Strip the token from URL so it doesn't linger in history.
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return { token: bootToken, fromHash: true };
  }
  return { token: localStorage.getItem("awb_token"), fromHash: false };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Both SSO callbacks return to the portal root with the token in the hash,
  // never through /login — so Login's own return-path handling never runs
  // for that navigation. Consume the return path here instead, once, at boot.
  const [boot] = useState(readBootToken);
  const [token, setToken] = useState<string | null>(boot.token);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (!boot.fromHash) return;
    const returnTo = sessionStorage.getItem("awb_return_to");
    sessionStorage.removeItem("awb_return_to");
    const dest = safeReturnPath(returnTo);
    // SPA navigation — avoids a full page reload that would abort the concurrent
    // /api/auth/me fetch and clear the token from localStorage before the reload.
    if (dest !== "/") navigate(dest, { replace: true });
  }, [boot.fromHash, navigate]);

  useEffect(() => {
    if (!token) { setIsLoading(false); return; }
    fetch(`${import.meta.env.VITE_API_URL || ""}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => { if (!res.ok) throw new Error("Unauthorized"); return res.json(); })
      .then((data) => setUser(data))
      .catch(() => { localStorage.removeItem("awb_token"); setToken(null); })
      .finally(() => setIsLoading(false));
  }, [token]);

  const login = (newToken: string) => {
    localStorage.setItem("awb_token", newToken);
    setToken(newToken);
  };

  const logout = () => {
    localStorage.removeItem("awb_token");
    setToken(null);
    setUser(null);
    fetch(`${import.meta.env.VITE_API_URL || ""}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token ?? ""}` },
    }).catch(() => {});
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
