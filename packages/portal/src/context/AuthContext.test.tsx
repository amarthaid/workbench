import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { beginLoginCeremony } from "../login-nonce";

// Regression coverage for the session-fixation finding: adopting a
// #token= fragment must require proof this tab started the login it claims
// to complete (a matching login-nonce in sessionStorage), not just the
// presence of a value in the URL — otherwise a link crafted with someone
// else's already-valid session token gets silently adopted.

function Probe() {
  const { token, isLoading } = useAuth();
  if (isLoading) return <div>loading</div>;
  return <div data-testid="token">{token ?? "none"}</div>;
}

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // The provider verifies any token it has (adopted or from localStorage)
  // against /api/auth/me and drops it on failure — stub that endpoint as
  // succeeding so these tests exercise fragment-adoption, not that check.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ id: "u1", email: "test@example.com" }) }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("AuthContext boot-token adoption", () => {
  it("adopts a #token= fragment whose nonce matches this tab's login ceremony", async () => {
    const nonce = beginLoginCeremony();
    renderAt(`/#token=real-session-token&nonce=${nonce}`);
    await waitFor(() => expect(screen.getByTestId("token")).toHaveTextContent("real-session-token"));
    expect(localStorage.getItem("awb_token")).toBe("real-session-token");
    // Single-use: the ceremony nonce must not still be sitting in storage.
    expect(sessionStorage.getItem("awb_login_nonce")).toBeNull();
  });

  it("rejects a #token= fragment with no matching ceremony (crafted link)", async () => {
    // No beginLoginCeremony() call — this tab never started a login, exactly
    // the case where an attacker sends a victim a link carrying the
    // attacker's own valid token.
    renderAt("/#token=attacker-session-token&nonce=whatever-the-attacker-put-here");
    await waitFor(() => expect(screen.getByTestId("token")).toHaveTextContent("none"));
    expect(localStorage.getItem("awb_token")).toBeNull();
  });

  it("rejects a #token= fragment with no nonce at all", async () => {
    beginLoginCeremony();
    renderAt("/#token=some-token");
    await waitFor(() => expect(screen.getByTestId("token")).toHaveTextContent("none"));
    expect(localStorage.getItem("awb_token")).toBeNull();
  });

  it("rejects a stale nonce left over from a different login attempt", async () => {
    beginLoginCeremony(); // tab starts attempt #1, nonce N1 stored
    renderAt("/#token=some-token&nonce=N2-not-what-was-stored");
    await waitFor(() => expect(screen.getByTestId("token")).toHaveTextContent("none"));
  });

  it("still boots a session from localStorage with no hash present", async () => {
    localStorage.setItem("awb_token", "existing-session-token");
    renderAt("/");
    await waitFor(() => expect(screen.getByTestId("token")).toHaveTextContent("existing-session-token"));
  });
});
