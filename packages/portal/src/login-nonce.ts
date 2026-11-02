// Login-ceremony nonce: ties adoption of a #token= fragment to a login this
// browser tab actually started, closing the session-fixation hole where an
// attacker crafts https://workbench/#token=<their-own-valid-session-token>
// and sends it to a victim — the portal used to adopt any #token= value
// unconditionally, so the victim's subsequent saves/connects landed in the
// attacker's account.
//
// sessionStorage is per-tab and survives a top-level navigation away (to the
// SSO provider) and back, but is never visible to a URL an attacker merely
// sends — so a crafted link can supply a token but never the matching nonce.
const KEY = "awb_login_nonce";

function randomNonce(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Call right before redirecting the browser to the SSO provider. */
export function beginLoginCeremony(): string {
  const nonce = randomNonce();
  try {
    sessionStorage.setItem(KEY, nonce);
  } catch {
    // Storage unavailable (private mode, etc.) — the ceremony simply won't
    // match on return, so the fragment is rejected rather than silently
    // trusted. Fail closed.
  }
  return nonce;
}

/** Call once, at boot, against whatever `nonce=` arrived in the fragment. */
export function consumeLoginCeremony(provided: string | null): boolean {
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return !!expected && !!provided && expected === provided;
}
