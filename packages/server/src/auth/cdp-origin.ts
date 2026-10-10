/**
 * The only Origin chromium accepts on a DevTools WebSocket
 * (`--remote-allow-origins`), and the one every server-side CDP client sends.
 * An `.invalid` host can never serve a page, so no page or worker in any
 * user's chromium can carry this origin and open a DevTools socket, whatever
 * it learns about a debug port. (`http://127.0.0.1`, the old value, is the
 * origin of any page served from loopback port 80.)
 */
export const CDP_ORIGIN = "http://workbench-cdp.invalid";
