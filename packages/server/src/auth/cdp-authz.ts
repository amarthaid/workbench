import { getWarmCdpEndpoint } from "./browser-session";

export interface CdpAttachRequest {
  sessionId?: string;
  cdpToken?: string;
}

// Resolve the page-WS endpoint an authenticated live-view client may attach
// to, or null if the attach request is not authorized. `portalUserId` is the
// userId proven by the portal session bearer (or null if none).
//
// A portal session is the only credential accepted here. Connect links used to
// authorize this attach, which made a leaked link a live handle on someone
// else's browser; the /connect and /browser pages now require a session, so
// nothing needs that path any more.
export async function authorizeCdpAttach(
  req: CdpAttachRequest,
  portalUserId: string | null
): Promise<string | null> {
  if (!portalUserId || portalUserId !== req.sessionId) return null;
  return getWarmCdpEndpoint(portalUserId, req.cdpToken ?? "");
}
